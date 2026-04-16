# Vectorless RAG

This repo now supports two retrieval modes: `vector` and `vectorless`. This document describes the vectorless path that is implemented today.

The implementation is centered in:

- `apps/desktop/src/main/services/app-service.ts`
- `apps/desktop/src/main/providers/client.ts`
- `services/indexer/fschat_indexer/worker.py`
- `services/indexer/fschat_indexer/index_store.py`
- `services/indexer/fschat_indexer/vector_store.py`
- `packages/shared/src/contracts.ts`

## What "vectorless" means here

In this codebase, vectorless RAG means:

- no embedding generation during indexing for vectorless channels
- no query embedding at chat time
- no `embeddingProvider` requirement for vectorless search
- retrieval driven by a manifest-first document pass followed by lexical chunk scoring

The retrieval mode is stored on both the channel and the index manifest. For vectorless channels, the worker reports the engine as `manifest-first-lexical`.

## Index Build Path

Vectorless indexing keeps the same extraction pipeline as vector mode, but it stops before embeddings.

1. Discover supported files under the channel root.
   Files inside `.fschat-index/` and `.fschat-index.tmp/` are skipped.
2. Extract and normalize text.
3. Split text into overlapping chunks.
   The current worker uses `chunk_size=1200` and `overlap=200`.
4. Build per-document metadata.
   Each document record stores `documentId`, `relativePath`, parser name, file stats, chunk count, token estimate, a generated summary, section hints, and an optional content hash.
5. Write the local index.

For vectorless channels, the on-disk index is effectively:

- `.fschat-index/manifest.json`
- `.fschat-index/documents.json`
- `.fschat-index/chunk_metadata.jsonl`

`vectors.npy` is not written for vectorless indexes. The shared writer still emits chunk metadata, but with no embedding payload to normalize or persist.

## Incremental Reuse

The worker keeps the same incremental behavior in vectorless mode:

- if file size and mtime match, the previous file record, chunks, and document metadata are reused
- if stat-based reuse misses but the content hash matches, the same data is still reused

That means vectorless rebuilds stay cheap when files are unchanged even though no vector cache exists.

## Retrieval Flow

Vectorless retrieval is a two-stage pipeline.

### 1. Manifest-first document selection

Before chunk search, the app loads `documents.json` and scores documents using lightweight metadata:

- `relativePath`
- generated `summary`
- extracted `sectionHints`

The heuristic preselector keeps the top 24 candidates. It rewards:

- exact lowercase query matches in the metadata blob: `+5`
- repeated token matches in the metadata blob: up to `+6` per token
- token matches in the file path: `+1.5` per token

After that heuristic pass, the app asks the configured chat model to choose the smallest useful set of documents, capped at 3, and return strict JSON:

```json
{"document_ids":["..."],"reasoning":"..."}
```

If the model fails, returns invalid JSON, or selects nothing usable, the app falls back to the top heuristic candidates.

### 2. Lexical chunk scoring

The worker then searches chunk text only inside the selected documents. If that returns no results, the app retries across the full vectorless index.

Chunk ranking is lexical and path-aware:

- exact full-query substring in `relativePath + text`: `+4.0`
- token frequency matches: `+0.65 * min(count, 8)` per token
- token present in the file path: `+1.5`
- each unique matched token adds `+0.9`

Only chunks with a positive score are returned. The app currently asks for up to 8 chunks in vectorless mode.

## Answer Generation And Citations

Once chunks are selected, the answer path is the same shape as normal chat:

1. The main process builds an "Indexed context" block from the retrieved chunks.
2. Recent thread history is appended.
3. The selected chat model generates the response.
4. Search results are attached back to the assistant message as citations.

So vectorless changed retrieval, not the conversation, thread, or citation model.

## Why We Took This Approach

This design keeps the existing desktop UX and local index layout mostly intact while removing the hardest dependency in the old flow: embeddings.

Practical benefits:

- vectorless channels do not require an embedding-capable provider
- chat-only providers such as Anthropic can participate in retrieval-backed channels
- indexing is cheaper and simpler because there is no embedding phase
- the retrieval path is easier to inspect because it is based on manifest metadata and explicit lexical scoring

## Tradeoffs

This approach is intentionally simpler than dense vector search, so it also has clear limits:

- recall is weaker for synonym-heavy or concept-heavy queries
- retrieval quality depends heavily on extracted text quality
- the manifest pass works best when summaries, headings, and file paths are informative
- LLM-based document selection can choose the wrong files, although the heuristic and global-search fallbacks reduce that risk

## Current Mental Model

The shortest way to think about the implemented approach is:

1. index files into chunks plus a document manifest
2. shortlist likely documents from manifest metadata
3. optionally let the chat model narrow that shortlist
4. run lexical search over chunks
5. answer with citations from the selected chunk set

That is the vectorless RAG path currently shipped in this repo.
