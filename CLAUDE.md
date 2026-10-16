# CLAUDE.md

Guidance for Claude Code in this repo. Last updated 2026-10-15 after the fix, redesign, scale, rich-answers and spreadsheet-math passes. Where README.md and the code disagree, **this file describes the code**.

## What this is

Hello Files ("fschat" internally) is a Windows-first Electron desktop app. You pick a local folder (a "knowledge base"; called a "channel" in code), the app indexes it, and you chat against its contents with citations. It is still a prototype: there's no code signing, no auto-update and no TS test suite.

## Layout

- `apps/desktop/src/main/`: Electron main process.
  - `services/app-service.ts`: orchestration (channels, indexing, chat, retrieval, secrets, data policy, auto-sync, exact spreadsheet calculation).
  - `services/folder-watcher.ts`: debounced recursive `fs.watch` that triggers incremental syncs.
  - `services/python-worker.ts`: child-process bridge. Every call takes an `IndexTarget {rootPath, indexPath}`.
  - `services/spreadsheet-sql.ts`: intent detection, SQL-generation prompts, reply parsing and result formatting (pure functions).
  - `providers/client.ts`: OpenAI, Azure, Anthropic, Gemini, Ollama, and `ANSWER_FORMAT_GUIDE` (the table/Mermaid/chart formatting instructions appended to every answer's system prompt).
  - `providers/codex-client.ts`: Codex OAuth.
  - `db/database.ts`: SQLite.
- `apps/desktop/src/preload/index.ts`: the `window.fsChat` API. Its renderer typing in `renderer/types/global.d.ts` is hand-written, so keep the two in sync.
- `apps/desktop/src/renderer/`: React 19 + Tailwind + lucide-react.
  - `app.tsx`: shell. `main.tsx` shows a "must run in the desktop window" message if `window.fsChat` is missing.
  - `state/`: `store.tsx` (state and event subscriptions), `core-actions.ts`, `admin-actions.ts`, `toasts.tsx`.
  - `lib/`: `providers.ts` (data-destination and local-only logic), `mermaid-render.ts`, `chart-spec.ts`/`chart-option.ts` (chart validation and ECharts mapping), `table-export.ts`, formatters, theme.
  - `components/`: sidebar, kb-header, chat/, files/, kb-settings/, app-settings/, new-kb-dialog, `rich/` (Markdown, tables, Mermaid, charts, diagram viewer), and the primitives in ui/.
- `packages/shared/src/contracts.ts`: shared types and IPC contracts. It is resolved from source by path alias, not from `dist/`.
- `services/indexer/fschat_indexer/`: Python worker.
  - `worker.py`: protocol, discovery, incremental build, parallel extraction, search.
  - `index_store.py`, `vector_store.py`: the SQLite-backed index.
  - `extractors.py`: parsers and OCR (heavy libraries are imported lazily).
  - `embeddings.py`: HTTP embeddings with timeouts and retries.
  - `spreadsheet_sql.py`: exact spreadsheet calculation.
  - Tests are in `services/indexer/tests/`; a benchmark is in `services/indexer/bench/`.
- Root notes such as `addCodex.md`, `vectorlessRAG.md`, `docs/move2vectorless.md` and `CODEBASE_REVIEW_AND_LIBRARY_RECOMMENDATIONS.md` are historical design notes.
  - `codex-oauth.mjs` is an unused leftover from another project.
  - `docs/stakeholder-findings.md` is the build-vs-adopt write-up.

## Commands

```bash
npm install && pip install -r services/indexer/requirements.txt -r services/indexer/requirements-dev.txt
npm run dev                  # Electron dev; system python unless FSCHAT_PYTHON_BIN / FSCHAT_INDEXER_BIN set
npm run typecheck            # shared + desktop
npm run python:check         # compileall
npm run python:test          # pytest services/indexer/tests
npm run build -w @fschat/desktop
npm run dist                 # electron-builder + PyInstaller indexer, unsigned
npm run rebuild:native -w @fschat/desktop   # better-sqlite3/keytar ABI mismatch
```

CI (`.github/workflows/desktop-packages.yml`) has two jobs:
- A `check` job on pull requests and pushes: typecheck, compileall, pytest and the app build.
- Packaging, which runs only after `check` passes and not on pull requests.

`package-lock.json` is committed and must stay committed, because CI uses `npm ci`.

If `npm install` fails while rebuilding `better-sqlite3`, install with `--ignore-scripts` and run `npm run rebuild:native -w @fschat/desktop` afterwards. If `npm run dev` reports that Electron is missing, run `node node_modules/electron/install.js` (the binary download may not have finished). The dev script looks for Electron in both `apps/desktop/node_modules` and the hoisted root `node_modules`.

## Environment flags

- `HELLO_FILES_ENABLE_CODEX=1` shows the OpenAI Codex sign-in. It is hidden by default because it reuses the Codex CLI client ID, sends `originator: "cline"` and routes content through personal ChatGPT accounts, which is a compliance risk. Its tokens are stored as plaintext JSON in `~/.hello-files/codex_oauth_credentials.json` with mode 0600, which is not enforced on Windows.
- `FSCHAT_PYTHON_BIN` and `FSCHAT_INDEXER_BIN` override the worker interpreter or binary.

## How it works

**Index storage.** Each knowledge base has one SQLite database, `userData/indexes/<channelId>/index.sqlite` (WAL, index format version 4), plus a tiny `manifest.json` marker. It is never inside the user's folder.
- Tables: `meta` (including a `dataVersion` token that changes on every commit), `files`, `documents`, `chunks`, `chunks_fts` (FTS5, kept in sync by triggers) and `vectors` (int8 plus a per-vector scale).
- Older JSON indexes (v2/v3) are converted the first time they are opened, keeping chunk IDs and vectors, so nothing is re-extracted or re-embedded.
- `migrateLegacyIndexLocations()` moves an old `<root>/.fschat-index` into app data on bootstrap. If the move fails, for example because the drive is offline, the channel keeps the legacy path and the move is retried on the next bootstrap.
- Deleting a channel always removes its index copy and never touches source files. "Reset app data" also deletes `userData/indexes`.
- `.tmp` and `.old` siblings exist only during a full rebuild's directory swap; a crash between the renames is repaired on the next build.

**Electron ↔ Python.** Newline-delimited JSON over stdin and stdout. Requests carry `rootPath` plus `indexPath`; if `indexPath` is missing, Python falls back to `<root>/.fschat-index`. Python stderr is only logged (`console.warn`) and is not shown in the UI. Methods: `get_index_status`, `build_index`, `rebuild_index`, `cancel_build`, `list_files`, `list_documents`, `resolve_visual_assets`, `search`, `spreadsheet_schema`, `spreadsheet_query`.

**Discovery (Python).**
- Uses `os.walk(followlinks=False)`.
- Skips, at any depth: `.git`, `.svn`, `.hg`, `node_modules`, `__pycache__`, `.venv`, `venv`, `.idea`, `.vs` and the index folders.
- Also skips dot-files, files with the Windows hidden or system attribute, `~$*` lock files, `Thumbs.db` and `desktop.ini`.
- Symlinked folders are never followed. Symlinked files are indexed only when their target is inside the root.
- Per-channel `excludePatterns` are gitignore-style globs; a pattern without `/` matches at any depth.
- `!pattern` entries are include filters (`!*.pdf` for a file type, `!*FR*` for a name). They form a union: with any present, a file is kept when it matches a chosen type **or** a chosen name; exclude rules still win. The Python worker and `folder-watcher.ts` (`shouldIgnore`) must agree on this.
- Files over `maxFileSizeMb`, 50 by default (`DEFAULT_MAX_FILE_SIZE_MB`), get status `skipped`.
- Files left out by the user's rules (exclude globs, `!` include filters, anything under an excluded folder) are also stored as `skipped`, with `errorReason` such as "Excluded by rule: *.log", so the Files tab lists them (capped at `MAX_RULE_SKIPPED_FILES`, 10,000). The built-in skips above are never listed. The header shows `indexed / (indexed + failed + skipped) files`.

**Builds.**
- `build_index` (the "Sync now" button and auto-sync) always rescans. Per-file updates run in one SQLite transaction, so a sync costs time proportional to what changed.
  - It reuses files whose size and mtime, or else sha256, are unchanged, together with their chunks and their vectors. Vectors are reused only when `embeddingModelKey` matches.
  - It returns `stats {added, updated, removed, unchanged, failed, skipped}`.
  - If nothing changed, nothing is written.
  - Progress (`totalFiles`/`processedFiles`/done/failed) counts only files that need extraction, not unchanged or skipped ones. Changing filters excludes files by deleting their chunks (no re-reading); only newly included files are extracted.
  - Any running build can be stopped from the header's Stop button or the Files tab, including background syncs (`StopIndexingDialog`).
- `rebuild_index` is a full rebuild from scratch into `.tmp`, then a directory swap.
- Extraction runs in a spawn-based process pool (`min(4, cpus-1)`, override with `maxWorkers`), used only when the estimated work is large enough. Workers' stdin/stdout are redirected before spawning, because on Windows they otherwise inherit the protocol pipe; a regression test covers this. The frozen app uses a higher threshold than dev because workers take about 5 s to spawn there.
- Cancelling with retain-partial keeps the files already processed plus previous entries for the unprocessed files that are unchanged on disk.
- An embedding failure aborts the build and keeps the previous index. Embedding HTTP calls time out after 60s (30s for queries) and retry twice on network errors, 408, 429 and 5xx.
- Benchmark on this laptop (3,000 files, 17k chunks): first build 3.8 s, no-change sync 0.17 s, keyword query about 32 ms.

**Auto-sync.** `FolderWatcher` debounces events for 4s and then calls `syncChannel()`.
- It runs only for channels that have `autoSync` on, have been indexed at least once, have models allowed by the data policy, and whose folder exists.
- Background syncs **don't** set status `indexing`, so chat keeps working on the previous index. They still emit progress events.
- A failed background sync keeps the status and sets `lastError`; the header shows a warning.
- Changes that arrive during a build are queued in `pendingResync`.
- An initial sync runs on the first bootstrap to catch changes made while the app was closed.

**Data policy.** `app_settings.dataPolicy` is `"any"` or `"local-only"`.
- Local-only allows only Ollama on localhost, 127.0.0.1 or ::1 (`isLocalConnection`/`isLocalUrl`). The main process and `renderer/lib/providers.ts` keep the same rule. A remote Ollama server counts as external.
- It is enforced in `resolveModelSelection()` for chat, embeddings and indexing, and in `connectProvider()`.
- `reconcileChannelIndexState()` reads models with `enforcePolicy: false`, so bootstrap never fails because of the policy.
- The UI shows a per-knowledge-base "data destination" badge.

**What leaves the machine** (when not using local Ollama):
- **Chat call:** the system prompt (plus the formatting guide), the last 6 messages, and retrieved chunks of up to 1,500 characters each (vector top 6, keyword top 8, up to 24 spreadsheet rows), plus up to 3 base64 images when the model is guessed to be vision-capable.
- **Keyword ("vectorless") mode:** also one extra chat call that picks documents from up to 24 summaries.
- **Semantic ("vector") mode:** all chunk text goes to the embedding provider at index time, and the query at search time.
- **Spreadsheet questions:** the SQL-generation call (and at most one repair call) sends the table and column names and types, 3 sample rows per sheet, up to 12 distinct values for low-cardinality text columns, and up to 2 earlier user questions to the chat provider. The exact result table (up to 50 rows) then goes to the answer call.

**Retrieval.**
- Vector: brute-force numpy cosine over int8 vectors cached per index and data version (top-10 overlap with float32 is at least 0.9). A mismatched embedding model raises "rebuild required".
- Keyword: FTS5 BM25 (inverted so higher is better) plus a path bonus and a visual bonus. User input is turned into quoted words joined by OR, so FTS syntax can't be injected. The TS side lexically pre-ranks the manifest and asks the model to choose documents first.

**Exact spreadsheet calculation.** For analytical spreadsheet questions (count, sum, average, min/max, top N, group by/breakdown, per/each, trend, chart, compare, percent; detected by `detectAnalyticalIntent`), `tryExactSpreadsheetCalculation` in `app-service.ts` runs this flow. It never throws; on any failure it falls back to the row-chunk behaviour.
1. `spreadsheet_schema` returns each sheet as a SQLite table (`claims_xlsx__claims`) with sanitised, typed columns; cells that can't be read as numbers or dates become NULL with the original in `<col>_raw`.
2. One chat-model call returns `{"sql": "SELECT ..."}` or `{"sql": null}`.
3. `spreadsheet_query` runs it in an in-memory SQLite database under an authorizer (SELECT only, whitelisted functions, loaded tables only), a single statement, a 5 s timeout, a 200-row default cap (1,000 hard max) and `PRAGMA query_only`. On error there is one repair call.
4. The answer call gets the exact result table and is told to use the numbers verbatim, name the sheets, and fill a chart's `source` with them.
- The message stores `calculation {sql, sheets}` (`messages.calculation_json`), shown as a collapsible "How this was calculated", and each sheet used gets a synthetic citation.
- `isPlainRowCountQuery` is a zero-LLM fast path for unfiltered counts such as "how many rows are in the claims sheet?". Filtered counts always go to the model.
- Sheets over 500,000 rows or 256 columns are refused. Rows above the detected header are excluded, so counts can differ slightly from the index's `rowCount`. A 50k-row workbook takes about 8 s to load cold, then about 0.1 s per query while the file is unchanged.

**Rich answers.** `rich/rich-markdown.tsx` renders answers with react-markdown + remark-gfm + rehype-sanitize. Raw HTML, images and non-http(s) links are dropped; links open through `openExternalUrl`.
- **Tables:** copy as CSV or Markdown, capped at 500 rows with "show all".
- **Mermaid:** the `mermaid` package in strict mode with `htmlLabels` off, sanitised with DOMPurify, loaded lazily. `fitViewBoxToContent()` re-measures the drawn bounds and rewrites the viewBox, because Mermaid's own measurement clipped the right and bottom edges of larger diagrams. Toolbar: Show source, Copy source, Expand, Save SVG, Save PNG.
- **Diagram viewer** (`rich/diagram-viewer.tsx`): a full-window overlay opened by Expand or by double-clicking the diagram. Wheel zooms toward the cursor, drag pans, and keys work from anywhere while it's open: `+`/`-` zoom, `0` fit, `W` fit width, `1` actual size, arrows pan, Esc closes. A diagram that would fit below 50% opens at a readable size, top-aligned, with a notice.
- **Charts:** a ```chart block holding JSON `{type: bar|stacked-bar|line|area|pie|scatter, title, x:{label,values}, series:[{name,values}], unit, source}`. It is strictly validated (known types only, matching lengths, numbers only, at most 5,000 points) and mapped to an ECharts option in code. Model JSON is never passed to ECharts directly. Toolbar: show data, copy CSV, save PNG/SVG.
- CSP stays `script-src 'self'` with no `unsafe-eval`; Mermaid's inline styles rely on the existing `style-src 'unsafe-inline'`.
- Not implemented: mailto links, raw ```echarts blocks, syntax highlighting, an expand view for charts.

**Chat persistence.** `sendMessage` calls the model first and writes the thread and both messages only when the call succeeds. On failure the UI keeps the turn as "Not sent", with Retry, Edit and Discard. Unsent composer drafts are kept per chat for the app session.

**Providers.**
- Chat and embedding models may come from different connections.
- Azure OpenAI has no model discovery; the user enters an https endpoint, an API key, chat and/or embedding deployment names, and an API version (default `2024-10-21`).
- Ollama accepts a custom server address; a non-local address is flagged in the UI and blocked in local-only mode.
- Connections can be removed one at a time (`deleteProviderConnection`). Removing one clears the channels' model references and deletes the stored keytar secret.

**Sidebar and bootstrap.** `bootstrap` returns every thread (so the sidebar lists chats for all knowledge bases) and the default assistant instructions (for "Reset to default"). "Open folder" uses `openChannelFolder`.

**SQLite app state** (`userData/fschat.sqlite`, WAL).
- The `channels` table has `auto_sync`, `exclude_patterns_json`, `last_index_stats_json` and `last_error`; `messages` has `calculation_json`.
- File statuses are `indexed`, `failed` and `skipped`.
- `provider_profiles`, the `*_profile_id` columns, and every `app_settings` key except `dataPolicy` are legacy.

## Known gaps

- Vision capability is guessed by regex on the model name, and every Codex model is treated as vision-capable.
- Visual asset anchors that fall across a chunk boundary are lost.
- `keytar` was archived upstream; Electron `safeStorage` is the likely replacement.
- No TS unit tests, though `folder-watcher.ts` (`globToRegExp`, `shouldIgnore`) and `spreadsheet-sql.ts` are good first targets. No end-to-end tests of the full Electron app with a real provider.
- `ipcMain` handlers don't validate the sender.
- The packaged indexer binary takes about 23 s to start cold (PyInstaller onefile); consider onedir. The frozen-app worker threshold has not been re-tested after the last change.
- Keyword ranking considers only the best 200 text matches before applying boosts.
- `sqlite-vec` was skipped (brute-force int8 queries in about 19 ms at 17k chunks). Revisit past roughly 300k chunks.
- A `file_update` event is still sent for every unchanged file during a sync.
- No code signing, MSI or auto-update.
- Local built-in embeddings (without Ollama) are planned but not started; see the notes on ONNX models in the project memory.

## Conventions

- IPC changes touch four places together: `contracts.ts`, `preload/index.ts`, `renderer/types/global.d.ts` and `main/index.ts`.
- User-facing copy says "knowledge base", "Assistant instructions", "Keyword search" and "Semantic search". Keep "vector", "vectorless" and "channel" in code only.
- Renderer colours come from semantic tokens (`bg`, `surface`, `surface-2`, `border`, `text`, `text-muted`, `accent`, `success`, `warning`, `danger`) in `styles/index.css`. Don't hardcode colours.
- Python worker modules use flat imports (`from embeddings import ...`). Tests add the package directory to `sys.path` in `conftest.py`. New worker modules must be added as `--hidden-import` in `scripts/build-indexer-binary.mjs`.
- When editing files with scripted find-and-replace, write regexes as raw strings: a non-raw `\b` silently becomes a backspace character. This broke `isPlainRowCountQuery` and a Mermaid helper once. `grep -rlP '\x08'` over the source should return nothing.
- Keep README.md user-facing and keep this file accurate to the code.
