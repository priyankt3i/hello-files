# Contributing

Thanks for contributing to Filesystem RAG Chat.

## Before You Start

- Read `README.md` for project setup and current limitations.
- Keep pull requests focused. Small, reviewable changes are preferred over broad refactors.
- If your change affects indexing, provider behavior, or local index compatibility, call that out clearly in the PR description.

## Local Setup

```bash
npm install
pip install -r services/indexer/requirements.txt
```

Run the app:

```bash
npm run dev
```

Run validation before opening a PR:

```bash
npm run typecheck
python -m compileall services/indexer/fschat_indexer
```

If Electron native modules need to be rebuilt:

```bash
npm run rebuild:native -w @fschat/desktop
```

## Project Structure

- `apps/desktop`: Electron app, renderer UI, SQLite-backed app state
- `packages/shared`: shared contracts used across the app
- `services/indexer`: Python worker for indexing and retrieval

## What Good Contributions Look Like

- bug fixes with a clear reproduction path
- performance improvements that preserve current behavior
- better error handling and recovery for indexing/provider failures
- targeted UX improvements
- documentation improvements that match the current codebase

## Pull Request Guidelines

- Describe the problem being solved.
- Describe the behavior change, not just the code change.
- Include manual validation steps.
- Include screenshots or recordings for UI changes when relevant.
- Avoid unrelated cleanup in the same PR.

## Indexing and Data Compatibility

- Do not silently break existing `.fschat-index` behavior.
- If you change index format or persistence expectations, document the migration impact.
- Preserve incremental indexing behavior unless the PR explicitly changes it.

## Reporting Bugs

When opening an issue, include as much of the following as possible:

- operating system
- provider used
- embedding model used
- whether the issue happens on first index or regenerate
- sample error output
- whether the folder is local, synced, or under OneDrive

## Code Style

- Match the surrounding code style.
- Prefer small, direct changes over framework churn.
- Keep comments brief and only where they add clarity.

## Communication

- Be specific.
- If you are unsure about behavior changes, open an issue or draft PR first.
- If a change is intentionally incomplete, say so clearly.
