"""On-disk index: one SQLite database per index at `<indexPath>/index.sqlite` (WAL).

Tables: `meta` (JSON-encoded values), `files`, `documents`, `chunks`, `chunks_fts`
(FTS5 external-content table over `chunks.text`, kept in sync by triggers) and
`vectors` (int8 + per-vector scale, keyed by `chunks.id`).

Incremental builds update rows for changed files inside one transaction on the live
database. Full rebuilds and migrations write `<indexPath>.tmp/index.sqlite` and swap
directories (`commit_temp_store`). Version 2/3 JSON indexes are migrated once.
"""

from __future__ import annotations

import contextlib
import ctypes
import json
import os
import shutil
import sqlite3
import sys
import threading
from pathlib import Path
from typing import Any, Iterable, Iterator
from uuid import uuid4

import numpy as np

from vector_store import quantize_vector


INDEX_DIR_NAME = ".fschat-index"
INDEX_TEMP_SUFFIX = ".tmp"
INDEX_OLD_SUFFIX = ".old"
INDEX_TEMP_DIR_NAME = INDEX_DIR_NAME + INDEX_TEMP_SUFFIX
INDEX_OLD_DIR_NAME = INDEX_DIR_NAME + INDEX_OLD_SUFFIX
INDEX_VERSION = 4
LEGACY_JSON_VERSIONS = {2, 3}
SUPPORTED_INDEX_VERSIONS = {INDEX_VERSION}
DB_FILE_NAME = "index.sqlite"
# Tokenizer for chunk text. unicode61 splits on anything that is not a letter/number
# (so `_` and `-` separate tokens, matching the query tokenizer); identifiers such as
# `snake_case_name` are still found exactly because queries are issued as phrases.
FTS_TOKENIZER = "unicode61 remove_diacritics 2"

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS files (
    relative_path TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mtime REAL NOT NULL DEFAULT 0,
    parser TEXT NOT NULL DEFAULT '',
    chunks INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT,
    error_reason TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS documents (
    relative_path TEXT PRIMARY KEY,
    parser TEXT,
    size INTEGER,
    mtime REAL,
    content_hash TEXT,
    chunks INTEGER,
    token_estimate INTEGER,
    summary TEXT,
    section_hints TEXT,
    structure TEXT,
    visual_asset_summary TEXT,
    visual_assets TEXT,
    extra TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    chunk_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    snippet TEXT NOT NULL,
    chunk_hash TEXT NOT NULL,
    file_hash TEXT,
    chunk_type TEXT,
    sheet_name TEXT,
    row_num INTEGER,
    visual_assets TEXT,
    has_visual INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chunks_by_path ON chunks(relative_path, ordinal);
CREATE INDEX IF NOT EXISTS chunks_by_hash ON chunks(chunk_hash);
CREATE INDEX IF NOT EXISTS chunks_visual ON chunks(id) WHERE has_visual = 1;
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text, content='chunks', content_rowid='id', tokenize='{FTS_TOKENIZER}'
);
CREATE TABLE IF NOT EXISTS vectors (
    chunk_id INTEGER PRIMARY KEY,
    dim INTEGER NOT NULL,
    scale REAL NOT NULL,
    data BLOB NOT NULL
);
CREATE TRIGGER IF NOT EXISTS chunks_after_insert AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_after_delete AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    DELETE FROM vectors WHERE chunk_id = old.id;
END;
"""

_STORE_LOCKS: dict[str, threading.RLock] = {}
_STORE_LOCKS_GUARD = threading.Lock()


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def legacy_index_path(root_path: Path) -> Path:
    """Index location used before indexes moved out of the user's folder."""
    return root_path / INDEX_DIR_NAME


def resolve_index_path(root_path: Path, index_path: str | os.PathLike | None = None) -> Path:
    if index_path is not None and str(index_path).strip():
        return Path(index_path)
    return legacy_index_path(root_path)


def temp_index_path(index_path: Path) -> Path:
    return index_path.with_name(index_path.name + INDEX_TEMP_SUFFIX)


def old_index_path(index_path: Path) -> Path:
    return index_path.with_name(index_path.name + INDEX_OLD_SUFFIX)


def db_path(index_path: Path) -> Path:
    return index_path / DB_FILE_NAME


def manifest_path(index_path: Path) -> Path:
    """`manifest.json`: the v2/v3 JSON manifest, or (v4) a small marker kept so that
    tools which only test for its existence still see an index."""
    return index_path / "manifest.json"


def chunk_metadata_path(index_path: Path) -> Path:
    return index_path / "chunk_metadata.jsonl"


def documents_path(index_path: Path) -> Path:
    return index_path / "documents.json"


def vector_index_path(index_path: Path) -> Path:
    return index_path / "vectors.npy"


def index_key(index_path: Path) -> str:
    return os.path.normcase(os.path.abspath(str(index_path)))


def is_within(path: Path, parent: Path) -> bool:
    try:
        child = os.path.normcase(str(path.resolve()))
        base = os.path.normcase(str(parent.resolve()))
    except OSError:
        return False
    return child == base or child.startswith(base.rstrip("\\/") + os.sep)


def store_lock(index_path: Path) -> threading.RLock:
    """Serializes directory swaps against readers holding the database open (Windows
    cannot rename a directory containing an open file)."""
    key = index_key(index_path)
    with _STORE_LOCKS_GUARD:
        lock = _STORE_LOCKS.get(key)
        if lock is None:
            lock = _STORE_LOCKS[key] = threading.RLock()
        return lock


def is_sqlite_index(index_path: Path) -> bool:
    return db_path(index_path).is_file()


def is_json_index(index_path: Path) -> bool:
    if is_sqlite_index(index_path) or not manifest_path(index_path).is_file():
        return False
    try:
        version = json.loads(manifest_path(index_path).read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError, AttributeError):
        return False
    return version in LEGACY_JSON_VERSIONS


def index_exists(index_path: Path) -> bool:
    return is_sqlite_index(index_path) or is_json_index(index_path)


# ---------------------------------------------------------------------------
# Directory swap / recovery
# ---------------------------------------------------------------------------


def recover_index_store(index_path: Path) -> None:
    """Repair an interrupted commit and remove stale temp/old directories."""
    old_path = old_index_path(index_path)
    if old_path.exists() and not index_exists(index_path):
        # Crash between "final -> old" and "temp -> final": restore the previous index.
        if index_path.exists():
            shutil.rmtree(index_path, ignore_errors=True)
        try:
            old_path.replace(index_path)
        except OSError:
            pass
    for stale in (old_path, temp_index_path(index_path)):
        if stale.exists():
            shutil.rmtree(stale, ignore_errors=True)


def prepare_temp_store(index_path: Path) -> Path:
    temp_path = temp_index_path(index_path)
    if temp_path.exists():
        shutil.rmtree(temp_path, ignore_errors=True)
    temp_path.mkdir(parents=True, exist_ok=True)
    return temp_path


def commit_temp_store(index_path: Path, hide: bool = False) -> Path:
    temp_path = temp_index_path(index_path)
    old_path = old_index_path(index_path)
    with store_lock(index_path):
        if old_path.exists():
            shutil.rmtree(old_path, ignore_errors=True)
        moved_previous = False
        if index_path.exists():
            index_path.replace(old_path)
            moved_previous = True
        try:
            temp_path.replace(index_path)
        except OSError:
            if moved_previous and not index_path.exists():
                old_path.replace(index_path)
            raise
        if moved_previous:
            shutil.rmtree(old_path, ignore_errors=True)
    if hide:
        hide_path(index_path)
    return index_path


def cleanup_temp_store(index_path: Path) -> None:
    temp_path = temp_index_path(index_path)
    if temp_path.exists():
        shutil.rmtree(temp_path, ignore_errors=True)


def hide_path(path: Path) -> None:
    if os.name != "nt":
        return
    FILE_ATTRIBUTE_HIDDEN = 0x02
    ctypes.windll.kernel32.SetFileAttributesW(str(path), FILE_ATTRIBUTE_HIDDEN)


def write_marker(store_path: Path) -> None:
    payload = {"version": INDEX_VERSION, "storage": "sqlite", "database": DB_FILE_NAME}
    manifest_path(store_path).write_text(json.dumps(payload), encoding="utf-8")


# ---------------------------------------------------------------------------
# Connections and schema
# ---------------------------------------------------------------------------


def connect(path: Path, read_only: bool = False) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=30, isolation_level=None, check_same_thread=False)
    if not read_only:
        # WAL is persistent; readers don't need to (re)assert it.
        conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-32000")
    return conn


def create_database(path: Path, bulk: bool = False) -> sqlite3.Connection:
    """Create the schema. `bulk` is for a fresh database in a temp directory that is swapped
    in only when complete: no WAL and no fsyncs while writing (a crash just leaves a temp
    directory that is deleted). Call `finalize_bulk_database` before swapping it in."""
    if not bulk:
        conn = connect(path)
        conn.executescript(SCHEMA)
        return conn
    conn = sqlite3.connect(str(path), timeout=30, isolation_level=None, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=MEMORY")
    conn.execute("PRAGMA synchronous=OFF")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-65536")
    conn.executescript(SCHEMA)
    return conn


def finalize_bulk_database(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("PRAGMA journal_mode=WAL")


@contextlib.contextmanager
def open_index_db(index_path: Path) -> Iterator[sqlite3.Connection]:
    """Read access to an index, migrating a v2/v3 JSON index first. Holds the store lock
    while the connection is open so a concurrent directory swap waits."""
    with store_lock(index_path):
        ensure_sqlite_index(index_path)
        path = db_path(index_path)
        if not path.is_file():
            raise FileNotFoundError("Index manifest not found.")
        conn = connect(path, read_only=True)
        try:
            yield conn
        finally:
            conn.close()


def read_meta(conn: sqlite3.Connection) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    for key, value in conn.execute("SELECT key, value FROM meta"):
        try:
            meta[key] = json.loads(value)
        except (TypeError, ValueError):
            meta[key] = value
    return meta


def write_meta(conn: sqlite3.Connection, values: dict[str, Any]) -> None:
    conn.executemany(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [(key, json.dumps(value)) for key, value in values.items()],
    )


def delete_meta(conn: sqlite3.Connection, keys: Iterable[str]) -> None:
    conn.executemany("DELETE FROM meta WHERE key = ?", [(key,) for key in keys])


# ---------------------------------------------------------------------------
# Row <-> dict conversion
# ---------------------------------------------------------------------------

FILE_COLUMNS = "relative_path, status, size, mtime, parser, chunks, content_hash, error_reason"
CHUNK_COLUMNS = "id, chunk_id, relative_path, snippet, text, chunk_hash, file_hash, chunk_type, sheet_name, row_num, visual_assets"
DOCUMENT_COLUMNS = (
    "relative_path, parser, size, mtime, content_hash, chunks, token_estimate, summary, "
    "section_hints, structure, visual_asset_summary, visual_assets, extra"
)
_DOCUMENT_KNOWN_KEYS = {
    "documentId",
    "relativePath",
    "parser",
    "size",
    "mtime",
    "contentHash",
    "chunks",
    "tokenEstimate",
    "summary",
    "sectionHints",
    "structure",
    "visualAssetSummary",
    "visualAssets",
}


def file_row(record: dict[str, Any]) -> tuple:
    return (
        record["relativePath"],
        record["status"],
        int(record.get("size") or 0),
        record.get("mtime") or 0,
        record.get("parser") or "",
        int(record.get("chunks") or 0),
        record.get("contentHash"),
        record.get("errorReason"),
    )


def file_from_row(row: tuple) -> dict[str, Any]:
    payload = {
        "relativePath": row[0],
        "status": row[1],
        "size": row[2],
        "mtime": row[3],
        "parser": row[4],
        "chunks": row[5],
    }
    if row[6]:
        payload["contentHash"] = row[6]
    if row[7]:
        payload["errorReason"] = row[7]
    return payload


def _dump(value: Any) -> str | None:
    return None if value is None else json.dumps(value)


def _load(value: str | None) -> Any:
    return None if value is None else json.loads(value)


def document_row(document: dict[str, Any]) -> tuple:
    extra = {key: value for key, value in document.items() if key not in _DOCUMENT_KNOWN_KEYS}
    return (
        document["relativePath"],
        document.get("parser"),
        document.get("size"),
        document.get("mtime"),
        document.get("contentHash"),
        document.get("chunks"),
        document.get("tokenEstimate"),
        document.get("summary"),
        _dump(document.get("sectionHints")),
        _dump(document.get("structure")),
        _dump(document.get("visualAssetSummary")),
        _dump(document.get("visualAssets")),
        _dump(extra) if extra else None,
    )


def document_from_row(row: tuple) -> dict[str, Any]:
    document = {
        "documentId": row[0],
        "relativePath": row[0],
        "parser": row[1],
        "size": row[2],
        "mtime": row[3],
        "chunks": row[5],
        "tokenEstimate": row[6],
        "summary": row[7],
        "sectionHints": _load(row[8]),
        "contentHash": row[4],
        "structure": _load(row[9]),
        "visualAssetSummary": _load(row[10]),
        "visualAssets": _load(row[11]),
    }
    if row[12]:
        document.update(json.loads(row[12]))
    return document


def chunk_row(chunk: dict[str, Any], ordinal: int) -> tuple:
    visual_assets = chunk.get("visualAssets") or None
    row_number = chunk.get("rowNumber")
    return (
        chunk["chunkId"],
        chunk["relativePath"],
        ordinal,
        chunk["text"],
        chunk.get("snippet") or chunk["text"][:240],
        chunk["chunkHash"],
        chunk.get("fileHash"),
        chunk.get("chunkType") or None,
        chunk.get("sheetName") or None,
        int(row_number) if row_number is not None else None,
        _dump(visual_assets),
        1 if visual_assets else 0,
    )


def chunk_from_row(row: tuple) -> dict[str, Any]:
    chunk: dict[str, Any] = {
        "chunkId": row[1],
        "relativePath": row[2],
        "snippet": row[3],
        "text": row[4],
        "chunkHash": row[5],
        "fileHash": row[6],
    }
    if row[7]:
        chunk["chunkType"] = row[7]
    if row[8]:
        chunk["sheetName"] = row[8]
    if row[9] is not None:
        chunk["rowNumber"] = row[9]
    if row[10]:
        chunk["visualAssets"] = json.loads(row[10])
    return chunk


def _path_sort_key(path: str) -> str:
    return path.lower()


# ---------------------------------------------------------------------------
# Readers (assemble the manifest-shaped payloads the Electron side expects)
# ---------------------------------------------------------------------------


def manifest_from_conn(conn: sqlite3.Connection, include_files: bool = True) -> dict[str, Any]:
    meta = read_meta(conn)
    version = meta.get("version")
    if version not in SUPPORTED_INDEX_VERSIONS:
        raise ValueError("Unsupported index version.")
    manifest: dict[str, Any] = {
        "version": version,
        "rootPath": meta.get("rootPath") or "",
        "createdAt": meta.get("createdAt"),
        "updatedAt": meta.get("updatedAt"),
    }
    if include_files:
        files = [file_from_row(row) for row in conn.execute(f"SELECT {FILE_COLUMNS} FROM files")]
        files.sort(key=lambda item: _path_sort_key(item["relativePath"]))
        manifest["files"] = files
    manifest["chunkCount"] = conn.execute("SELECT count(*) FROM chunks").fetchone()[0]
    manifest["documentCount"] = conn.execute("SELECT count(*) FROM documents").fetchone()[0]
    manifest["retrievalMode"] = meta.get("retrievalMode") or "vector"
    manifest["indexEngine"] = meta.get("indexEngine") or "numpy-cosine"
    if manifest["retrievalMode"] == "vector":
        manifest["embeddingDimension"] = int(meta.get("embeddingDimension") or 0)
        if meta.get("embeddingModelKey") is not None:
            manifest["embeddingModelKey"] = meta.get("embeddingModelKey")
    return manifest


def read_manifest(index_path: Path) -> dict[str, Any]:
    with open_index_db(index_path) as conn:
        return manifest_from_conn(conn)


def read_documents(index_path: Path) -> list[dict[str, Any]]:
    with open_index_db(index_path) as conn:
        documents = [document_from_row(row) for row in conn.execute(f"SELECT {DOCUMENT_COLUMNS} FROM documents")]
    documents.sort(key=lambda item: _path_sort_key(item["relativePath"]))
    return documents


def read_files(index_path: Path, status: str | None = None) -> list[dict[str, Any]]:
    with open_index_db(index_path) as conn:
        if status is None:
            rows = conn.execute(f"SELECT {FILE_COLUMNS} FROM files").fetchall()
        else:
            rows = conn.execute(f"SELECT {FILE_COLUMNS} FROM files WHERE status = ?", (status,)).fetchall()
    files = [file_from_row(row) for row in rows]
    files.sort(key=lambda item: _path_sort_key(item["relativePath"]))
    return files


def read_chunk_metadata(index_path: Path) -> list[dict[str, Any]]:
    if not index_exists(index_path):
        return []
    with open_index_db(index_path) as conn:
        return [chunk_from_row(row) for row in conn.execute(f"SELECT {CHUNK_COLUMNS} FROM chunks ORDER BY id")]


# ---------------------------------------------------------------------------
# Writer
# ---------------------------------------------------------------------------


class IndexWriter:
    """Row-level writes for one build. The transaction starts lazily on the first write,
    so a build that changes nothing never writes."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.in_transaction = False
        self.dirty = False
        self.next_chunk_id: int | None = None

    def begin(self) -> None:
        if not self.in_transaction:
            self.conn.execute("BEGIN IMMEDIATE")
            self.in_transaction = True

    def _write(self) -> sqlite3.Connection:
        self.begin()
        self.dirty = True
        return self.conn

    # -- reads -----------------------------------------------------------

    def file_map(self) -> dict[str, dict[str, Any]]:
        return {row[0]: file_from_row(row) for row in self.conn.execute(f"SELECT {FILE_COLUMNS} FROM files")}

    def paths_missing_vectors(self) -> set[str]:
        rows = self.conn.execute(
            "SELECT DISTINCT relative_path FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.chunk_id = c.id)"
        )
        return {row[0] for row in rows}

    def has_vectors(self) -> bool:
        return self.conn.execute("SELECT EXISTS(SELECT 1 FROM vectors)").fetchone()[0] == 1

    def chunks_missing_vectors(self, relative_path: str) -> list[tuple[int, str, str]]:
        return self.conn.execute(
            "SELECT c.id, c.text, c.chunk_hash FROM chunks c LEFT JOIN vectors v ON v.chunk_id = c.id "
            "WHERE c.relative_path = ? AND v.chunk_id IS NULL ORDER BY c.ordinal",
            (relative_path,),
        ).fetchall()

    def chunks_for_path(self, relative_path: str) -> list[dict[str, Any]]:
        return [
            chunk_from_row(row)
            for row in self.conn.execute(
                f"SELECT {CHUNK_COLUMNS} FROM chunks WHERE relative_path = ? ORDER BY ordinal", (relative_path,)
            )
        ]

    def vector_for_hash(self, chunk_hash: str) -> tuple[int, float, bytes] | None:
        row = self.conn.execute(
            "SELECT v.dim, v.scale, v.data FROM chunks c JOIN vectors v ON v.chunk_id = c.id WHERE c.chunk_hash = ? LIMIT 1",
            (chunk_hash,),
        ).fetchone()
        return (int(row[0]), float(row[1]), bytes(row[2])) if row else None

    def embedding_dimension(self) -> int:
        row = self.conn.execute("SELECT dim FROM vectors LIMIT 1").fetchone()
        return int(row[0]) if row else 0

    def has_document(self, relative_path: str) -> bool:
        return self.conn.execute("SELECT 1 FROM documents WHERE relative_path = ?", (relative_path,)).fetchone() is not None

    # -- writes ----------------------------------------------------------

    def delete_file(self, relative_path: str) -> None:
        conn = self._write()
        conn.execute("DELETE FROM chunks WHERE relative_path = ?", (relative_path,))
        conn.execute("DELETE FROM documents WHERE relative_path = ?", (relative_path,))
        conn.execute("DELETE FROM files WHERE relative_path = ?", (relative_path,))

    def _allocate_chunk_ids(self, count: int) -> int:
        if self.next_chunk_id is None:
            self.next_chunk_id = int(self.conn.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM chunks").fetchone()[0])
        first = self.next_chunk_id
        self.next_chunk_id += count
        return first

    def replace_file(
        self,
        record: dict[str, Any],
        document: dict[str, Any] | None,
        chunks: list[dict[str, Any]],
        existed: bool = True,
    ) -> None:
        """Replace every row for one file (`existed=False` skips the deletes for a file that
        has no rows yet). Chunks may carry `quantized` = (dim, scale, bytes). Chunks and
        vectors go in with one executemany each: few statements per file keeps the main
        thread from stalling on the GIL while extraction results stream in."""
        relative_path = record["relativePath"]
        if existed:
            self.delete_file(relative_path)
        conn = self._write()
        conn.execute(f"INSERT INTO files ({FILE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", file_row(record))
        if document is not None:
            conn.execute(
                f"INSERT INTO documents ({DOCUMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                document_row(document),
            )
        if not chunks:
            return
        first_id = self._allocate_chunk_ids(len(chunks))
        conn.executemany(
            "INSERT INTO chunks (id, chunk_id, relative_path, ordinal, text, snippet, chunk_hash, file_hash, "
            "chunk_type, sheet_name, row_num, visual_assets, has_visual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(first_id + ordinal, *chunk_row(chunk, ordinal)) for ordinal, chunk in enumerate(chunks)],
        )
        vectors = [
            (first_id + ordinal, *chunk["quantized"])
            for ordinal, chunk in enumerate(chunks)
            if chunk.get("quantized") is not None
        ]
        if vectors:
            conn.executemany("INSERT OR REPLACE INTO vectors (chunk_id, dim, scale, data) VALUES (?, ?, ?, ?)", vectors)

    def upsert_document(self, document: dict[str, Any]) -> None:
        self._write().execute(
            f"INSERT OR REPLACE INTO documents ({DOCUMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            document_row(document),
        )

    def update_file_stat(self, record: dict[str, Any]) -> None:
        conn = self._write()
        conn.execute(
            "UPDATE files SET size = ?, mtime = ?, content_hash = ? WHERE relative_path = ?",
            (record["size"], record["mtime"], record.get("contentHash"), record["relativePath"]),
        )
        conn.execute(
            "UPDATE documents SET size = ?, mtime = ?, content_hash = COALESCE(?, content_hash) WHERE relative_path = ?",
            (record["size"], record["mtime"], record.get("contentHash"), record["relativePath"]),
        )

    def insert_vectors(self, rows: list[tuple[int, int, float, bytes]]) -> None:
        if rows:
            self._write().executemany("INSERT OR REPLACE INTO vectors (chunk_id, dim, scale, data) VALUES (?, ?, ?, ?)", rows)

    def delete_all_vectors(self) -> None:
        self._write().execute("DELETE FROM vectors")

    def finish(self, meta: dict[str, Any], drop_keys: Iterable[str] = ()) -> None:
        conn = self._write()
        write_meta(conn, {**meta, "dataVersion": uuid4().hex})
        delete_meta(conn, drop_keys)
        conn.execute("COMMIT")
        self.in_transaction = False

    def rollback(self) -> None:
        self.next_chunk_id = None
        if self.in_transaction:
            try:
                self.conn.execute("ROLLBACK")
            finally:
                self.in_transaction = False

    def close(self) -> None:
        try:
            self.rollback()
        finally:
            self.conn.close()


# ---------------------------------------------------------------------------
# Migration from v2/v3 JSON indexes
# ---------------------------------------------------------------------------


def read_json_manifest(index_path: Path) -> dict[str, Any]:
    manifest = json.loads(manifest_path(index_path).read_text(encoding="utf-8"))
    version = manifest.get("version")
    if version not in LEGACY_JSON_VERSIONS:
        raise ValueError("Unsupported index version.")
    if version == 2:
        manifest["retrievalMode"] = "vector"
        manifest["indexEngine"] = "numpy-cosine"
    manifest.setdefault("retrievalMode", "vector")
    manifest.setdefault("indexEngine", "numpy-cosine")
    return manifest


def migrate_json_store(source: Path, target_store: Path) -> None:
    """Convert a v2/v3 JSON index in `source` into `target_store/index.sqlite`, reusing
    chunk text, documents and vectors (quantized) so nothing is re-extracted or re-embedded."""
    manifest = read_json_manifest(source)
    vectors = None
    vector_file = vector_index_path(source)
    if manifest.get("retrievalMode") == "vector" and vector_file.exists():
        vectors = np.load(vector_file, mmap_mode="r")
        if vectors.ndim != 2:
            vectors = None
    conn = create_database(db_path(target_store), bulk=True)
    try:
        conn.execute("BEGIN")
        conn.executemany(
            f"INSERT OR REPLACE INTO files ({FILE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [file_row(item) for item in manifest.get("files", []) if item.get("relativePath")],
        )
        documents_file = documents_path(source)
        if documents_file.exists():
            documents = json.loads(documents_file.read_text(encoding="utf-8"))
            conn.executemany(
                f"INSERT OR REPLACE INTO documents ({DOCUMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [document_row(item) for item in documents if item.get("relativePath")],
            )
            del documents
        ordinals: dict[str, int] = {}
        dimension = 0
        metadata_file = chunk_metadata_path(source)
        if metadata_file.exists():
            with metadata_file.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    ordinal = ordinals.get(chunk["relativePath"], 0)
                    ordinals[chunk["relativePath"]] = ordinal + 1
                    cursor = conn.execute(
                        "INSERT INTO chunks (chunk_id, relative_path, ordinal, text, snippet, chunk_hash, file_hash, "
                        "chunk_type, sheet_name, row_num, visual_assets, has_visual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        chunk_row(chunk, ordinal),
                    )
                    label = chunk.get("label")
                    if vectors is not None and isinstance(label, int) and 0 <= label < vectors.shape[0]:
                        dim, scale, data = quantize_vector(vectors[label])
                        dimension = dim
                        conn.execute(
                            "INSERT INTO vectors (chunk_id, dim, scale, data) VALUES (?, ?, ?, ?)",
                            (cursor.lastrowid, dim, scale, data),
                        )
        meta = {
            "version": INDEX_VERSION,
            "rootPath": manifest.get("rootPath") or "",
            "createdAt": manifest.get("createdAt"),
            "updatedAt": manifest.get("updatedAt"),
            "retrievalMode": manifest.get("retrievalMode"),
            "indexEngine": manifest.get("indexEngine"),
            "dataVersion": uuid4().hex,
            "migratedFromVersion": manifest.get("version"),
        }
        if manifest.get("retrievalMode") == "vector":
            meta["embeddingDimension"] = dimension or int(manifest.get("embeddingDimension") or 0)
            if manifest.get("embeddingModelKey") is not None:
                meta["embeddingModelKey"] = manifest.get("embeddingModelKey")
        write_meta(conn, meta)
        conn.execute("COMMIT")
        finalize_bulk_database(conn)
    finally:
        conn.close()
        if vectors is not None:
            mmap_handle = getattr(vectors, "_mmap", None)
            if mmap_handle is not None:
                mmap_handle.close()
        del vectors
    write_marker(target_store)


def copy_sqlite_store(source: Path, target_store: Path) -> None:
    source_conn = sqlite3.connect(str(db_path(source)))
    target_conn = sqlite3.connect(str(db_path(target_store)))
    try:
        source_conn.backup(target_conn)
    finally:
        target_conn.close()
        source_conn.close()
    conn = connect(db_path(target_store))
    conn.close()
    write_marker(target_store)


def ensure_sqlite_index(index_path: Path) -> bool:
    """Migrate a v2/v3 JSON index at `index_path` into SQLite (once). Returns True if migrated."""
    with store_lock(index_path):
        if not is_json_index(index_path):
            return False
        recover_index_store(index_path)
        if not is_json_index(index_path):
            return False
        temp_store = prepare_temp_store(index_path)
        try:
            migrate_json_store(index_path, temp_store)
            commit_temp_store(index_path, hide=index_path.name == INDEX_DIR_NAME)
        except Exception:
            cleanup_temp_store(index_path)
            raise
        print(f"Migrated JSON index at {index_path} to SQLite.", file=sys.stderr, flush=True)
        return True


def import_index(source: Path, index_path: Path, hide: bool = False) -> None:
    """Copy (and if needed migrate) the index in `source` into `index_path`, then delete `source`."""
    with store_lock(index_path):
        temp_store = prepare_temp_store(index_path)
        try:
            if is_sqlite_index(source):
                with store_lock(source):
                    copy_sqlite_store(source, temp_store)
            else:
                migrate_json_store(source, temp_store)
            commit_temp_store(index_path, hide=hide)
        except Exception:
            cleanup_temp_store(index_path)
            raise
    with store_lock(source):
        shutil.rmtree(source, ignore_errors=True)


def read_store_root(index_path: Path) -> str | None:
    """The root path recorded in an index (SQLite or JSON), without migrating it."""
    if is_sqlite_index(index_path):
        with store_lock(index_path):
            conn = connect(db_path(index_path), read_only=True)
            try:
                return read_meta(conn).get("rootPath")
            finally:
                conn.close()
    if is_json_index(index_path):
        return read_json_manifest(index_path).get("rootPath")
    return None
