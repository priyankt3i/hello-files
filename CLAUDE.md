# CLAUDE.md

Guidance for Claude Code in this repo. Last updated 2026-10-15, after the fix and redesign pass. Where README.md and the code disagree, **this file describes the code**.

## What this is

Hello Files ("fschat" internally) is a Windows-first Electron desktop app. You pick a local folder (a "knowledge base"; called a "channel" in code), the app indexes it, and you chat against its contents with citations. It is still a prototype: there's no code signing, no auto-update and no TS test suite.

## Layout

- `apps/desktop/src/main/`: Electron main process.
  - `services/app-service.ts`: orchestration (channels, indexing, chat, retrieval, secrets, data policy, auto-sync).
  - `services/folder-watcher.ts`: debounced recursive `fs.watch` that triggers incremental syncs.
  - `services/python-worker.ts`: child-process bridge. Every call takes an `IndexTarget {rootPath, indexPath}`.
  - `providers/client.ts`: OpenAI, Azure, Anthropic, Gemini, Ollama.
  - `providers/codex-client.ts`: Codex OAuth.
  - `db/database.ts`: SQLite.
  - `services/{retrieval,spreadsheet,channel}-helpers.ts`: retrieval heuristics.
- `apps/desktop/src/preload/index.ts`: the `window.fsChat` API. Its renderer typing in `renderer/types/global.d.ts` is hand-written, so keep the two in sync.
- `apps/desktop/src/renderer/`: React 19 + Tailwind + lucide-react.
  - `app.tsx`: shell.
  - `state/`: `store.tsx` holds state and event subscriptions; `core-actions.ts` and `admin-actions.ts` hold the actions; `toasts.tsx`.
  - `lib/`: markdown (escaping renderer), `providers.ts` (data-destination and local-only logic), formatters, theme.
  - `components/`: sidebar, kb-header, chat/, files/, kb-settings/, app-settings/, new-kb-dialog, and the primitives in ui/.
- `packages/shared/src/contracts.ts`: shared types and IPC contracts. It is resolved from source by path alias, not from `dist/`.
- `services/indexer/fschat_indexer/`: Python worker.
  - `worker.py`: protocol, discovery, incremental build, BM25 and vector search.
  - `extractors.py`: parsers and OCR.
  - `embeddings.py`: HTTP embeddings with timeouts and retries.
  - `index_store.py`, `vector_store.py`: the on-disk index.
  - Tests are in `services/indexer/tests/`.
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

## Environment flags

- `HELLO_FILES_ENABLE_CODEX=1` shows the OpenAI Codex sign-in. It is hidden by default because it reuses the Codex CLI client ID, sends `originator: "cline"` and routes content through personal ChatGPT accounts, which is a compliance risk. Its tokens are stored as plaintext JSON in `~/.hello-files/codex_oauth_credentials.json` with mode 0600, which is not enforced on Windows.
- `FSCHAT_PYTHON_BIN` and `FSCHAT_INDEXER_BIN` override the worker interpreter or binary.

## How it works

**Index location.** Indexes live in `userData/indexes/<channelId>/`, with `.tmp` and `.old` siblings during a commit. They no longer go inside the user's folder.
- On bootstrap, `migrateLegacyIndexLocations()` moves any old `<root>/.fschat-index` there. If the move fails, for example because the drive is offline, the channel keeps the legacy path and the move is retried on the next bootstrap.
- Deleting a channel always removes its index copy and never touches source files.
- "Reset app data" also deletes `userData/indexes`.

**Electron ↔ Python.** Newline-delimited JSON over stdin and stdout. Requests carry `rootPath` plus `indexPath`; if `indexPath` is missing, Python falls back to `<root>/.fschat-index`. Python stderr is only logged (`console.warn`) and is not shown in the UI.

**Discovery (Python).**
- Uses `os.walk(followlinks=False)`.
- Skips, at any depth: `.git`, `.svn`, `.hg`, `node_modules`, `__pycache__`, `.venv`, `venv`, `.idea`, `.vs` and the index folders.
- Also skips dot-files, files with the Windows hidden or system attribute, `~$*` lock files, `Thumbs.db` and `desktop.ini`.
- Symlinked folders are never followed. Symlinked files are indexed only when their target is inside the root.
- Per-channel `excludePatterns` are gitignore-style globs; a pattern without `/` matches at any depth.
- Files over `maxFileSizeMb`, 50 by default (`DEFAULT_MAX_FILE_SIZE_MB`), get status `skipped`.

**Builds.**
- `build_index` (the "Sync now" button and auto-sync) always rescans.
  - It reuses files whose size and mtime, or else sha256, are unchanged, together with their chunks and their vectors. Vectors are reused only when `embeddingModelKey` matches.
  - It returns `stats {added, updated, removed, unchanged, failed, skipped}`.
  - If nothing changed, the index isn't rewritten.
- `rebuild_index` is a full rebuild from scratch.
- Cancelling with retain-partial keeps the files already processed plus previous entries for the unprocessed files that are unchanged on disk.
- An embedding failure aborts the build and keeps the previous index.
- Embedding HTTP calls time out after 60s (30s for queries) and retry twice on network errors, 408, 429 and 5xx.

**Auto-sync.** `FolderWatcher` debounces events for 4s and then calls `syncChannel()`.
- It runs only for channels that have `autoSync` on, have been indexed at least once, have models allowed by the data policy, and whose folder exists.
- Background syncs **don't** set status `indexing`, so chat keeps working on the previous index. They still emit progress events.
- A failed background sync keeps the status and sets `lastError`; the header shows a warning.
- Changes that arrive during a build are queued in `pendingResync`.
- An initial sync runs on the first bootstrap to catch changes made while the app was closed.

**Data policy.** `app_settings.dataPolicy` is `"any"` or `"local-only"`.
- Local-only allows only Ollama on localhost, 127.0.0.1 or ::1 (`isLocalConnection`). The main process and `renderer/lib/providers.ts` keep the same rule.
- It is enforced in `resolveModelSelection()` for chat, embeddings and indexing, and in `connectProvider()`.
- `reconcileChannelIndexState()` reads models with `enforcePolicy: false`, so bootstrap never fails because of the policy.
- The UI shows a per-knowledge-base "data destination" badge.

**What leaves the machine** (when not using local Ollama):
- **Chat call:** the system prompt, the last 6 messages, and retrieved chunks of up to 1,500 characters each (vector top 6, keyword top 8, up to 24 spreadsheet rows), plus up to 3 base64 images when the model is guessed to be vision-capable.
- **Keyword ("vectorless") mode:** also one extra chat call that picks documents from up to 24 summaries.
- **Semantic ("vector") mode:** all chunk text goes to the embedding provider at index time, and the query at search time.

**Retrieval.**
- Vector: brute-force numpy cosine. A mismatched embedding model raises "rebuild required".
- Keyword: BM25 (k1 = 1.5, b = 0.75) with a path bonus and a visual bonus, cached per index path and chunk-file mtime. The TS side lexically pre-ranks the manifest and asks the model to choose documents first.
- Spreadsheet "how many rows" is answered without the LLM **only** for unfiltered questions (`isPlainRowCountQuery`). Filtered counts go to the model.

**Chat persistence.** `sendMessage` calls the model first and writes the thread and both messages only when the call succeeds. On failure the UI keeps the turn as "Not sent", with Retry, Edit and Discard.

**Providers.**
- Chat and embedding models may come from different connections.
- Azure OpenAI has no model discovery; the user enters an https endpoint, an API key, chat and/or embedding deployment names, and an API version (default `2024-10-21`).
- Connections can be removed one at a time (`deleteProviderConnection`). Removing one clears the channels' model references and deletes the stored keytar secret.

**SQLite** (`userData/fschat.sqlite`, WAL).
- The `channels` table gained `auto_sync`, `exclude_patterns_json`, `last_index_stats_json` and `last_error`.
- File statuses are `indexed`, `failed` and `skipped`.
- `provider_profiles`, the `*_profile_id` columns, and every `app_settings` key except `dataPolicy` are legacy.

## Known gaps

- Vision capability is guessed by regex on the model name, and every Codex model is treated as vision-capable.
- Visual asset anchors that fall across a chunk boundary are lost.
- `keytar` was archived upstream; Electron `safeStorage` is the likely replacement.
- No TS unit tests, though `folder-watcher.ts` `globToRegExp`/`shouldIgnore` and `isPlainRowCountQuery` are good first targets. No end-to-end tests.
- `ipcMain` handlers don't validate the sender.
- The sidebar lists chats only for the selected knowledge base, because no API lists threads without loading a channel.
- "Show in folder" for the knowledge base itself calls `revealChannelFile` with `"."`.
- A custom Ollama base URL can't be set from the UI.
- No code signing, MSI or auto-update.

## Conventions

- IPC changes touch four places together: `contracts.ts`, `preload/index.ts`, `renderer/types/global.d.ts` and `main/index.ts`.
- User-facing copy says "knowledge base", "Assistant instructions", "Keyword search" and "Semantic search". Keep "vector", "vectorless" and "channel" in code only.
- Renderer colours come from semantic tokens (`bg`, `surface`, `surface-2`, `border`, `text`, `text-muted`, `accent`, `success`, `warning`, `danger`) in `styles/index.css`. Don't hardcode colours.
- Python worker modules use flat imports (`from embeddings import ...`). Tests add the package directory to `sys.path` in `conftest.py`.
- Keep README.md user-facing and keep this file accurate to the code.
