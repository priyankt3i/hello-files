# Desktop Distribution

This guide describes how to build packaged desktop installers for Windows, macOS, and Linux.

## Goals

- Build native desktop installers from one monorepo
- Bundle the Python indexer worker as a per-platform executable
- Avoid requiring end users to install Python manually

## Prerequisites (Builder Machine)

- Node.js
- Python 3
- `pip` packages from `services/indexer/requirements.txt`
- `pyinstaller`

Install prerequisites:

```bash
npm install
python3 -m pip install -r services/indexer/requirements.txt
python3 -m pip install pyinstaller
```

## Build Commands

From repo root:

```bash
npm run build:indexer
npm run dist
```

Or from the desktop workspace:

```bash
npm run build:indexer -w @fschat/desktop
npm run dist -w @fschat/desktop
```

## Output

Packaged artifacts are written to `dist/desktop`.

The build includes a bundled indexer executable copied from:

- `apps/desktop/resources/indexer/<platform>-<arch>/fschat-indexer(.exe)`

At runtime, packaged apps prefer this bundled executable. Development mode continues to use Python worker scripts.

## CI Builds

A GitHub Actions matrix workflow is included at:

- `.github/workflows/desktop-packages.yml`

It builds on:

- Windows
- macOS
- Ubuntu

and uploads generated installers as workflow artifacts.

## Notes

- Cross-compiling macOS/Windows/Linux installers from a single host is not recommended. Build each platform on a matching runner.
- Code signing and notarization are not yet configured in this baseline setup.
