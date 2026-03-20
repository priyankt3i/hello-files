# Indexing

This guide explains the current indexing flow and its practical limits.

## Indexing Pipeline

The Python worker is responsible for indexing:

- file discovery
- extraction
- normalization
- chunking
- embedding generation
- local index write/commit

Primary implementation:

- `services/indexer/fschat_indexer/worker.py`

## Storage Model

Each indexed root folder gets a local `.fschat-index/` directory containing:

- manifest metadata
- chunk metadata
- vector data

The app also stores file status snapshots in SQLite for UI display.

## Incremental Behavior

Regenerate is incremental:

- unchanged files can be reused
- unchanged chunk embeddings can be reused
- changed files are re-extracted and re-embedded

This keeps regenerate cheaper than a full rebuild in many cases.

## What Slows Indexing Down

Common reasons indexing feels slow:

- large folders with many files
- image-heavy PDFs
- OCR-heavy documents
- large local embedding models in Ollama
- synchronized folders such as OneDrive
- Windows filesystem locking during index replacement

## Current Limits

The current implementation is functional, but still evolving for long-running jobs.

Areas still improving:

- checkpoint/resume for long indexing runs
- better partial-progress persistence
- more resilient commit behavior on synced folders
- more controlled concurrency for extraction and embedding

## Files Commonly Supported

- text and code/config files
- `pdf`
- `docx`
- `doc` best effort
- `xlsx`, `xlsm`, `xls`
- common image formats

## Contributor Notes

If you touch indexing behavior:

- avoid breaking existing `.fschat-index` compatibility without documenting it
- keep failure isolation per file whenever possible
- preserve or improve progress reporting
- test on realistic multi-file folders, not only one or two files
