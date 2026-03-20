# Architecture

This is a high-level guide to how the repository is organized today.

## Top-Level Layout

- `apps/desktop`
- `packages/shared`
- `services/indexer`

## Desktop App

The Electron app lives in `apps/desktop`.

Main responsibilities:

- app lifecycle
- IPC registration
- SQLite-backed app data
- provider orchestration
- bridging to the Python worker

Important files:

- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/services/app-service.ts`
- `apps/desktop/src/main/services/python-worker.ts`
- `apps/desktop/src/main/db/database.ts`
- `apps/desktop/src/main/providers/client.ts`

## Renderer

The React renderer manages:

- channel selection
- indexing progress UI
- file status UI
- chat threads and messages
- settings and provider configuration

Important files:

- `apps/desktop/src/renderer/app.tsx`
- `apps/desktop/src/renderer/ui/common.tsx`
- `apps/desktop/src/renderer/ui/settings-modal.tsx`

## Shared Contracts

Shared TypeScript contracts live in:

- `packages/shared/src/contracts.ts`

This package defines the common data model used across:

- main process
- renderer
- worker bridge payloads

## Python Indexer

The Python worker handles:

- file discovery
- extraction
- text normalization
- chunking
- embedding calls
- vector store persistence
- similarity search

Important files:

- `services/indexer/fschat_indexer/worker.py`
- `services/indexer/fschat_indexer/extractors.py`
- `services/indexer/fschat_indexer/embeddings.py`
- `services/indexer/fschat_indexer/index_store.py`
- `services/indexer/fschat_indexer/vector_store.py`

## Data Flow

1. Renderer calls IPC through the preload bridge
2. Electron main process routes to `DesktopAppService`
3. `DesktopAppService` reads/writes SQLite state and calls the Python worker bridge
4. The Python worker builds or searches the local index
5. Results and progress events flow back to the renderer

## Design Notes

- The app is local-first
- Index data is stored near the source folder
- App metadata is stored separately from source content
- Providers are modeled as reusable connections rather than one-off channel settings

## Areas Likely to Evolve

- long-running indexing architecture
- resume/checkpoint support
- provider-specific reliability handling
- renderer state management structure
