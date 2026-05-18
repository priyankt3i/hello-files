# Technical Walkthrough

This walkthrough is intended for an AI engineering audience. It explains what Hello Files does, how the system is layered, and what happens during indexing and chat.

## Short Version

Hello Files is a local-first desktop RAG tool. A user creates a channel from a filesystem folder, the app indexes supported files into a hidden `.fschat-index/` directory beside the source content, and chat requests retrieve relevant indexed chunks before calling the selected chat model.

The core technical idea is separation of concerns:

- the Electron renderer owns the desktop experience
- the Electron main process owns app state, provider orchestration, and IPC
- the Python worker owns extraction, indexing, and retrieval
- shared TypeScript contracts keep payloads consistent across the app

## Suggested Walkthrough Agenda

1. Product problem and user workflow
2. Repository and runtime architecture
3. Channel, provider, and model data model
4. Index build pipeline
5. Retrieval and answer generation pipeline
6. Local storage, secrets, and index compatibility
7. Current limitations and next engineering steps

## Product Workflow

The product flow is:

1. Connect a model provider.
2. Create a channel from a local folder.
3. Pick chat and retrieval settings.
4. Start indexing.
5. Ask questions against the indexed folder.
6. Inspect citations and file-level indexing status.

A channel maps to one root folder. The source folder remains the source of truth; Hello Files stores only local app metadata and local index artifacts.

## Architecture

The current app has four main layers.

```text
React renderer
  |
  | window.fsChat preload API
  v
Electron main process
  |
  | JSON request/response over stdin/stdout
  v
Python indexing worker
  |
  v
.fschat-index/ beside the source folder
```

### Renderer

Location: `apps/desktop/src/renderer`

The renderer is the React UI. It handles channel selection, settings, indexing progress, file status lists, thread selection, chat messages, and citations.

Key file:

- `apps/desktop/src/renderer/app.tsx`

### Preload Bridge

Location: `apps/desktop/src/preload/index.ts`

The preload layer exposes a narrow `window.fsChat` API to the renderer. The renderer does not call Electron internals directly; it invokes named IPC methods such as `bootstrap`, `registerChannel`, `startIndex`, `sendMessage`, and `cancelIndex`.

### Electron Main Process

Location: `apps/desktop/src/main`

The main process owns:

- app lifecycle
- IPC handlers
- SQLite app state
- provider connections and model discovery
- secret lookup through `keytar`
- Python worker orchestration
- chat prompt assembly and provider calls

Important files:

- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/services/app-service.ts`
- `apps/desktop/src/main/services/python-worker.ts`
- `apps/desktop/src/main/db/database.ts`
- `apps/desktop/src/main/providers/client.ts`

### Python Worker

Location: `services/indexer/fschat_indexer`

The Python worker owns the indexing and retrieval engine:

- recursive file discovery
- document extraction
- text normalization
- chunking
- optional embedding generation
- local index writes
- vector or vectorless search

Important files:

- `services/indexer/fschat_indexer/worker.py`
- `services/indexer/fschat_indexer/extractors.py`
- `services/indexer/fschat_indexer/index_store.py`
- `services/indexer/fschat_indexer/vector_store.py`
- `services/indexer/fschat_indexer/embeddings.py`

### Shared Contracts

Location: `packages/shared/src/contracts.ts`

Shared contracts define the data shape for channels, files, messages, citations, index manifests, worker build options, and search results. This keeps the renderer, main process, and worker bridge aligned.

## Data Model

The main concepts are:

- `ProviderConnection`: a reusable provider account or endpoint
- `ProviderModel`: a discovered model with chat, embedding, and vision capabilities
- `Channel`: a folder-backed knowledge source
- `Thread`: a conversation inside a channel
- `Message`: user or assistant message, including citations on assistant messages
- `IndexedFileRecord`: per-file indexing outcome shown in the UI
- `IndexManifest`: on-disk metadata for the local index

SQLite stores app metadata under the Electron user data directory. The source folder stores index artifacts under `.fschat-index/`.

## Indexing Pipeline

Indexing starts in the renderer when the user creates a channel or clicks regenerate.

Runtime flow:

1. Renderer calls `window.fsChat.startIndex(channelId)`.
2. Preload invokes `fschat:start-index`.
3. Electron main routes the request to `DesktopAppService.runIndex`.
4. The service resolves the channel retrieval mode and model requirements.
5. `PythonWorkerBridge` sends a JSON request to the Python worker.
6. The worker scans files, extracts text, chunks content, writes index files, and emits progress.
7. Progress and file update events stream back to the renderer.
8. The main process updates SQLite with indexed and failed file records.

The worker discovers every regular file under the selected folder except `.fschat-index/` and `.fschat-index.tmp/`. Unsupported files are isolated as failed files rather than failing the whole indexing job.

## Supported Extraction

The worker has explicit extractors for:

- documents: `.pdf`, `.docx`, `.doc` best effort
- spreadsheets: `.xlsx`, `.xlsm`, `.xls`
- images and OCR: `.png`, `.jpg`, `.jpeg`, `.bmp`, `.gif`, `.tif`, `.tiff`, `.webp`
- text, code, and config files such as `.txt`, `.md`, `.csv`, `.json`, `.xml`, `.html`, `.yaml`, `.py`, `.js`, `.ts`, `.tsx`, `.css`, `.sql`, `.ps1`, `.java`, `.cs`, `.go`, `.rs`, and related extensions

Unknown extensions may still index if Python identifies them as text or image MIME types, or if byte sniffing says the file looks like plain text.

## Index Storage

Each indexed folder gets a hidden `.fschat-index/` directory. Current index files include:

- `manifest.json`: version, root path, retrieval mode, file list, counts, timestamps, and vector metadata when applicable
- `documents.json`: file-level document summaries and structure hints
- `chunk_metadata.jsonl`: chunk text, source path, hash, snippets, and optional spreadsheet row metadata
- `vectors.npy`: normalized embedding matrix for vector indexes only

The app writes to `.fschat-index.tmp/` first and then commits the temp folder into `.fschat-index/`. That keeps completed indexes separate from in-progress writes.

## Incremental Rebuilds

Regenerate is incremental where possible.

The worker attempts to reuse prior work by:

- comparing file size and modification time
- hashing file contents when needed
- reusing prior chunk metadata for unchanged files
- reusing prior embeddings when chunk hashes match in vector mode

Changed files are re-extracted and re-indexed. Failed files are tracked independently.

## Retrieval Modes

The code supports two retrieval modes.

### Vector Mode

Vector mode is the traditional embedding-backed RAG path.

Index time:

1. Extract and normalize text.
2. Split into chunks.
3. Generate embeddings for chunks.
4. Normalize and store vectors in `vectors.npy`.
5. Store chunk metadata in `chunk_metadata.jsonl`.

Query time:

1. Embed the user query.
2. Load normalized chunk vectors.
3. Run cosine similarity.
4. Return top chunks as `SearchResult` records.
5. Generate the answer from retrieved chunks and recent thread history.

Vector channels require an embedding-capable model.

### Vectorless Mode

Vectorless mode avoids embeddings for indexing and query retrieval.

Index time:

1. Extract and normalize text.
2. Split into chunks.
3. Store document summaries and chunk metadata.
4. No chunk embeddings are generated.

Query time:

1. The main process preselects candidate documents from the manifest.
2. It can ask the selected chat model to choose the most relevant document IDs.
3. The worker runs lexical scoring over chunk text and relative paths.
4. Spreadsheet-heavy questions get extra structure-aware handling.
5. Results keep the same `SearchResult` shape as vector mode.

Vectorless channels require a chat model but do not require an embedding model. This is why chat-only providers can participate in vectorless channels.

## Chat Pipeline

When the user sends a message:

1. `sendMessage` validates that the channel is indexed.
2. The main process resolves the selected chat model.
3. The app retrieves relevant chunks using vector or vectorless search.
4. It creates or reuses a thread.
5. The user message is stored in SQLite.
6. The main process builds a provider prompt with:
   - retrieved indexed context
   - optional context notes
   - recent thread history
   - channel system prompt
   - current user question
7. The selected provider returns the assistant text.
8. The assistant message is stored with citations derived from retrieved chunks.
9. The renderer displays the answer and citation rail.

The answer generation path is intentionally separate from the retrieval path. Both vector and vectorless retrieval return the same search result contract.

## Provider Layer

The provider system models accounts as reusable connections, then stores discovered models under those connections.

Supported provider adapters include:

- OpenAI
- Azure OpenAI
- Anthropic
- Google Gemini
- Ollama
- OpenAI Codex path used by the app as chat-only/vectorless

Provider discovery records whether each model supports chat, embeddings, and vision. Credentials are not stored in SQLite; the app stores a secret reference and retrieves the actual secret through `keytar` where applicable.

## Worker Protocol

The Electron main process talks to the Python worker over stdin/stdout using JSON envelopes.

Request examples:

- `get_index_status`
- `build_index`
- `rebuild_index`
- `cancel_build`
- `list_files`
- `list_documents`
- `search`

Event examples:

- `progress`
- `file_update`

This keeps the Python indexer isolated from Electron while still allowing progress to stream to the UI.

## Demo Flow For The Team

Use this order for a clean live walkthrough:

1. Show the three-pane UI: channels, files/index status, chat.
2. Open settings and explain provider connections plus model capability discovery.
3. Create or select a channel backed by a local folder.
4. Start indexing and point out progress phases and per-file status updates.
5. Open the folder and show `.fschat-index/`.
6. Show `manifest.json`, `documents.json`, and `chunk_metadata.jsonl`.
7. Ask a question that should cite a known file.
8. Show the answer, citation rail, scores, snippets, and source paths.
9. Explain how the same UI works across vector and vectorless retrieval because the search result contract is stable.

## Engineering Talking Points

Good points to emphasize:

- The app is local-first: source files stay on disk, index files stay beside the source folder, and app metadata is separate.
- Indexing failures are isolated per file so one bad document does not break the whole channel.
- The worker protocol is simple JSON, which keeps the Electron/Python boundary debuggable.
- Retrieval mode is explicit in channel state and index manifests.
- The system already separates extraction, retrieval, and answer generation.
- Vectorless mode reduces dependence on embedding-capable providers and can support chat-only providers.
- The citation contract is stable across retrieval strategies.

## Current Limitations

Current limits worth being transparent about:

- Windows is the primary supported environment.
- Large folders and OCR-heavy documents can still be slow.
- Legacy `.doc` extraction is best effort.
- Azure OpenAI model discovery still needs deployment-specific setup.
- Vectorless retrieval is currently lexical/manifest-first, not a full SQLite FTS or BM25 implementation.
- Long-running indexing still needs stronger checkpoint/resume behavior.
- Automated test coverage needs to be broader before treating the app as production-stable.

## Likely Questions

### Why Electron plus Python?

Electron gives the desktop shell, local filesystem UX, IPC, and credential integration. Python keeps document extraction, OCR, embeddings, and indexing close to the ecosystem where those libraries are strongest.

### Where is user content stored?

Source content stays in the selected folder. The local index is stored in `.fschat-index/` inside that folder. App metadata such as channels, threads, messages, and file statuses is stored in SQLite under the Electron user data directory.

### What leaves the machine?

The app sends retrieved text snippets and recent conversation context to the selected chat provider when answering. Vector mode also sends chunks and queries to the selected embedding provider. Ollama can keep provider calls local when configured locally.

### How are citations generated?

Citations are not invented by the model. They are attached from retrieved `SearchResult` records. Each result carries `relativePath`, `chunkId`, `score`, and `snippet`, and those fields become assistant message citations.

### What makes vectorless different?

Vectorless mode removes embedding generation and vector search. It indexes text and metadata, then retrieves with manifest-aware document selection plus lexical chunk scoring. The UI and citation shape remain the same.

### What is the next high-value engineering improvement?

For retrieval quality and performance, the strongest next step is a real lexical catalog, likely SQLite FTS5 or BM25-style ranking, while preserving the current `SearchResult` contract.

The clean answer is:

Vectorless retrieval in our app is **manifest-first lexical RAG**. It does not use embeddings, so “trust” comes from traceability, constrained retrieval, deterministic chunk scoring, and citations tied directly to indexed chunks.

How it works:

1. During indexing, the Python worker still does the same extraction pipeline: discover files, extract text, normalize it, split it into chunks, and store metadata under `.fschat-index/`.
2. In vectorless mode, it skips embedding generation and does not require `vectors.npy`.
3. It writes document-level summaries to `documents.json` and chunk-level records to `chunk_metadata.jsonl`.
4. At chat time, the main process first reads the document manifest and preselects likely relevant documents.
5. It may ask the selected chat model to choose the smallest useful document set from that manifest.
6. The Python worker then scores chunks lexically by matching query tokens against chunk text and file paths.
7. The top chunks are returned as normal `SearchResult` records.
8. The assistant response is generated only after those retrieved chunks are inserted into the prompt.
9. Citations are attached from the retrieved chunks, not invented by the model.

Important code paths:

- Vectorless chat routing: [app-service.ts](./apps/desktop/src/main/services/app-service.ts:671)
- Vectorless worker search: [worker.py](./services/indexer/fschat_indexer/worker.py:541)
- Shared retrieval contract: [contracts.ts](./packages/shared/src/contracts.ts:7)
- Index files and manifest handling: [index_store.py](./services/indexer/fschat_indexer/index_store.py:11)

How we can trust it:

- **Traceability:** every answer citation maps back to a specific `relativePath`, `chunkId`, score, and snippet from the local index.
- **No hidden semantic leap:** retrieval is lexical and path-based, so it is easier to inspect than embedding similarity.
- **Stable contract:** vector and vectorless retrieval return the same `SearchResult` shape, so citations and UI behavior stay consistent.
- **Failure visibility:** files that cannot be extracted are recorded as failed files, not silently ignored.
- **Local reproducibility:** the index lives in `.fschat-index/`, so we can inspect `manifest.json`, `documents.json`, and `chunk_metadata.jsonl`.
- **Explicit limitation:** it is better at exact terms, filenames, headings, spreadsheet rows, and known wording than at paraphrases or synonym-heavy questions.

The honest caveat: vectorless retrieval is currently trustworthy because it is inspectable and citation-backed, not because it guarantees semantic recall. The next quality step would be a stronger lexical engine like SQLite FTS5 or BM25-style ranking, plus an evaluation set comparing expected citations against returned citations.