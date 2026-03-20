# Getting Started

This guide is for running Filesystem RAG Chat locally for development.

## Prerequisites

- Node.js
- Python 3
- Windows is the primary supported environment today

## Install Dependencies

From the repo root:

```bash
npm install
pip install -r services/indexer/requirements.txt
```

## Start the App

```bash
npm run dev
```

This launches the Electron desktop app from the `apps/desktop` workspace.

## First-Time Setup

1. Open `Settings`
2. Connect a provider
3. Choose default chat and embedding models for that provider connection
4. Create a channel for a local folder
5. Start indexing
6. Ask questions against the indexed folder

## Useful Validation Commands

```bash
npm run typecheck
python -m compileall services/indexer/fschat_indexer
```

If native Electron modules break after install or after a Node/Electron version mismatch:

```bash
npm run rebuild:native -w @fschat/desktop
```

## Where Data Lives

- local folder index: `.fschat-index/` inside the indexed folder
- app metadata and chat state: desktop app data directory
- provider secrets: OS credential store through `keytar`

## Recommended First Files to Read

- `README.md`
- `apps/desktop/src/main/services/app-service.ts`
- `apps/desktop/src/renderer/app.tsx`
- `services/indexer/fschat_indexer/worker.py`
