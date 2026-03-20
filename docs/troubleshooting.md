# Troubleshooting

This page captures common issues seen during local development and indexing.

## Electron Native Module Errors

If Electron reports that `better-sqlite3` or `keytar` was built against the wrong Node module version:

```bash
npm run rebuild:native -w @fschat/desktop
```

## Indexing Feels Stuck or Very Slow

Likely causes:

- OCR-heavy documents
- large local embedding models
- synchronized folders such as OneDrive
- very large folder trees

Things to check:

- whether the folder contains many PDFs or images
- whether Ollama is using a heavy embedding model
- whether the progress panel is still updating batch/file status

## Regenerate Fails With Access Denied on Windows

This can happen when the existing `.fschat-index` directory is locked by the current process or by external sync software.

Common contributing factors:

- OneDrive-managed folders
- antivirus or file sync scanning
- stale handles to vector files

If the problem is intermittent:

- retry regenerate
- close other tools that may be scanning the folder
- try a non-OneDrive local path to compare behavior

## Provider Connection Errors

Typical causes:

- missing API key
- wrong base URL or deployment for Azure OpenAI
- selecting a provider with no embedding-capable models
- stale saved models after provider-side changes

## Chat Says the Channel Is Not Indexed Yet

Check:

- channel status in the UI
- whether the selected embedding model still exists
- whether the local `.fschat-index/manifest.json` is present and valid

## Good Issue Reports

When filing an issue, include:

- operating system
- provider and model used
- whether the problem happened on first index or regenerate
- whether the root folder is local or under OneDrive
- the exact error text
