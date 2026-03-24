# Move To Vectorless RAG

## Purpose

This document reviews the current Filesystem RAG Chat system and defines a migration strategy for moving from embedding-backed vector retrieval to vectorless RAG while preserving the existing desktop UX, channel workflow, and citation behavior.

## Scope And Assumption

This plan assumes "vectorless RAG" means:

- no embedding generation during indexing
- no vector storage in the local channel index
- no query embedding at chat time
- retrieval driven by lexical, structural, and metadata search
- optional reranking after retrieval using rules or an LLM, but not a vector index

If the team means a different variant of vectorless RAG, such as graph retrieval or pure LLM-scored brute-force retrieval, adjust the retrieval engine section before implementation starts.

## Executive Summary

The current product is already well-positioned for this migration because:

- extraction, normalization, chunking, channel management, threads, and citations are already separated from the retrieval algorithm
- the UI does not render vectors directly; it renders channel state, file state, chat messages, and citations
- the main process already centralizes provider selection and worker orchestration

The main migration work is in the Python worker and shared contracts, not in the UI shell.

The safest path is:

1. keep the current renderer layout and message/citation contract
2. introduce a retrieval mode in shared contracts and manifests
3. implement a new vectorless index format beside the current vector format
4. migrate channel-by-channel through regenerate instead of attempting an in-place rewrite
5. remove embedding as a required concept from channel creation only after vectorless search quality is validated

## Current System Review

### Product Shape

The application is a Windows-first Electron desktop app for chatting with local folder content. A channel maps to a filesystem root. The app indexes supported files into a hidden `.fschat-index/` folder inside that root and stores app state in SQLite under the Electron user data directory.

### Current Architecture

The current architecture has four layers.

1. Renderer
   - React UI in `apps/desktop/src/renderer`
   - Manages channel selection, file lists, thread selection, chat composer, provider settings, and progress updates
2. Preload and IPC bridge
   - `apps/desktop/src/preload/index.ts`
   - Exposes a narrow `window.fsChat` API to the renderer
3. Electron main process
   - `apps/desktop/src/main`
   - Owns SQLite app state, provider discovery, secret access through `keytar`, and Python worker calls
4. Python worker
   - `services/indexer/fschat_indexer`
   - Owns discovery, extraction, chunking, embeddings, vector storage, and similarity search

### Current Runtime Data Flow

1. The renderer calls `window.fsChat.*`.
2. IPC routes to `DesktopAppService`.
3. `DesktopAppService` reads or writes SQLite state and invokes the Python worker.
4. The worker builds or searches the local index in `.fschat-index/`.
5. Progress and file update events stream back to the renderer.
6. Chat replies are generated in the main process using retrieved chunks plus recent thread history.

## Current UI And Design

### Layout

The current UI is a three-pane desktop layout.

- Left pane: channel list and global actions
- Middle pane: channel metadata, model choices, progress, indexed files, failed files
- Right pane: chat threads, message transcript, composer, citations rail

### Visual Design

The current look and feel is intentional and should remain stable.

- dark shell gradient background
- glass-panel cards with blur and soft borders
- warm accent palette using `ember`, `coral`, and `moss`
- serif display font for titles and Segoe UI body text
- rounded cards, pill buttons, and toast-style confirmations

Key design tokens live in `apps/desktop/tailwind.config.cjs` and `apps/desktop/src/renderer/styles/index.css`.

### Current UI Surfaces

1. Sidebar
   - create channel
   - open settings
   - list channels with status pills
2. Files panel
   - current provider, chat model, embedding model
   - index progress card
   - regenerate, cancel indexing, delete channel
   - filter indexed files
   - indexed and failed file lists
3. Chat panel
   - thread chips
   - markdown-rendered assistant output
   - freeform text composer
   - citations panel showing file path, score, and snippet
4. Settings modal
   - provider connection setup
   - model discovery and refresh
   - provider-level default chat and embedding models
   - reset app data
5. Toasts and errors
   - cancel indexing retain/discard partial index
   - delete channel confirmation
   - dismissible error toast

## Current Feature Inventory

### Folder And Channel Features

- create a channel from a local folder
- inspect whether a folder already contains a compatible `.fschat-index/`
- auto-start indexing after channel creation when needed
- keep multiple channels
- delete a channel without deleting the source folder or `.fschat-index/`

### Provider And Model Features

- reusable provider connections
- provider model discovery for OpenAI, Anthropic, Google Gemini, and Ollama
- manual limitation for Azure OpenAI discovery
- saved provider defaults
- per-channel model override
- validation that chat and embedding models come from the same connection
- `keytar` storage for secrets

### Indexing Features

- recursive file discovery excluding `.fschat-index/` and temp index folders
- text extraction across text, code, PDF, DOCX, DOC, spreadsheets, CSV, and common image formats
- OCR for images and image-heavy documents
- text normalization
- chunking with overlap
- incremental rebuild behavior using stat reuse and content-hash reuse
- progress events and per-file updates
- cancellation with retain-partial or discard-partial behavior
- failed file tracking

### Chat Features

- per-channel threads
- stored message history
- retrieval-backed prompting with recent history
- source citations attached to assistant responses
- inline markdown rendering in the assistant transcript

## Current Vector-Based RAG Design

### Index Format Today

The current `.fschat-index/` contains:

- `manifest.json`
- `chunk_metadata.jsonl`
- `vectors.npy`

The manifest stores version, file list, chunk count, embedding dimension, and an `embeddingModelKey`.

### Current Index Build Pipeline

1. Discover files.
2. Extract text from each file.
3. Normalize text.
4. Split text into overlapping chunks.
5. Generate embeddings for new chunks.
6. Reuse prior vectors when chunk hashes match.
7. Write normalized vectors and chunk metadata.
8. Commit the temp store into `.fschat-index/`.

### Current Query Pipeline

1. Validate the channel and selected models.
2. Embed the user query with the selected embedding model.
3. Load `vectors.npy`.
4. Run cosine similarity against normalized chunk vectors.
5. Return top chunks.
6. Build a prompt with the retrieved text plus recent chat history.
7. Send that prompt to the selected chat model.

## Current Constraints That Matter For Migration

### Tight Coupling To Embeddings

The current system requires embeddings in several places.

- channel creation expects an embedding-capable model
- channel update logic invalidates the index when the embedding model changes
- search requires an `embeddingProvider`
- manifest compatibility is keyed to the embedding model identity
- indexing progress has an explicit `embedding` phase
- cancellation copy refers to embedded files

### Provider Limitation Side Effects

Anthropic is chat-only in the current app. That means a channel cannot use Anthropic alone today, even if Anthropic would be acceptable for answer generation, because the current retrieval path still requires an embedding model.

Vectorless retrieval removes that structural limitation.

### Operational Gaps

- no first-party test suite in this repo for the core flows
- OCR-heavy files may introduce noisy text into retrieval
- large folders can still be expensive to index
- the current worker is single-process for builds and a single active build executor

## Target State

### Goal

Keep the same product experience while swapping the retrieval engine from vector similarity to vectorless retrieval.

### What Must Stay The Same

- the three-pane desktop layout
- channel, thread, and message concepts
- citation side rail
- file status visibility
- progress and error reporting
- provider settings UX wherever possible
- `.fschat-index/` as the local per-folder storage location

### What Must Change

- indexing should not require embedding generation
- search should not require query embeddings
- channel configuration should not require an embedding-capable model for vectorless mode
- manifest and worker contracts must support retrieval mode

## Recommended Vectorless Retrieval Architecture

### Retrieval Strategy

Use a multi-stage vectorless pipeline.

1. Lexical retrieval
   - inverted index over chunk text, file path, and optionally headings or sheet names
   - score with BM25 or SQLite FTS5 ranking
2. Structural and metadata boosts
   - boost exact filename matches
   - boost path segment matches
   - boost title or heading matches
   - optionally boost fresher files or trusted parsers
3. Optional reranking
   - rule-based reranker first
   - optional LLM rerank for the top small candidate set if needed
4. Answer generation
   - unchanged high-level prompt assembly and citation return shape

### Storage Recommendation

Use a lexical store inside `.fschat-index/`, for example:

- `manifest.json`
- `catalog.sqlite`

Recommended `catalog.sqlite` contents:

- `chunks` table with chunk metadata and source path
- FTS virtual table over chunk text and searchable metadata
- optional table for file-level metadata and parser/type info

This is the most natural fit because:

- the desktop app already uses SQLite successfully
- Python can manage it without introducing a heavy new dependency
- incremental updates are easier than maintaining a custom inverted-index file format
- query-time ranking can remain local and fast

If SQLite FTS5 is unavailable in a target environment, use a fallback lexical engine, but keep the manifest contract unchanged.

### Query Flow In Target State

1. Normalize the user query.
2. Run lexical retrieval against the chunk catalog.
3. Apply file/path/title boosts.
4. Optionally rerank the top N chunks.
5. Return the same `SearchResult` shape used today.
6. Generate the answer with the existing chat provider path.

### Index Build Flow In Target State

1. Discover files.
2. Extract text.
3. Normalize text.
4. Split into chunks.
5. Write chunk rows into the lexical catalog.
6. Update the manifest.

The extraction and chunking stages stay largely unchanged. The embedding stage disappears.

## Preserve Existing Look And Feel

The migration should not be treated as a UI redesign.

### Preserve Without Change

- sidebar, files pane, chat pane layout
- channel status pills
- progress card shape
- citations panel shape
- glassmorphism and color palette
- modal and toast styling

### Minimal UI Changes Recommended

1. Replace the meaning of the current "Embedding model" field.
   - Short term: keep the second selector position but relabel it to `Retrieval strategy` or `Index strategy`
   - Long term: remove model-specific wording from channels that no longer need embeddings
2. Update progress copy.
   - Replace `embedding` phase with `indexing` or `cataloging`
   - Update cancel messaging so it no longer says "finished embedding"
3. Keep citations identical.
   - file path
   - score
   - snippet
4. Keep status semantics identical.
   - `idle`, `indexing`, `ready`, `stale`, `error`

### Recommended UX Transition

Do not force a broad UI change in phase one.

Instead:

- preserve control placement
- preserve modal structure
- preserve result rendering
- change labels and help text only where the old embedding language becomes incorrect

## Contract And Schema Changes

### Shared Contracts

Update `packages/shared/src/contracts.ts`.

Recommended additions:

- `RetrievalMode = "vector" | "vectorless"`
- `Channel.retrievalMode`
- `IndexManifest.retrievalMode`
- `IndexManifest.indexEngine`
- `WorkerBuildOptions.retrieval`

Recommended compatibility rule:

- keep `SearchResult`, `Citation`, `Thread`, and `Message` unchanged

That minimizes renderer churn.

### Channel Model Rules

Current rule:

- chat and embedding models must both exist and come from the same provider connection

Target rule:

- vector mode: keep current chat + embedding requirement
- vectorless mode: require only a chat model plus a retrieval strategy

This is important because it unlocks chat-only providers for answer generation.

### Manifest Versioning

Bump the index version and make retrieval mode explicit.

Suggested manifest fields:

```json
{
  "version": 3,
  "rootPath": "C:\\\\example",
  "createdAt": "...",
  "updatedAt": "...",
  "files": [],
  "chunkCount": 0,
  "retrievalMode": "vectorless",
  "indexEngine": "sqlite-fts5"
}
```

Remove vector-specific manifest fields from vectorless indexes:

- `embeddingDimension`
- `embeddingModelKey`

Keep them only for legacy vector indexes if dual support remains.

## Code Areas That Need To Change

### Shared Types

- `packages/shared/src/contracts.ts`

### Main Process

- `apps/desktop/src/main/services/app-service.ts`
  - decouple chat from embedding requirement for vectorless channels
  - stop building worker options around `embeddingProvider` only
  - keep citation and thread handling unchanged
- `apps/desktop/src/main/providers/client.ts`
  - provider discovery can stay mostly as-is
  - default logic should no longer assume an embedding model is required for all channels

### Renderer

- `apps/desktop/src/renderer/app.tsx`
  - keep layout
  - update labels and validation rules around the second model selector
  - update copy that currently says `embedding`
- `apps/desktop/src/renderer/ui/settings-modal.tsx`
  - provider defaults may become `default chat model` plus `default retrieval strategy`
  - or preserve an advanced vector mode section until old channels are retired
- `apps/desktop/src/renderer/ui/common.tsx`
  - progress label copy only

### Python Worker

- `services/indexer/fschat_indexer/worker.py`
  - replace vector build and search paths with vectorless build and search
  - keep extraction, chunking, cancellation, and progress streaming
- `services/indexer/fschat_indexer/index_store.py`
  - support the new lexical index files
- `services/indexer/fschat_indexer/vector_store.py`
  - replace with a new lexical retrieval store module or keep only for legacy mode
- `services/indexer/fschat_indexer/embeddings.py`
  - optional legacy path only

## Recommended Migration Plan

### Phase 0: Baseline

- capture current app behavior with a few representative folders
- document current answer quality, indexing time, and citation quality
- collect sample queries covering exact match, paraphrase, filenames, OCR text, and spreadsheet content

### Phase 1: Introduce Dual Retrieval Modes

- add `retrievalMode` to contracts, channel records, and manifests
- default existing channels to `vector`
- keep current behavior unchanged
- add migration-safe reads for both version 2 and version 3 manifests

### Phase 2: Build The Vectorless Indexer

- implement lexical catalog creation in the Python worker
- keep existing extraction and chunking pipeline
- emit progress without an embedding phase
- make search return the same `SearchResult` payload shape

### Phase 3: Add Channel-Level Vectorless Support

- allow channel creation with `vectorless` mode
- require only chat model plus retrieval strategy in that mode
- keep vector channels working for backward compatibility

### Phase 4: Shadow And Compare

- for internal testing, optionally run vectorless retrieval first and compare against existing vector results
- compare citation overlap, answer completeness, and failure cases
- tune chunking, tokenization, and ranking boosts before broad rollout

### Phase 5: Make Vectorless Default

- new channels default to vectorless
- existing channels remain readable but show a regenerate prompt to migrate
- preserve on-disk vector indexes until the team decides to remove them

### Phase 6: Retire Legacy Vector Path

- remove embedding requirement from the normal UX
- archive or delete `vectors.npy` support once old channels are migrated
- simplify provider defaults and channel settings around chat-only plus retrieval strategy

## Migration Of Existing Channels

### Recommended Approach

Do not attempt to convert `vectors.npy` into a vectorless index in place.

Use channel regenerate as the migration boundary.

Recommended behavior:

1. Existing channels open normally.
2. If the channel is still `vector`, it keeps working unchanged.
3. When switched to `vectorless`, the app clears the indexed file cache for that channel and requires regenerate.
4. Regenerate produces a version 3 vectorless index.

This is simpler and safer than trying to preserve vector artifacts while changing retrieval semantics.

## Key Risks And Mitigations

### Risk: Semantic Recall Drops

Pure lexical search may miss paraphrases and synonym-heavy questions.

Mitigations:

- retrieve more candidates initially
- add heading, filename, and path boosts
- use lightweight query expansion for aliases and acronyms
- add optional reranking for the top candidate set

### Risk: OCR Noise Pollutes Search

OCR-heavy documents may create noisy lexical matches.

Mitigations:

- keep parser metadata in the lexical catalog
- down-rank weak OCR text or low-signal chunks
- filter very short or very noisy chunks before indexing

### Risk: UI Language Becomes Misleading

Labels like `embedding model` and progress phases like `embedding` will be wrong after migration.

Mitigations:

- change labels early even if layout stays the same
- keep control positions stable so the workflow still feels familiar

### Risk: Existing Logic Still Assumes Same-Connection Chat And Embedding

That rule is correct for vector mode but too restrictive for vectorless mode.

Mitigations:

- make validation retrieval-mode aware
- allow chat-only providers in vectorless channels

### Risk: Backward Compatibility Complexity

The main process currently uses `embeddingModelKey` to validate index compatibility.

Mitigations:

- version manifests cleanly
- branch reconciliation logic by retrieval mode
- treat regenerate as the migration step

## Acceptance Criteria

The migration should be considered successful when all of the following are true.

### Product Criteria

- users still create channels, view files, and chat in the same layout
- citations still appear in the same panel and same shape
- users no longer need an embedding-capable model for vectorless channels
- existing vector channels do not break during rollout

### Technical Criteria

- `.fschat-index/` stores a valid vectorless index manifest and lexical catalog
- search returns the current `SearchResult` shape
- `sendMessage` no longer depends on query embeddings for vectorless channels
- progress and cancellation still behave correctly

### Quality Criteria

- exact-match and filename/path questions are at least as good as today
- citation precision is acceptable on OCR, PDF, and spreadsheet content
- indexing time and operational cost improve versus embedding-heavy indexing

## Suggested Validation Matrix

Test at minimum with:

- Markdown and text-heavy folders
- code/config folders
- PDF manuals with mixed text and images
- DOCX and XLSX folders
- image-only folders using OCR
- a provider with both chat and embeddings
- a chat-only provider to validate the new vectorless path

Representative query types:

- exact filename lookup
- exact sentence lookup
- paraphrase of a known passage
- acronym and alias lookup
- spreadsheet row lookup
- OCR-derived text lookup

## Final Recommendation

Move to vectorless RAG with a dual-mode transition, not a flag day rewrite.

The current app's UI, data flow, and chat response contract are already strong enough to preserve the existing user experience. The migration should focus on replacing the indexing and retrieval engine underneath the current shell, then gradually removing embedding-specific concepts from channel setup and index validation once vectorless retrieval quality is proven.
