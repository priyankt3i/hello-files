# Filesystem RAG Chat

Windows-first desktop app for chatting with indexed filesystem folders.

## Monorepo

- `apps/desktop`: Electron shell, React UI, SQLite persistence, provider orchestration
- `packages/shared`: shared TypeScript contracts
- `services/indexer`: Python indexing and retrieval worker

## Development

1. Install Node dependencies: `npm install`
2. Install Python dependencies: `pip install -r services/indexer/requirements.txt`
3. Run the desktop app: `npm run dev`
4. In `Settings`, connect one or more providers, then choose explicit default chat and embedding models.
5. Create a channel and assign the chat model and embedding model you want that folder to use.

If Electron reports that `better-sqlite3` or `keytar` was built against the wrong Node module version, run:

`npm run rebuild:native -w @fschat/desktop`

## Notes

- Each indexed folder stores its index under `.fschat-index/`
- Channel/chat state lives in the desktop app data directory
- Provider secrets are stored via the OS credential store through `keytar`
- Providers are now stored as reusable connections with discovered model registries instead of hardcoded one-per-provider profiles.
- Channel setup uses explicit model selection, and embedding pickers only show models that the app has classified as embedding-capable.
- Regenerate is incremental: unchanged files are skipped, changed files are re-hashed, and unchanged chunks reuse existing vectors.
- The local index now persists chunk metadata plus a NumPy vector store instead of scanning raw JSON chunks for every query.
- Indexed file coverage now includes:
  - text and code/config files
  - `docx`, `doc` (best effort; strongest on Windows with Microsoft Word installed), `pdf`
  - `xlsx`, `xlsm`, `xls`
  - direct images such as `png`, `jpg`, `jpeg`, `bmp`, `gif`, `tif`, `tiff`, `webp`
- OCR is used for standalone images and embedded images found inside `pdf` and `docx` files, so text in charts, diagrams, and screenshots can be indexed when it is visually readable.
