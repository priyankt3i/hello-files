from __future__ import annotations

import base64
import hashlib
import io
import itertools
import json
import math
import multiprocessing
import os
import re
import sqlite3
import stat as stat_module
import sys
import threading
import time
import traceback
import zipfile
from collections import deque
from concurrent.futures import Future, ProcessPoolExecutor, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable
from uuid import uuid4

import numpy as np

import embeddings
from embeddings import EmbeddingError, batched, embed_query, embed_texts
from extractors import dedupe_preserve_order, extract_document, fs_path, load_fitz, normalize_text
from index_store import (
    CHUNK_COLUMNS,
    INDEX_DIR_NAME,
    INDEX_OLD_DIR_NAME,
    INDEX_TEMP_DIR_NAME,
    INDEX_VERSION,
    SUPPORTED_INDEX_VERSIONS,
    IndexWriter,
    chunk_from_row,
    cleanup_temp_store,
    commit_temp_store,
    connect,
    create_database,
    db_path,
    ensure_sqlite_index,
    finalize_bulk_database,
    import_index,
    index_exists,
    index_key,
    is_sqlite_index,
    is_within,
    legacy_index_path,
    old_index_path,
    open_index_db,
    prepare_temp_store,
    read_documents,
    read_files,
    read_manifest,
    read_meta,
    read_store_root,
    recover_index_store,
    resolve_index_path,
    store_lock,
    temp_index_path,
    write_marker,
)
from spreadsheet_sql import SpreadsheetQueryError, spreadsheet_query, spreadsheet_schema
from vector_store import clear_index_cache, cosine_scores, load_vector_matrix, quantize_vector

try:
    from PIL import Image
except ImportError:
    Image = None


STATUS_INDEXED = "indexed"
STATUS_FAILED = "failed"
STATUS_SKIPPED = "skipped"


@dataclass
class FileRecord:
    relative_path: str
    status: str
    size: int
    mtime: float
    parser: str
    chunks: int
    content_hash: str | None = None
    error_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "relativePath": self.relative_path,
            "status": self.status,
            "size": self.size,
            "mtime": self.mtime,
            "parser": self.parser,
            "chunks": self.chunks,
        }
        if self.content_hash:
            payload["contentHash"] = self.content_hash
        if self.error_reason:
            payload["errorReason"] = self.error_reason
        return payload


@dataclass
class CancelRequest:
    retain_partial: bool
    sequence: int = 0


class CancelledBuild(RuntimeError):
    def __init__(self, retain_partial: bool):
        super().__init__("Indexing cancelled.")
        self.retain_partial = retain_partial


def default_max_workers() -> int:
    return max(1, min(4, (os.cpu_count() or 2) - 1))


@dataclass
class BuildOptions:
    exclude_patterns: list[re.Pattern[str]] = field(default_factory=list)
    exclude_labels: list[str] = field(default_factory=list)  # the user's rule text, parallel to exclude_patterns
    include_ext_patterns: list[re.Pattern[str]] = field(default_factory=list)
    include_name_patterns: list[re.Pattern[str]] = field(default_factory=list)
    max_file_size_mb: float = 50
    include_hidden: bool = False
    max_workers: int = field(default_factory=default_max_workers)

    @property
    def max_file_size_bytes(self) -> int:
        return int(self.max_file_size_mb * 1024 * 1024)


@dataclass
class DiscoveredFile:
    path: Path
    relative_path: str
    stat: Any = None  # stat result captured during discovery (None: stat on demand)
    skip_reason: str | None = None  # set when the user's rules leave this file out of the index


@dataclass
class FilePlan:
    """What the build has to do for one discovered file, decided from a cheap stat."""

    item: DiscoveredFile
    kind: str  # "unchanged" | "work" | "too_large" | "excluded" | "stat_error" | "vanished"
    previous: dict[str, Any] | None
    size: int = 0
    mtime: float = 0.0
    error: str | None = None
    previous_hash: str | None = None


@dataclass
class BuildState:
    seen_paths: set[str] = field(default_factory=set)
    stats: dict[str, int] = field(
        default_factory=lambda: {"added": 0, "updated": 0, "removed": 0, "unchanged": 0, "failed": 0, "skipped": 0}
    )
    processed_files: int = 0
    success_count: int = 0
    failure_count: int = 0
    record_count: int = 0

    def add(self, record: "FileRecord", category: str) -> None:
        self.seen_paths.add(record.relative_path)
        self.stats[category] += 1
        self.record_count += 1
        if category in {"unchanged", "skipped"}:
            return  # progress counts only files that were actually (re)processed
        if record.status == STATUS_INDEXED:
            self.success_count += 1
        elif record.status == STATUS_FAILED:
            self.failure_count += 1


@dataclass
class BuildContext:
    channel_id: str
    root_path: Path
    index_dir: Path
    retrieval: dict[str, Any]
    build_options: BuildOptions
    embedding_provider: dict[str, Any]
    model_key: str | None
    writer: IndexWriter
    in_place: bool
    previous_files: dict[str, dict[str, Any]]
    state: BuildState = field(default_factory=BuildState)
    total_files: int = 0
    missing_vectors: set[str] = field(default_factory=set)
    missing_documents: set[str] = field(default_factory=set)
    embedding_dimension: int = 0
    # Set when the embedding provider failed during this build. The build then finishes as a
    # keyword (full-text) index instead of failing, and later syncs embed what is missing.
    embedding_error: str | None = None

    @property
    def vector_mode(self) -> bool:
        return self.retrieval["mode"] == "vector"


# channelId -> pending cancel request. Guarded by _BUILD_LOCK.
CANCELLED_CHANNELS: dict[str, CancelRequest] = {}
# channelId -> number of builds queued or running. Guarded by _BUILD_LOCK.
_PENDING_BUILDS: dict[str, int] = {}
_BUILD_LOCK = threading.Lock()
_BUILD_SEQUENCE = itertools.count(1)
_STDOUT_LOCK = threading.Lock()
BUILD_EXECUTOR = ThreadPoolExecutor(max_workers=1)

VISION_MAX_IMAGE_EDGE = 1600
VISION_MAX_IMAGE_PIXELS = 2_500_000
VISUAL_QUERY_TOKENS = {"chart", "charts", "graph", "graphs", "image", "images", "diagram", "diagrams", "figure", "figures", "screenshot", "screenshots", "visual", "visuals"}
MAX_DOCUMENT_VISUAL_ASSETS = 24
MAX_VISUAL_SUMMARY_LABELS = 12

DEFAULT_MAX_FILE_SIZE_MB = 50
MAX_WORKERS_LIMIT = 32
# Spawning extraction processes costs ~1-3 s on Windows (each re-imports the worker), so
# the pool is only used when the estimated extraction work is larger than that.
# A PyInstaller-frozen child re-launches the bundled executable, which costs several more
# seconds than a plain interpreter (measured ~5 s vs ~1.5 s).
PARALLEL_MIN_ESTIMATED_SECONDS = 10.0 if getattr(sys, "frozen", False) else 3.0
HEAVY_EXTRACTION_SECONDS = 0.5
HEAVY_EXTENSIONS = {
    ".pdf", ".docx", ".docm", ".doc", ".rtf", ".xlsx", ".xlsm", ".xls",
    ".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp",
}
PREFETCH_PER_WORKER = 2
BATCH_MAX_FILES = 32
BATCH_MAX_SECONDS = 0.25
MAX_POOL_RESTARTS = 3
POOL_START_TIMEOUT_SECONDS = 30.0
BATCH_TIMEOUT_SECONDS = 90.0  # a batch of several cheap files that takes this long is stuck
# One file alone gets longer: documents that are mostly screenshots are read by OCR, which takes
# 30-90 s on a busy laptop for a document that is only 1-2 MB.
SINGLE_FILE_TIMEOUT_SECONDS = 300.0
FUTURE_POLL_SECONDS = 0.2
UNCHANGED_PROGRESS_INTERVAL = 0.1
MAX_RULE_SKIPPED_FILES = 10_000  # cap on files listed as skipped by the user's rules
IGNORED_DIR_NAMES = {
    name.lower()
    for name in {
        ".git",
        ".svn",
        ".hg",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        ".idea",
        ".vs",
        INDEX_DIR_NAME,
        INDEX_TEMP_DIR_NAME,
        INDEX_OLD_DIR_NAME,
    }
}
IGNORED_FILE_NAMES = {"thumbs.db", "desktop.ini"}
FILE_ATTRIBUTE_HIDDEN = 0x02
FILE_ATTRIBUTE_SYSTEM = 0x04
IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003

PATH_MATCH_BOOST = 0.75
VISUAL_ASSET_BOOST = 1.5
MAX_QUERY_TERMS = 64
MIN_TEXT_CANDIDATES = 200
_PATH_TOKEN_CACHE: dict[str, "PathTokenIndex"] = {}
_PATH_TOKEN_CACHE_LIMIT = 4
_LEXICAL_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------


def _write_stdout(message: dict[str, Any]) -> None:
    line = json.dumps(message)
    with _STDOUT_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def emit_response(request_id: str | None, ok: bool, payload: Any = None, error: str | None = None) -> None:
    _write_stdout({"id": request_id, "type": "response", "ok": ok, "payload": payload, "error": error})


def emit_progress(payload: dict[str, Any]) -> None:
    _write_stdout({"type": "event", "method": "progress", "payload": payload})


def emit_file_update(payload: dict[str, Any]) -> None:
    _write_stdout({"type": "event", "method": "file_update", "payload": payload})


def report_exception(exc: BaseException) -> str:
    """Log the traceback to stderr and return a concise user-facing message."""
    with _STDOUT_LOCK:
        traceback.print_exception(type(exc), exc, exc.__traceback__, file=sys.stderr)
        sys.stderr.flush()
    return describe_error(exc)


def describe_error(exc: BaseException) -> str:
    if isinstance(exc, KeyError):
        return f"Missing required field {exc}."
    message = str(exc).strip()
    return message or exc.__class__.__name__


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def request_paths(payload: dict[str, Any]) -> tuple[Path, Path]:
    root_path = Path(payload["rootPath"])
    return root_path, resolve_index_path(root_path, payload.get("indexPath"))


def handle_request(request: dict[str, Any]) -> None:
    request_id = request.get("id")
    method = request.get("method")
    payload = request.get("payload") or {}

    try:
        if method == "get_index_status":
            _, index_path = request_paths(payload)
            if not index_exists(index_path):
                emit_response(request_id, True, {"exists": False})
                return
            try:
                manifest = read_manifest(index_path)
            except (ValueError, OSError, KeyError, sqlite3.Error) as exc:
                log_warning(f"Index at {index_path} is unreadable: {describe_error(exc)}")
                emit_response(request_id, True, {"exists": False})
                return
            emit_response(request_id, True, {"exists": True, "manifest": manifest})
            return

        if method == "open_index":
            _, index_path = request_paths(payload)
            emit_response(request_id, True, {"manifest": read_manifest(index_path)})
            return

        if method in {"build_index", "rebuild_index"}:
            root_path, _ = request_paths(payload)
            submit_build_request(
                request_id,
                payload["channelId"],
                root_path,
                payload.get("options") or {},
                method == "rebuild_index",
                index_path=payload.get("indexPath"),
            )
            return

        if method == "cancel_build":
            accepted = request_cancel(payload["channelId"], bool(payload.get("retainPartial")))
            emit_response(request_id, True, {"cancelled": accepted})
            return

        if method == "list_files":
            _, index_path = request_paths(payload)
            emit_response(request_id, True, {"files": read_files(index_path, payload["status"])})
            return

        if method == "list_documents":
            _, index_path = request_paths(payload)
            emit_response(request_id, True, {"documents": read_documents(index_path)})
            return

        if method == "resolve_visual_assets":
            root_path = Path(payload["rootPath"])
            assets = resolve_visual_assets(root_path, payload.get("assets") or [], int(payload.get("maxAssets", 3)))
            emit_response(request_id, True, {"assets": assets})
            return

        if method == "search":
            root_path, index_path = request_paths(payload)
            result = search_index(
                root_path,
                payload["query"],
                int(payload.get("topK", 6)),
                payload.get("options") or {},
                index_path=index_path,
            )
            emit_response(request_id, True, {"results": result})
            return

        if method == "spreadsheet_schema":
            root_path, index_path = request_paths(payload)
            document_ids = payload.get("documentIds")
            if document_ids is not None and not isinstance(document_ids, list):
                raise ValueError("documentIds must be a list.")
            submit_spreadsheet_request(request_id, lambda: spreadsheet_schema(root_path, index_path, document_ids))
            return

        if method == "spreadsheet_query":
            root_path, index_path = request_paths(payload)
            document_ids = payload.get("documentIds")
            if not isinstance(document_ids, list):
                raise SpreadsheetQueryError("documentIds must be a list of spreadsheet documents.")
            sql, max_rows = payload.get("sql"), payload.get("maxRows")
            submit_spreadsheet_request(
                request_id, lambda: spreadsheet_query(root_path, index_path, document_ids, sql, max_rows)
            )
            return

        raise ValueError(f"Unknown method '{method}'.")
    except SpreadsheetQueryError as exc:
        # An expected, user-facing problem (bad SQL, unreadable sheet): no traceback.
        emit_response(request_id, False, error=str(exc))
    except Exception as exc:
        emit_response(request_id, False, error=report_exception(exc))


_SPREADSHEET_LOCK = threading.Lock()


def submit_spreadsheet_request(request_id: str | None, task: Callable[[], Any]) -> None:
    """Run a spreadsheet calculation off the protocol thread: parsing a large workbook can take
    many seconds and must not block searches or cancel requests. Calculations run one at a time."""

    def run() -> None:
        try:
            with _SPREADSHEET_LOCK:
                result = task()
            emit_response(request_id, True, result)
        except SpreadsheetQueryError as exc:
            # An expected, user-facing problem (bad SQL, unreadable sheet): no traceback.
            emit_response(request_id, False, error=str(exc))
        except Exception as exc:
            emit_response(request_id, False, error=report_exception(exc))

    threading.Thread(target=run, name="spreadsheet-calc", daemon=True).start()


# ---------------------------------------------------------------------------
# Build scheduling and cancellation
# ---------------------------------------------------------------------------


def register_build(channel_id: str) -> int:
    with _BUILD_LOCK:
        _PENDING_BUILDS[channel_id] = _PENDING_BUILDS.get(channel_id, 0) + 1
        return next(_BUILD_SEQUENCE)


def finish_build(channel_id: str) -> None:
    with _BUILD_LOCK:
        remaining = _PENDING_BUILDS.get(channel_id, 0) - 1
        if remaining > 0:
            _PENDING_BUILDS[channel_id] = remaining
        else:
            _PENDING_BUILDS.pop(channel_id, None)


def request_cancel(channel_id: str, retain_partial: bool) -> bool:
    """Record a cancel request. Ignored (returns False) when the channel has no queued or running build."""
    with _BUILD_LOCK:
        if _PENDING_BUILDS.get(channel_id, 0) <= 0:
            return False
        CANCELLED_CHANNELS[channel_id] = CancelRequest(retain_partial=retain_partial, sequence=next(_BUILD_SEQUENCE))
        return True


def clear_stale_cancel(channel_id: str, submit_sequence: int | None) -> None:
    """Drop cancel requests issued before this build was submitted (they targeted an earlier build)."""
    with _BUILD_LOCK:
        request = CANCELLED_CHANNELS.get(channel_id)
        if request is None:
            return
        if submit_sequence is None or request.sequence < submit_sequence:
            CANCELLED_CHANNELS.pop(channel_id, None)


def take_cancel_request(channel_id: str) -> CancelRequest | None:
    with _BUILD_LOCK:
        return CANCELLED_CHANNELS.pop(channel_id, None)


def submit_build_request(
    request_id: str | None,
    channel_id: str,
    root_path: Path,
    options: dict,
    force: bool,
    index_path: str | None = None,
) -> None:
    submit_sequence = register_build(channel_id)

    def run() -> None:
        try:
            result = build_index(
                channel_id,
                root_path,
                options,
                force=force,
                index_path=index_path,
                submit_sequence=submit_sequence,
            )
            emit_response(request_id, True, result)
        except Exception as exc:
            emit_response(request_id, False, error=report_exception(exc))
        finally:
            finish_build(channel_id)

    BUILD_EXECUTOR.submit(run)


def ensure_not_cancelled(
    channel_id: str,
    total_files: int,
    processed_files: int,
    success_count: int,
    failure_count: int,
    current_file: str | None = None,
) -> None:
    request = take_cancel_request(channel_id)
    if request is None:
        return
    message = "Indexing cancelled. Retaining partial index." if request.retain_partial else "Indexing cancelled. Discarding partial index."
    emit_progress(
        {
            "channelId": channel_id,
            "phase": "cancelled",
            "totalFiles": total_files,
            "processedFiles": processed_files,
            "successCount": success_count,
            "failureCount": failure_count,
            "currentFile": current_file,
            "message": message,
        }
    )
    raise CancelledBuild(retain_partial=request.retain_partial)


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def build_index(
    channel_id: str,
    root_path: Path,
    options: dict,
    force: bool = False,
    index_path: str | os.PathLike | None = None,
    submit_sequence: int | None = None,
) -> dict[str, Any]:
    """Incremental build. With a usable previous index the live SQLite database is updated
    in one transaction (only rows of added/changed/removed files are touched; nothing is
    written when nothing changed). Otherwise (first build, `force`, unreadable or foreign
    index) a fresh database is written to `<index>.tmp` and swapped in."""
    clear_stale_cancel(channel_id, submit_sequence)
    if not root_path.exists() or not root_path.is_dir():
        raise ValueError("Selected root path does not exist or is not a directory.")
    index_dir = resolve_index_path(root_path, index_path)
    retrieval = resolve_retrieval_options(options)
    build_options = resolve_build_options(options)
    embedding_provider = options.get("embeddingProvider") or {}
    if retrieval["mode"] == "vector" and not embedding_provider:
        raise ValueError("Embedding provider configuration is required.")
    model_key = build_embedding_model_key(embedding_provider) if retrieval["mode"] == "vector" else None

    prepare_index_location(index_dir, root_path)
    previous_meta = load_previous_meta(index_dir, root_path)
    in_place = previous_meta is not None and not force
    if in_place:
        writer = IndexWriter(connect(db_path(index_dir)))
        previous_files = writer.file_map()
    else:
        previous_files = load_previous_file_map(index_dir) if previous_meta is not None else {}
        writer = IndexWriter(create_database(db_path(prepare_temp_store(index_dir)), bulk=True))
    created_at = (previous_meta.get("createdAt") if previous_meta else None) or utc_now()
    settings_dirty = not in_place or index_settings_changed(previous_meta or {}, retrieval, model_key)
    ctx = BuildContext(
        channel_id=channel_id,
        root_path=root_path,
        index_dir=index_dir,
        retrieval=retrieval,
        build_options=build_options,
        embedding_provider=embedding_provider,
        model_key=model_key,
        writer=writer,
        in_place=in_place,
        previous_files=previous_files,
    )
    state = ctx.state

    def discard() -> None:
        writer.close()
        if not in_place:
            cleanup_temp_store(index_dir)

    discovered: list[DiscoveredFile] = []
    position = 0
    pipeline: ExtractionPipeline | None = None
    try:
        if in_place:
            prepare_in_place_vectors(ctx, previous_meta)
        progress(ctx, "discovering", 0, message="Scanning folder for supported files.")
        rule_skipped: list[DiscoveredFile] = []
        discovered = discover_files(
            root_path,
            build_options,
            index_path=index_dir,
            on_progress=lambda count: progress(ctx, "discovering", count, message=f"Scanning folder... discovered {count} files so far."),
            skipped=rule_skipped,
        )
        if rule_skipped:
            # Files the user's rules leave out are still listed (as skipped, with the reason).
            discovered = sorted(discovered + rule_skipped, key=lambda item: item.relative_path.lower())
        ctx.total_files = len(discovered)
        progress(ctx, "discovering", ctx.total_files, message=f"Discovered {ctx.total_files} files.")

        plans = plan_files(ctx, discovered)
        # Progress covers only the files that need work, so a sync after a settings change that
        # leaves most files untouched reads "3 of 3", not "1,800 of 1,800".
        ctx.total_files = sum(1 for plan in plans if plan.kind == "work")
        pipeline = ExtractionPipeline(plans, build_options.max_workers, lambda relative_path: check_cancel(ctx, relative_path))
        last_quiet_progress = 0.0
        for position, plan in enumerate(plans):
            relative_path = plan.item.relative_path
            ensure_not_cancelled(
                channel_id, ctx.total_files, state.processed_files, state.success_count, state.failure_count, relative_path
            )
            quiet = plan.kind in {"unchanged", "excluded", "too_large"}
            now = time.monotonic()
            if not quiet or now - last_quiet_progress >= UNCHANGED_PROGRESS_INTERVAL:
                progress(ctx, "extracting", ctx.total_files, currentFile=relative_path)
            result = pipeline.result_for(position) if plan.kind == "work" else None
            outcome = apply_plan(ctx, plan, result)
            if outcome is not None:
                record, category = outcome
                state.add(record, category)
                emit_file_update({"channelId": channel_id, "file": record.to_dict()})
            if plan.kind == "work":
                state.processed_files += 1
            if not quiet or now - last_quiet_progress >= UNCHANGED_PROGRESS_INTERVAL:
                progress(ctx, "extracting", ctx.total_files, currentFile=relative_path)
                last_quiet_progress = now
        position = len(plans)
        pipeline.close()
    except CancelledBuild as exc:
        if pipeline is not None:
            pipeline.close(cancel=True)
        if not exc.retain_partial:
            discard()
            return {"manifest": None, "files": [], "cancelled": True, "retainedPartial": False, "stats": state.stats}
        try:
            if in_place:
                carry_over_unprocessed(ctx, discovered[position:])
            remove_unseen(ctx)
            if not in_place and state.record_count == 0:
                discard()
                return {"manifest": None, "files": [], "cancelled": True, "retainedPartial": False, "stats": state.stats}
            manifest = commit_build(ctx, created_at, settings_dirty)
        except Exception:
            discard()
            raise
        return {
            "manifest": manifest,
            "files": manifest["files"],
            "cancelled": True,
            "retainedPartial": True,
            "stats": state.stats,
            "embeddingError": ctx.embedding_error,
        }
    except BaseException:
        if pipeline is not None:
            pipeline.close(cancel=True)
        discard()
        raise

    try:
        remove_unseen(ctx)
        changed = settings_dirty or writer.dirty
        if changed:
            progress(ctx, "writing", ctx.total_files, message="Writing index files.")
        manifest = commit_build(ctx, created_at, settings_dirty)
    except BaseException:
        discard()
        raise
    progress(ctx, "completed", ctx.total_files, message="Index complete." if changed else "Index is up to date.")
    return {
        "manifest": manifest,
        "files": manifest["files"],
        "cancelled": False,
        "retainedPartial": False,
        "stats": state.stats,
        "embeddingError": ctx.embedding_error,
    }


def progress(ctx: BuildContext, phase: str, total: int, **extra: Any) -> None:
    state = ctx.state
    emit_progress(
        {
            "channelId": ctx.channel_id,
            "phase": phase,
            "totalFiles": total,
            "processedFiles": state.processed_files,
            "successCount": state.success_count,
            "failureCount": state.failure_count,
            **extra,
        }
    )


def check_cancel(ctx: BuildContext, relative_path: str | None) -> None:
    state = ctx.state
    ensure_not_cancelled(
        ctx.channel_id, ctx.total_files, state.processed_files, state.success_count, state.failure_count, relative_path
    )


def prepare_index_location(index_dir: Path, root_path: Path) -> None:
    """Recover an interrupted swap, migrate a v2/v3 JSON index to SQLite, and import a
    legacy in-folder index into `index_dir` (then remove it) when `index_dir` is empty."""
    with store_lock(index_dir):
        recover_index_store(index_dir)
        try:
            ensure_sqlite_index(index_dir)
        except Exception as exc:
            log_warning(f"Ignoring unreadable previous index at {index_dir}: {describe_error(exc)}")
        if index_exists(index_dir):
            return
        legacy = legacy_index_path(root_path)
        if index_key(legacy) == index_key(index_dir) or not index_exists(legacy):
            return
        try:
            if same_root(read_store_root(legacy), root_path):
                import_index(legacy, index_dir, hide=is_within(index_dir, root_path))
        except Exception as exc:
            log_warning(f"Ignoring unreadable legacy index at {legacy}: {describe_error(exc)}")


def load_previous_meta(index_dir: Path, root_path: Path) -> dict[str, Any] | None:
    if not is_sqlite_index(index_dir):
        return None
    try:
        with open_index_db(index_dir) as conn:
            meta = read_meta(conn)
            conn.execute("SELECT 1 FROM files LIMIT 1").fetchall()
            conn.execute("SELECT 1 FROM chunks_fts LIMIT 1").fetchall()
    except Exception as exc:
        log_warning(f"Ignoring unreadable previous index at {index_dir}: {describe_error(exc)}")
        return None
    if meta.get("version") not in SUPPORTED_INDEX_VERSIONS or not same_root(meta.get("rootPath"), root_path):
        return None
    return meta


def load_previous_file_map(index_dir: Path) -> dict[str, dict[str, Any]]:
    try:
        return {item["relativePath"]: item for item in read_files(index_dir)}
    except Exception:
        return {}


def prepare_in_place_vectors(ctx: BuildContext, previous_meta: dict[str, Any] | None) -> None:
    """Drop vectors that belong to a different embedding model and note which files still
    need embeddings and which indexed files lack a document record. Stored vectors are kept
    while the knowledge base uses keyword search, so switching back doesn't re-embed."""
    writer = ctx.writer
    previous_meta = previous_meta or {}
    if ctx.vector_mode:
        vectors_usable = previous_meta.get("embeddingModelKey") == ctx.model_key
        if not vectors_usable and writer.has_vectors():
            writer.delete_all_vectors()
        ctx.missing_vectors = writer.paths_missing_vectors()
        ctx.embedding_dimension = writer.embedding_dimension()
    ctx.missing_documents = {
        row[0]
        for row in writer.conn.execute(
            "SELECT relative_path FROM files WHERE status = ? AND relative_path NOT IN (SELECT relative_path FROM documents)",
            (STATUS_INDEXED,),
        )
    }


def plan_files(ctx: BuildContext, discovered: list[DiscoveredFile]) -> list[FilePlan]:
    plans: list[FilePlan] = []
    max_bytes = ctx.build_options.max_file_size_bytes
    for position, item in enumerate(discovered):
        if position % 512 == 0:
            check_cancel(ctx, item.relative_path)
        previous_file = ctx.previous_files.get(item.relative_path)
        try:
            stat_result = item.stat if item.stat is not None else os.stat(item.path)
        except FileNotFoundError:
            plans.append(FilePlan(item, "vanished", previous_file))
            continue
        except OSError as exc:
            plans.append(FilePlan(item, "stat_error", previous_file, error=f"Could not read file: {exc.strerror or exc}"))
            continue
        size, mtime = stat_result.st_size, stat_result.st_mtime
        if item.skip_reason:
            plans.append(FilePlan(item, "excluded", previous_file, size, mtime, error=item.skip_reason))
            continue
        if size > max_bytes:
            plans.append(FilePlan(item, "too_large", previous_file, size, mtime))
            continue
        reusable = (
            ctx.in_place
            and previous_file is not None
            and previous_file.get("status") in {STATUS_INDEXED, STATUS_FAILED}
        )
        if reusable and is_unchanged_by_stat(previous_file, stat_result):
            plans.append(FilePlan(item, "unchanged", previous_file, size, mtime))
            continue
        previous_hash = previous_file.get("contentHash") if reusable else None
        plans.append(FilePlan(item, "work", previous_file, size, mtime, previous_hash=previous_hash))
    return plans


def apply_plan(ctx: BuildContext, plan: FilePlan, result: dict[str, Any] | None) -> tuple[FileRecord, str] | None:
    """Write the outcome for one file. Returns (record, statsCategory) or None if the file vanished."""
    writer = ctx.writer
    relative_path = plan.item.relative_path
    previous_file = plan.previous
    stat_result = SimpleNamespace(st_size=plan.size, st_mtime=plan.mtime)

    if plan.kind == "vanished":
        return None
    if plan.kind == "stat_error":
        record = failed_record(relative_path, None, None, plan.error or "Could not read file.")
        writer.replace_file(record.to_dict(), None, [], existed=ctx.in_place and previous_file is not None)
        return record, "failed"
    if plan.kind in {"too_large", "excluded"}:
        if plan.kind == "excluded":
            reason = plan.error
        else:
            reason = f"Larger than {format_megabytes(ctx.build_options.max_file_size_mb)} MB limit"
        record = FileRecord(
            relative_path=relative_path,
            status=STATUS_SKIPPED,
            size=plan.size,
            mtime=plan.mtime,
            parser="skipped",
            chunks=0,
            error_reason=reason,
        )
        if not ctx.in_place or previous_file != record.to_dict():
            writer.replace_file(record.to_dict(), None, [], existed=ctx.in_place and previous_file is not None)
        return record, "skipped"
    if plan.kind == "unchanged":
        record = reused_file_record(previous_file, stat_result)
        finish_reused_file(ctx, record, stat_result)
        return record, "unchanged"

    assert result is not None
    kind = result.get("kind")
    if kind == "vanished":
        return None
    if kind == "same":
        record = reused_file_record(previous_file, stat_result, content_hash=result.get("hash"))
        writer.update_file_stat(record.to_dict())
        finish_reused_file(ctx, record, stat_result)
        return record, "unchanged"
    if kind == "failed":
        record = failed_record(relative_path, stat_result, result.get("hash"), result.get("reason") or "Extraction failed.")
        writer.replace_file(record.to_dict(), None, [], existed=ctx.in_place and previous_file is not None)
        return record, "failed"

    file_hash = result["hash"]
    chunks = [new_chunk_entry(relative_path, index, payload, file_hash) for index, payload in enumerate(result["chunks"])]
    if ctx.vector_mode:
        embed_chunk_entries(ctx, chunks, relative_path)
    record = FileRecord(
        relative_path=relative_path,
        status=STATUS_INDEXED,
        size=plan.size,
        mtime=plan.mtime,
        parser=result["parser"],
        chunks=len(chunks),
        content_hash=file_hash,
    )
    writer.replace_file(record.to_dict(), result["document"], chunks, existed=ctx.in_place and previous_file is not None)
    return record, ("updated" if previous_file else "added")


def finish_reused_file(ctx: BuildContext, record: FileRecord, stat_result) -> None:
    """Embed chunks that have no vector yet and rebuild a missing document record."""
    relative_path = record.relative_path
    if ctx.vector_mode and relative_path in ctx.missing_vectors:
        rows = ctx.writer.chunks_missing_vectors(relative_path)
        if rows:
            entries = [{"rowId": row[0], "text": row[1], "chunkHash": row[2]} for row in rows]
            embed_chunk_entries(ctx, entries, relative_path)
            ctx.writer.insert_vectors([(entry["rowId"], *entry["quantized"]) for entry in entries if entry.get("quantized") is not None])
        if not ctx.embedding_error:
            ctx.missing_vectors.discard(relative_path)
    if relative_path in ctx.missing_documents and record.status == STATUS_INDEXED:
        chunks = ctx.writer.chunks_for_path(relative_path)
        document = build_document_record(
            relative_path,
            record.parser,
            stat_result,
            [chunk["text"] for chunk in chunks],
            record.content_hash,
            visual_assets=visual_assets_from_chunks(chunks),
        )
        ctx.writer.upsert_document(document)
        ctx.missing_documents.discard(relative_path)


def failed_record(relative_path: str, stat_result, file_hash: str | None, reason: str) -> FileRecord:
    return FileRecord(
        relative_path=relative_path,
        status=STATUS_FAILED,
        size=stat_result.st_size if stat_result is not None else 0,
        mtime=stat_result.st_mtime if stat_result is not None else 0,
        parser="unavailable",
        chunks=0,
        content_hash=file_hash,
        error_reason=reason,
    )


def new_chunk_entry(relative_path: str, chunk_index: int, chunk_payload: dict[str, Any], file_hash: str) -> dict[str, Any]:
    chunk_text = chunk_payload["text"]
    entry: dict[str, Any] = {
        "chunkId": f"{relative_path}:{chunk_index}:{uuid4().hex[:8]}",
        "relativePath": relative_path,
        "snippet": chunk_text[:240],
        "text": chunk_text,
        "chunkHash": hash_text(chunk_text),
        "fileHash": file_hash,
    }
    for key in ("chunkType", "sheetName", "visualAssets"):
        if chunk_payload.get(key):
            entry[key] = chunk_payload[key]
    if chunk_payload.get("rowNumber") is not None:
        entry["rowNumber"] = chunk_payload["rowNumber"]
    return entry


def embed_chunk_entries(ctx: BuildContext, entries: list[dict[str, Any]], relative_path: str) -> None:
    """Embed `entries`. If the provider fails (no credits, offline, rate limited, ...) the
    build carries on without vectors: chunks are still stored and keyword-searchable, and
    the error is reported to the caller. Cancelling still propagates."""
    if ctx.embedding_error:
        return
    embeddings.retry_notifier = lambda note: progress(
        ctx, "embedding", ctx.total_files, currentFile=relative_path, message=note
    )
    try:
        set_chunk_vectors(ctx, entries, relative_path)
    except EmbeddingError as exc:
        ctx.embedding_error = str(exc)
        log_warning(f"Embedding failed; finishing this sync with keyword search only: {exc}")
        # Tell the user now, not only when the sync ends.
        progress(
            ctx,
            "embedding",
            ctx.total_files,
            currentFile=relative_path,
            message="Embedding failed. Continuing with keyword search only.",
            warning=str(exc),
        )
    finally:
        embeddings.retry_notifier = None


def set_chunk_vectors(ctx: BuildContext, entries: list[dict[str, Any]], relative_path: str) -> None:
    """Set `quantized` on every entry: reuse a stored vector with the same chunk hash
    (same model; old rows of a changed file are still readable at this point), else embed."""
    pending: list[dict[str, Any]] = []
    duplicates_by_hash: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        if entry.get("quantized") is not None:
            continue
        chunk_hash = entry["chunkHash"]
        cached = ctx.writer.vector_for_hash(chunk_hash)
        if cached is not None:
            entry["quantized"] = cached
        elif chunk_hash in duplicates_by_hash:
            duplicates_by_hash[chunk_hash].append(entry)
        else:
            duplicates_by_hash[chunk_hash] = [entry]
            pending.append(entry)
    if not pending:
        return

    batch_size = embedding_batch_size(ctx.embedding_provider)
    total_batches = math.ceil(len(pending) / batch_size)
    done = 0
    for batch_index, batch in enumerate(batched(pending, batch_size), start=1):
        check_cancel(ctx, relative_path)
        progress(
            ctx,
            "embedding",
            ctx.total_files,
            currentFile=relative_path,
            message=f"Embedding batch {batch_index}/{total_batches} ({done + 1}-{done + len(batch)} of {len(pending)} new chunks).",
        )
        try:
            vectors = embed_texts(ctx.embedding_provider, [item["text"] for item in batch])
        except EmbeddingError:
            raise
        except Exception as exc:
            raise EmbeddingError(f"Embedding request failed: {describe_error(exc)}") from exc
        if len(vectors) != len(batch):
            raise EmbeddingError("Embedding provider returned an unexpected number of vectors.")
        for item, vector in zip(batch, vectors):
            quantized = quantize_vector(vector)
            if ctx.embedding_dimension and quantized[0] != ctx.embedding_dimension:
                raise EmbeddingError(
                    f"Embedding provider returned {quantized[0]} dimensions but the index has "
                    f"{ctx.embedding_dimension}; rebuild required."
                )
            ctx.embedding_dimension = quantized[0]
            for target in duplicates_by_hash.get(item["chunkHash"], (item,)):
                target["quantized"] = quantized
        done += len(batch)


def carry_over_unprocessed(ctx: BuildContext, remaining: list[DiscoveredFile]) -> None:
    """On retain-partial cancel, keep previous entries for files not processed yet if they
    are unchanged on disk. Everything else from the previous index is removed afterwards."""
    state = ctx.state
    for item in remaining:
        if item.relative_path in state.seen_paths or item.skip_reason:
            continue
        previous_file = ctx.previous_files.get(item.relative_path)
        if not previous_file or previous_file.get("status") not in {STATUS_INDEXED, STATUS_FAILED, STATUS_SKIPPED}:
            continue
        try:
            stat_result = os.stat(item.path)
        except OSError:
            continue
        if not is_unchanged_by_stat(previous_file, stat_result):
            continue
        if previous_file.get("status") == STATUS_SKIPPED:
            state.add(FileRecord(**file_record_kwargs(previous_file)), "skipped")
            continue
        if ctx.vector_mode and item.relative_path in ctx.missing_vectors:
            continue
        state.add(reused_file_record(previous_file, stat_result), "unchanged")


def remove_unseen(ctx: BuildContext) -> None:
    removed = [relative_path for relative_path in ctx.previous_files if relative_path not in ctx.state.seen_paths]
    ctx.state.stats["removed"] = len(removed)
    if ctx.in_place:
        for relative_path in removed:
            ctx.writer.delete_file(relative_path)


def commit_build(ctx: BuildContext, created_at: str, settings_dirty: bool) -> dict[str, Any]:
    writer = ctx.writer
    if ctx.in_place and not (settings_dirty or writer.dirty):
        writer.close()
        return read_manifest(ctx.index_dir)

    # "vector" in the meta means every chunk has a vector. A build whose embeddings failed is
    # recorded as keyword-only so semantic search is not served from a partial index.
    semantic = ctx.vector_mode and not ctx.embedding_error
    meta: dict[str, Any] = {
        "version": INDEX_VERSION,
        "rootPath": str(ctx.root_path),
        "createdAt": created_at,
        "updatedAt": utc_now(),
        "retrievalMode": "vector" if semantic else "vectorless",
        "indexEngine": ctx.retrieval["engine"] if semantic or not ctx.vector_mode else "manifest-first-lexical",
    }
    drop_keys: list[str] = []
    if writer.has_vectors():
        # Keep what was embedded (also while using keyword search) so switching back is free.
        meta["embeddingDimension"] = writer.embedding_dimension()
        previous_key = read_meta(writer.conn).get("embeddingModelKey") if ctx.in_place else None
        meta["embeddingModelKey"] = ctx.model_key if ctx.vector_mode else previous_key
        if not meta["embeddingModelKey"]:
            del meta["embeddingModelKey"]
    else:
        drop_keys = ["embeddingDimension", "embeddingModelKey"]
    writer.finish(meta, drop_keys)
    if not ctx.in_place:
        finalize_bulk_database(writer.conn)
    writer.close()
    if not ctx.in_place:
        temp_store = temp_index_path(ctx.index_dir)
        write_marker(temp_store)
        commit_temp_store(ctx.index_dir, hide=is_within(ctx.index_dir, ctx.root_path))
    clear_search_caches(ctx.index_dir)
    return read_manifest(ctx.index_dir)


def clear_search_caches(index_dir: Path) -> None:
    clear_index_cache(index_key(index_dir))
    clear_lexical_cache(index_dir)


def index_settings_changed(meta: dict[str, Any], retrieval: dict[str, Any], model_key: str | None) -> bool:
    if meta.get("version") != INDEX_VERSION:
        return True
    if meta.get("retrievalMode") != retrieval["mode"] or meta.get("indexEngine") != retrieval["engine"]:
        return True
    return retrieval["mode"] == "vector" and meta.get("embeddingModelKey") != model_key


def same_root(recorded: str | dict[str, Any] | None, root_path: Path) -> bool:
    if isinstance(recorded, dict):
        recorded = recorded.get("rootPath")
    if not recorded:
        return True
    return os.path.normcase(os.path.abspath(recorded)) == os.path.normcase(os.path.abspath(str(root_path)))


def log_warning(message: str) -> None:
    with _STDOUT_LOCK:
        print(message, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Parallel extraction
# ---------------------------------------------------------------------------


def extract_file_task(path_str: str, relative_path: str, previous_hash: str | None, size: int, mtime: float) -> dict[str, Any]:
    """Hash, extract and chunk one file. Runs in a worker process (or inline for small
    batches); returns only picklable data and never raises for per-file problems."""
    path = Path(path_str)
    file_hash: str | None = None
    try:
        file_hash = hash_file(path)
        if previous_hash is not None and file_hash == previous_hash:
            return {"kind": "same", "hash": file_hash}
        extracted = extract_document(path)
        parser_name = extracted["parser"]
        normalized = normalize_text(extracted.get("text") or "")
        if not normalized:
            raise ValueError("No extractable text found.")
        visual_assets = normalize_visual_assets(extracted.get("visualAssets") or [], relative_path)
        chunk_payloads = build_chunk_payloads(normalized, extracted.get("chunks") or [], visual_assets)
        if not chunk_payloads:
            raise ValueError("No extractable text chunks found.")
        document = build_document_record(
            relative_path,
            parser_name,
            SimpleNamespace(st_size=size, st_mtime=mtime),
            [chunk["text"] for chunk in chunk_payloads],
            file_hash,
            structure=extracted.get("structure"),
            visual_assets=visual_assets,
        )
        return {"kind": "extracted", "hash": file_hash, "parser": parser_name, "chunks": chunk_payloads, "document": document}
    except FileNotFoundError:
        if not fs_path(path).exists():
            return {"kind": "vanished"}
        return {"kind": "failed", "hash": file_hash, "reason": "File could not be opened."}
    except Exception as exc:
        return {"kind": "failed", "hash": file_hash, "reason": describe_error(exc)}


def _init_extraction_process(started=None) -> None:
    """Worker-process initializer: stdout belongs to the JSON protocol, so anything a
    parser prints (from Python or native code) is redirected to stderr. Signals `started`
    so the parent can tell a pool that never comes up from one that is merely busy."""
    try:
        if sys.stdout is not None:
            sys.stdout.flush()
        if sys.stderr is not None:
            os.dup2(sys.stderr.fileno(), 1)
    except (OSError, AttributeError, ValueError):
        pass
    if sys.stderr is not None:
        sys.stdout = sys.stderr
    if started is not None:
        started.set()


_CHILD_STD_HANDLES_READY = False


def prepare_child_std_handles() -> None:
    """Windows: spawned processes inherit the process-level standard handles. Our stdin is
    the protocol pipe, and the main thread sits in a blocking read on it; a child that
    inherits that pipe blocks during interpreter start-up until the next request arrives,
    so the pool would never start. Point the process-level stdin at nothing and stdout at
    stderr before spawning. The worker's own sys.stdin/sys.stdout use C runtime file
    descriptors that were bound at start-up, so the protocol is unaffected."""
    global _CHILD_STD_HANDLES_READY
    if _CHILD_STD_HANDLES_READY or os.name != "nt":
        return
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetStdHandle.argtypes = [ctypes.c_uint32]
    kernel32.GetStdHandle.restype = ctypes.c_void_p
    kernel32.SetStdHandle.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
    kernel32.SetStdHandle.restype = ctypes.c_int
    std_input, std_output, std_error = (-10 & 0xFFFFFFFF, -11 & 0xFFFFFFFF, -12 & 0xFFFFFFFF)
    kernel32.SetStdHandle(std_input, None)
    error_handle = kernel32.GetStdHandle(std_error)
    kernel32.SetStdHandle(std_output, error_handle)
    _CHILD_STD_HANDLES_READY = True


def create_extraction_pool(max_workers: int, started=None) -> ProcessPoolExecutor:
    prepare_child_std_handles()
    return ProcessPoolExecutor(
        max_workers=max_workers,
        mp_context=multiprocessing.get_context("spawn"),
        initializer=_init_extraction_process,
        initargs=(started,),
    )


def estimate_extraction_seconds(plan: FilePlan) -> float:
    if plan.item.path.suffix.lower() in HEAVY_EXTENSIONS:
        return HEAVY_EXTRACTION_SECONDS
    return 0.002 + plan.size / 40_000_000


def extract_batch_task(items: list[tuple]) -> list[dict[str, Any]]:
    return [extract_file_task(*args) for args in items]


class ExtractionPipeline:
    """Runs `extract_file_task` for the "work" plans in worker processes and hands results
    back strictly in plan order, so events stay ordered. Consecutive cheap files are sent
    as one batch (fewer IPC round trips); heavy files go alone. At most
    `max_workers * PREFETCH_PER_WORKER` batches are in flight, which bounds memory."""

    def __init__(self, plans: list[FilePlan], max_workers: int, check_cancel: Callable[[str | None], None]):
        self.plans = plans
        work = [index for index, plan in enumerate(plans) if plan.kind == "work"]
        self.max_workers = max(1, int(max_workers))
        estimates = {index: estimate_extraction_seconds(plans[index]) for index in work}
        self.parallel = self.max_workers > 1 and len(work) >= 2 and sum(estimates.values()) >= PARALLEL_MIN_ESTIMATED_SECONDS
        self.window = self.max_workers * PREFETCH_PER_WORKER
        self.check_cancel = check_cancel
        self.batches: list[list[int]] = []
        self.batch_of: dict[int, int] = {}
        current: list[int] = []
        current_cost = 0.0
        for index in work:
            cost = estimates[index]
            if current and (len(current) >= BATCH_MAX_FILES or current_cost + cost > BATCH_MAX_SECONDS):
                self._add_batch(current)
                current, current_cost = [], 0.0
            current.append(index)
            current_cost += cost
        if current:
            self._add_batch(current)
        self.pending: deque[int] = deque(range(len(self.batches)))
        self.futures: dict[int, Future] = {}
        self.ready: dict[int, dict[str, Any]] = {}
        self.crashes: dict[int, int] = {}
        self.executor: ProcessPoolExecutor | None = None
        self.restarts = 0
        self.batch_task: Callable[[list[tuple]], list[dict[str, Any]]] = extract_batch_task
        self.started: Any = None
        self.started_at = 0.0

    def _add_batch(self, indices: list[int]) -> int:
        number = len(self.batches)
        self.batches.append(list(indices))
        for index in indices:
            self.batch_of[index] = number
        return number

    def _task_args(self, index: int) -> tuple:
        plan = self.plans[index]
        return (str(plan.item.path), plan.item.relative_path, plan.previous_hash, plan.size, plan.mtime)

    def _restart(self, count_failure: bool = True) -> None:
        """Drop a broken pool and requeue every batch that was in flight. A timeout is a slow
        file, not a broken pool, so it doesn't count toward giving up on the pool."""
        in_flight = sorted(self.futures)
        self.futures.clear()
        self._shutdown(terminate=True)
        self.pending.extendleft(reversed(in_flight))
        if count_failure:
            self.restarts += 1
        if self.restarts > MAX_POOL_RESTARTS:
            log_warning("Extraction worker processes keep failing; continuing in the main process.")
            self.parallel = False

    def _fill(self) -> None:
        while self.parallel and self.pending and len(self.futures) < self.window:
            number = self.pending[0]
            try:
                if self.executor is None:
                    self.started = multiprocessing.get_context("spawn").Event()
                    self.started_at = time.monotonic()
                    self.executor = create_extraction_pool(self.max_workers, started=self.started)
                future = self.executor.submit(self.batch_task, [self._task_args(index) for index in self.batches[number]])
            except (BrokenProcessPool, OSError, RuntimeError) as exc:
                log_warning(f"Extraction worker pool failed: {describe_error(exc)}")
                self._restart()
                continue
            self.pending.popleft()
            self.futures[number] = future

    def result_for(self, index: int) -> dict[str, Any]:
        while True:
            if index in self.ready:
                return self.ready.pop(index)
            self._fill()
            if not self.parallel:
                return extract_file_task(*self._task_args(index))
            number = self.batch_of[index]
            future = self.futures.pop(number)
            batch_started = time.monotonic()
            time_limit = SINGLE_FILE_TIMEOUT_SECONDS if len(self.batches[number]) == 1 else BATCH_TIMEOUT_SECONDS
            timed_out = False
            try:
                while True:
                    try:
                        results = future.result(timeout=FUTURE_POLL_SECONDS)
                        break
                    except FuturesTimeoutError:
                        self.check_cancel(self.plans[index].item.relative_path)
                        if self._failed_to_start():
                            raise BrokenProcessPool("No extraction worker process started.")
                        if time.monotonic() - batch_started >= time_limit:
                            timed_out = True
                            raise BrokenProcessPool("Extraction batch timed out.")
            except BrokenProcessPool:
                # A worker died or hung. Restart the pool and retry: a batch is split into
                # single files, and a single file that times out or takes the pool down twice
                # is marked failed.
                self._restart(count_failure=not timed_out)
                batch = self.batches[number]
                if len(batch) > 1:
                    singles = [self._add_batch([item]) for item in batch]
                    self.pending.extendleft(reversed(singles))
                    continue
                if timed_out:
                    return {
                        "kind": "failed",
                        "hash": None,
                        "reason": f"Timed out after {int(time_limit)} s while extracting file.",
                    }
                self.crashes[number] = self.crashes.get(number, 0) + 1
                if self.crashes[number] >= 2:
                    return {"kind": "failed", "hash": None, "reason": "The extraction process crashed on this file."}
                self.pending.appendleft(number)
                continue
            for item, result in zip(self.batches[number], results):
                self.ready[item] = result
            self._fill()

    def _failed_to_start(self) -> bool:
        if self.started is None or self.started.is_set():
            return False
        if time.monotonic() - self.started_at < POOL_START_TIMEOUT_SECONDS:
            return False
        log_warning("Extraction worker processes did not start; continuing in the main process.")
        self.restarts = MAX_POOL_RESTARTS
        return True

    def _shutdown(self, terminate: bool) -> None:
        executor, self.executor = self.executor, None
        if executor is None:
            return
        if terminate:
            processes = list((getattr(executor, "_processes", None) or {}).values())
            executor.shutdown(wait=False, cancel_futures=True)
            for process in processes:
                try:
                    process.terminate()
                except Exception:
                    pass
            for process in processes:
                try:
                    process.join(timeout=2)
                except Exception:
                    pass
        else:
            executor.shutdown(wait=True)

    def close(self, cancel: bool = False) -> None:
        busy = bool(self.futures)
        self.futures.clear()
        self.pending.clear()
        self.ready.clear()
        self._shutdown(terminate=cancel or busy)


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


INCLUDE_EXT_GLOB_RE = re.compile(r"^(?:\*\*/)?\*\.([A-Za-z0-9_-]+)$")


def resolve_build_options(options: dict[str, Any]) -> BuildOptions:
    raw_patterns = [str(item).strip() for item in options.get("excludePatterns") or [] if str(item).strip()]
    exclude_patterns: list[re.Pattern[str]] = []
    exclude_labels: list[str] = []
    include_ext_patterns: list[re.Pattern[str]] = []
    include_name_patterns: list[re.Pattern[str]] = []
    for raw in raw_patterns:
        if raw.startswith("#"):
            continue
        if raw.startswith("!"):
            inner = raw[1:].strip()
            if not inner:
                continue
            compiled = compile_glob(inner)
            if INCLUDE_EXT_GLOB_RE.match(inner.replace("\\", "/").lstrip("/")):
                include_ext_patterns.append(compiled)
            else:
                include_name_patterns.append(compiled)
        else:
            exclude_patterns.append(compile_glob(raw))
            exclude_labels.append(raw)
    max_size = options.get("maxFileSizeMb")
    try:
        max_size_mb = float(max_size) if max_size is not None else DEFAULT_MAX_FILE_SIZE_MB
    except (TypeError, ValueError):
        max_size_mb = DEFAULT_MAX_FILE_SIZE_MB
    if max_size_mb <= 0:
        max_size_mb = DEFAULT_MAX_FILE_SIZE_MB
    try:
        max_workers = int(options["maxWorkers"]) if options.get("maxWorkers") is not None else default_max_workers()
    except (TypeError, ValueError):
        max_workers = default_max_workers()
    return BuildOptions(
        exclude_patterns=exclude_patterns,
        exclude_labels=exclude_labels,
        include_ext_patterns=include_ext_patterns,
        include_name_patterns=include_name_patterns,
        max_file_size_mb=max_size_mb,
        include_hidden=bool(options.get("includeHidden", False)),
        max_workers=min(max(max_workers, 1), MAX_WORKERS_LIMIT),
    )


def compile_glob(pattern: str) -> re.Pattern[str]:
    """Translate a gitignore-style glob to a regex over POSIX relative paths.
    `**` spans directories, `*`/`?` stay within one segment. Patterns without a `/`
    match the basename at any depth. Matching is case-insensitive."""
    normalized = pattern.replace("\\", "/").lstrip("/")
    if "/" not in normalized.rstrip("/"):
        normalized = "**/" + normalized
    if normalized.endswith("/"):
        normalized += "**"
    parts: list[str] = []
    index = 0
    while index < len(normalized):
        char = normalized[index]
        if normalized.startswith("**/", index):
            parts.append("(?:.*/)?")
            index += 3
            continue
        if normalized.startswith("**", index):
            parts.append(".*")
            index += 2
            continue
        if char == "*":
            parts.append("[^/]*")
        elif char == "?":
            parts.append("[^/]")
        elif char == "[":
            closing = normalized.find("]", index + 1)
            if closing == -1:
                parts.append(re.escape(char))
            else:
                body = normalized[index + 1 : closing]
                if body.startswith("!"):
                    body = "^" + body[1:]
                parts.append(f"[{body}]")
                index = closing + 1
                continue
        else:
            parts.append(re.escape(char))
        index += 1
    return re.compile("".join(parts) + r"\Z", re.IGNORECASE | re.DOTALL)


def matches_exclude(relative_posix: str, patterns: list[re.Pattern[str]]) -> bool:
    return any(pattern.match(relative_posix) for pattern in patterns)


def first_matching_label(relative_posix: str, patterns: list[re.Pattern[str]], labels: list[str]) -> str | None:
    for pattern, label in zip(patterns, labels):
        if pattern.match(relative_posix):
            return label
    return None


def directory_exclusion_reason(relative_posix: str, options: BuildOptions) -> str | None:
    for candidate in (relative_posix, relative_posix + "/"):
        label = first_matching_label(candidate, options.exclude_patterns, options.exclude_labels)
        if label:
            return f"Excluded by rule: {label}"
    return None


def file_exclusion_reason(relative_posix: str, options: BuildOptions) -> str | None:
    label = first_matching_label(relative_posix, options.exclude_patterns, options.exclude_labels)
    if label:
        return f"Excluded by rule: {label}"
    # Include filters are a union: a file is kept when it matches a chosen type OR a chosen name.
    if options.include_ext_patterns or options.include_name_patterns:
        if not matches_exclude(relative_posix, options.include_ext_patterns) and not matches_exclude(
            relative_posix, options.include_name_patterns
        ):
            if options.include_ext_patterns and options.include_name_patterns:
                return "Not one of the file types or names to include"
            if options.include_ext_patterns:
                return "Not one of the file types to include"
            return "Name doesn't match the include filters"
    return None


def path_key(path: Path | str) -> str:
    return os.path.normcase(os.path.abspath(str(path)))


def has_hidden_attribute(lstat_result) -> bool:
    attributes = getattr(lstat_result, "st_file_attributes", 0) or 0
    return bool(attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM))


def discover_files(
    root_path: Path,
    build_options: BuildOptions | None = None,
    index_path: Path | None = None,
    on_progress: Callable[[int], Any] | None = None,
    skipped: list[DiscoveredFile] | None = None,
) -> list[DiscoveredFile]:
    """Walk the root with os.scandir. On Windows the directory listing already carries
    size/mtime/attributes, so a no-change sync needs no per-file system calls; the stat is
    kept on each DiscoveredFile and reused by the build planner.

    Files the user's exclude/include rules leave out (including everything under an excluded
    folder) are not returned; when `skipped` is given they are appended to it with a
    `skip_reason`. Built-in ignores (.git, hidden files, ...) are never listed."""
    options = build_options or BuildOptions(max_file_size_mb=DEFAULT_MAX_FILE_SIZE_MB)
    root = Path(os.path.abspath(root_path))
    try:
        resolved_root = root.resolve()
    except OSError:
        resolved_root = root
    excluded_dirs: set[str] = set()
    if index_path is not None:
        for candidate in (index_path, temp_index_path(index_path), old_index_path(index_path)):
            excluded_dirs.add(path_key(candidate))
            try:
                excluded_dirs.add(path_key(candidate.resolve()))
            except OSError:
                pass

    files: list[DiscoveredFile] = []
    stack: list[tuple[str, str, str | None]] = [(str(root), "", None)]
    while stack:
        directory, relative_dir, dir_reason = stack.pop()
        try:
            with os.scandir(directory) as iterator:
                entries = list(iterator)
        except OSError:
            continue
        subdirectories: list[tuple[str, str, str | None]] = []
        for entry in entries:
            name = entry.name
            relative = os.path.join(relative_dir, name) if relative_dir else name
            relative_posix = relative.replace(os.sep, "/") if os.sep != "/" else relative
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if is_dir:
                if not should_skip_directory_entry(entry, name, options, excluded_dirs):
                    reason = dir_reason or directory_exclusion_reason(relative_posix, options)
                    # An excluded folder is walked only to list its files as skipped.
                    if reason is None or skipped is not None:
                        subdirectories.append((entry.path, relative, reason))
                continue
            stat_result = file_entry_stat(entry, name, options, resolved_root)
            if stat_result is None:
                continue
            reason = dir_reason or file_exclusion_reason(relative_posix, options)
            if reason is not None:
                if skipped is not None and len(skipped) < MAX_RULE_SKIPPED_FILES:
                    skipped.append(DiscoveredFile(path=Path(entry.path), relative_path=relative, stat=stat_result, skip_reason=reason))
                continue
            files.append(DiscoveredFile(path=Path(entry.path), relative_path=relative, stat=stat_result))
            if on_progress and (len(files) == 1 or len(files) % 25 == 0):
                on_progress(len(files))
        stack.extend(reversed(subdirectories))
    files.sort(key=lambda item: item.relative_path.lower())
    return files


def entry_is_link_or_junction(entry: os.DirEntry, lstat_result) -> bool:
    if entry.is_symlink():
        return True
    is_junction = getattr(entry, "is_junction", None)
    if is_junction is not None and is_junction():
        return True
    return getattr(lstat_result, "st_reparse_tag", 0) == IO_REPARSE_TAG_MOUNT_POINT


def should_skip_directory_entry(
    entry: os.DirEntry,
    name: str,
    options: BuildOptions,
    excluded_dirs: set[str],
) -> bool:
    if name.lower() in IGNORED_DIR_NAMES:
        return True
    if not options.include_hidden and name.startswith("."):
        return True
    if excluded_dirs and path_key(entry.path) in excluded_dirs:
        return True
    try:
        lstat_result = entry.stat(follow_symlinks=False)
    except OSError:
        return True
    # Never descend into symlinked/junction directories: avoids cycles, duplicates and escaping the root.
    if entry_is_link_or_junction(entry, lstat_result):
        return True
    if not options.include_hidden and has_hidden_attribute(lstat_result):
        return True
    return False


def file_entry_stat(entry: os.DirEntry, name: str, options: BuildOptions, resolved_root: Path):
    """The file's stat result, or None for files that are never listed (built-in ignores,
    hidden files, unreadable entries, links leaving the root). The user's rules are applied
    by the caller."""
    lowered = name.lower()
    if lowered in IGNORED_FILE_NAMES or name.startswith("~$"):
        return None
    if not options.include_hidden and name.startswith("."):
        return None
    try:
        lstat_result = entry.stat(follow_symlinks=False)
    except OSError:
        return None
    if not options.include_hidden and has_hidden_attribute(lstat_result):
        return None
    if entry_is_link_or_junction(entry, lstat_result):
        full = Path(entry.path)
        try:
            target = full.resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        if not is_within(target, resolved_root) or not target.is_file():
            return None
        try:
            return os.stat(full)
        except OSError:
            return None
    if not stat_module.S_ISREG(lstat_result.st_mode):
        return None
    return lstat_result


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


def search_index(
    root_path: Path,
    query: str,
    top_k: int,
    options: dict,
    index_path: Path | None = None,
) -> list[dict[str, Any]]:
    index_dir = index_path or resolve_index_path(root_path)
    retrieval = resolve_retrieval_options(options)
    with open_index_db(index_dir) as conn:
        meta = read_meta(conn)
        if meta.get("version") not in SUPPORTED_INDEX_VERSIONS:
            raise ValueError("Unsupported index version.")
        if retrieval["mode"] == "vector" and (meta.get("retrievalMode") or "vector") != "vector":
            # Keyword search can be served from any index; semantic search needs every chunk embedded.
            raise ValueError("Semantic search is not available for this index yet; sync to finish embedding.")
        if top_k <= 0 or not conn.execute("SELECT EXISTS(SELECT 1 FROM chunks)").fetchone()[0]:
            return []
        if retrieval["mode"] == "vectorless":
            return lexical_search_conn(conn, index_dir, str(meta.get("dataVersion") or ""), query, top_k, set(retrieval.get("documentIds") or []))

    embedding_provider = options.get("embeddingProvider") or {}
    if not embedding_provider:
        raise ValueError("Embedding provider configuration is required for search.")
    query_model_key = build_embedding_model_key(embedding_provider)
    index_model_key = meta.get("embeddingModelKey")
    if index_model_key and index_model_key != query_model_key:
        raise ValueError(
            f"Index was built with {describe_model_key(index_model_key)} but search uses "
            f"{describe_model_key(query_model_key)}; rebuild required."
        )

    # The query is embedded without holding the index open (it is a network call).
    query_embedding = np.asarray(embed_query(embedding_provider, query), dtype=np.float32)
    query_norm = np.linalg.norm(query_embedding)
    if query_norm == 0:
        return []
    with open_index_db(index_dir) as conn:
        data_version = str(read_meta(conn).get("dataVersion") or "")
        matrix = load_vector_matrix(conn, index_key(index_dir), data_version)
        if matrix is None:
            return []
        scores = cosine_scores(matrix, query_embedding / query_norm)
        limit = min(int(top_k), int(scores.shape[0]))
        if limit <= 0:
            return []
        if limit == scores.shape[0]:
            top_rows = np.argsort(-scores, kind="stable")
        else:
            candidates = np.argpartition(scores, -limit)[-limit:]
            top_rows = candidates[np.argsort(-scores[candidates], kind="stable")]
        ranked = [(int(matrix.chunk_ids[row]), max(0.0, float(scores[row]))) for row in top_rows.tolist()]
        chunks = fetch_chunks(conn, [chunk_id for chunk_id, _ in ranked])
    return [search_result(chunks[chunk_id], score) for chunk_id, score in ranked if chunk_id in chunks]


def fetch_chunks(conn: sqlite3.Connection, chunk_ids: list[int]) -> dict[int, dict[str, Any]]:
    if not chunk_ids:
        return {}
    rows = conn.execute(
        f"SELECT {CHUNK_COLUMNS} FROM chunks WHERE id IN (SELECT value FROM json_each(?))", (json.dumps(chunk_ids),)
    )
    return {row[0]: chunk_from_row(row) for row in rows}


def describe_model_key(model_key: str) -> str:
    parts = model_key.split("|")
    provider = parts[0] if parts else ""
    model = (parts[4] if len(parts) > 4 else "") or (parts[3] if len(parts) > 3 else "")
    label = "/".join(part for part in (provider, model) if part)
    return label or "an unknown embedding model"


def search_result(chunk: dict[str, Any], score: float) -> dict[str, Any]:
    item = {
        "chunkId": chunk["chunkId"],
        "relativePath": chunk["relativePath"],
        "score": score,
        "snippet": chunk["snippet"],
        "text": chunk["text"],
    }
    for key in ("chunkType", "sheetName", "visualAssets"):
        if chunk.get(key):
            item[key] = chunk[key]
    if chunk.get("rowNumber") is not None:
        item["rowNumber"] = chunk["rowNumber"]
    return item


_TOKEN_PATTERN = re.compile(r"[^\W_]+")


def tokenize(text: str) -> list[str]:
    """Unicode-aware word tokens: casefolded, split on non-word chars (and `_`), length >= 2, numbers kept."""
    return [token for token in _TOKEN_PATTERN.findall((text or "").casefold()) if len(token) >= 2]


def fts_match_expression(query: str) -> str | None:
    """Build a safe FTS5 MATCH expression: every word (letters/digits only, length >= 2)
    becomes a quoted string, OR-ed together (BM25 over any matching term, like before).
    Operators and syntax characters in user input (`"`, `*`, `-`, `:`, `^`, parentheses,
    NEAR/AND/OR/NOT) never reach FTS5 unquoted."""
    terms: list[str] = []
    seen: set[str] = set()
    for word in _TOKEN_PATTERN.findall(query or ""):
        key = word.casefold()
        if len(key) < 2 or key in seen:
            continue
        seen.add(key)
        terms.append('"' + word.replace('"', '""') + '"')
        if len(terms) >= MAX_QUERY_TERMS:
            break
    return " OR ".join(terms) if terms else None


@dataclass
class PathTokenIndex:
    data_version: str
    postings: dict[str, list[str]]


def clear_lexical_cache(index_dir: Path | None = None) -> None:
    with _LEXICAL_LOCK:
        if index_dir is None:
            _PATH_TOKEN_CACHE.clear()
        else:
            _PATH_TOKEN_CACHE.pop(index_key(index_dir), None)


def load_path_tokens(conn: sqlite3.Connection, index_dir: Path, data_version: str) -> PathTokenIndex:
    """token -> paths, from `files` (one entry per file rather than per chunk); cached per data version."""
    cache_key = index_key(index_dir)
    with _LEXICAL_LOCK:
        cached = _PATH_TOKEN_CACHE.get(cache_key)
        if cached is not None and cached.data_version == data_version and data_version:
            return cached
    postings: dict[str, list[str]] = {}
    for (relative_path,) in conn.execute("SELECT relative_path FROM files WHERE chunks > 0"):
        for token in set(tokenize(relative_path)):
            postings.setdefault(token, []).append(relative_path)
    index = PathTokenIndex(data_version, postings)
    with _LEXICAL_LOCK:
        _PATH_TOKEN_CACHE[cache_key] = index
        while len(_PATH_TOKEN_CACHE) > _PATH_TOKEN_CACHE_LIMIT:
            _PATH_TOKEN_CACHE.pop(next(iter(_PATH_TOKEN_CACHE)))
    return index


def lexical_search(index_dir: Path, query: str, top_k: int, selected_document_ids: set[str]) -> list[dict[str, Any]]:
    with open_index_db(index_dir) as conn:
        data_version = str(read_meta(conn).get("dataVersion") or "")
        return lexical_search_conn(conn, index_dir, data_version, query, top_k, selected_document_ids)


def lexical_search_conn(
    conn: sqlite3.Connection,
    index_dir: Path,
    data_version: str,
    query: str,
    top_k: int,
    selected_document_ids: set[str],
) -> list[dict[str, Any]]:
    """FTS5 BM25 (higher = better) plus the path bonus (+0.75 per query token found in the
    file path) and the visual bonus (+1.5 for chunks with visual assets when the query asks
    for charts/images). Text candidates are the best `max(200, 25 * topK)` BM25 hits."""
    top_k = max(int(top_k), 0)
    if top_k == 0:
        return []
    query_tokens = set(tokenize(query))
    visual_query = any(token in VISUAL_QUERY_TOKENS for token in query_tokens)
    selected_json = json.dumps(sorted(selected_document_ids)) if selected_document_ids else None

    # chunk id -> [text score, relative path, has visual]
    candidates: dict[int, list[Any]] = {}
    match = fts_match_expression(query)
    if match:
        # FTS5 ranks (bm25, lower = better) and limits on its own; only the best candidates
        # are joined to `chunks`. The documentIds filter is applied before the limit.
        inner = "SELECT rowid, rank FROM chunks_fts WHERE chunks_fts MATCH ?"
        params: list[Any] = [match]
        if selected_json is not None:
            inner += " AND rowid IN (SELECT id FROM chunks WHERE relative_path IN (SELECT value FROM json_each(?)))"
            params.append(selected_json)
        inner += " ORDER BY rank LIMIT ?"
        params.append(max(MIN_TEXT_CANDIDATES, top_k * 25))
        sql = f"SELECT c.id, c.relative_path, c.has_visual, -f.rank FROM ({inner}) f JOIN chunks c ON c.id = f.rowid"
        for chunk_id, relative_path, has_visual, score in conn.execute(sql, params):
            candidates[chunk_id] = [float(score), relative_path, has_visual]

    bonus: dict[str, float] = {}
    if query_tokens:
        path_index = load_path_tokens(conn, index_dir, data_version)
        for token in query_tokens:
            for relative_path in path_index.postings.get(token, ()):
                if selected_document_ids and relative_path not in selected_document_ids:
                    continue
                bonus[relative_path] = bonus.get(relative_path, 0.0) + PATH_MATCH_BOOST
    visual_weight = VISUAL_ASSET_BOOST if visual_query else 0.0
    extra_limit = top_k + len(candidates)
    if bonus:
        rows = conn.execute(
            "SELECT c.id, c.relative_path, c.has_visual FROM json_each(?) j JOIN chunks c ON c.relative_path = j.key "
            "ORDER BY j.value + c.has_visual * ? DESC, c.id LIMIT ?",
            (json.dumps(bonus), visual_weight, extra_limit),
        )
        for chunk_id, relative_path, has_visual in rows:
            candidates.setdefault(chunk_id, [0.0, relative_path, has_visual])
    if visual_query:
        sql = "SELECT id, relative_path, has_visual FROM chunks WHERE has_visual = 1"
        params = []
        if selected_json is not None:
            sql += " AND relative_path IN (SELECT value FROM json_each(?))"
            params.append(selected_json)
        sql += " ORDER BY id LIMIT ?"
        params.append(extra_limit + len(bonus))
        for chunk_id, relative_path, has_visual in conn.execute(sql, params):
            candidates.setdefault(chunk_id, [0.0, relative_path, has_visual])

    ranked = sorted(
        (
            (text_score + bonus.get(relative_path, 0.0) + (visual_weight if has_visual else 0.0), chunk_id)
            for chunk_id, (text_score, relative_path, has_visual) in candidates.items()
        ),
        key=lambda item: (-item[0], item[1]),
    )
    ranked = [(score, chunk_id) for score, chunk_id in ranked if score > 0][:top_k]
    chunks = fetch_chunks(conn, [chunk_id for _, chunk_id in ranked])
    return [search_result(chunks[chunk_id], float(score)) for score, chunk_id in ranked if chunk_id in chunks]


# ---------------------------------------------------------------------------
# Visual assets
# ---------------------------------------------------------------------------


def resolve_visual_assets(root_path: Path, assets: list[dict[str, Any]], max_assets: int) -> list[dict[str, Any]]:
    resolved: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for asset in assets:
        if len(resolved) >= max(max_assets, 0):
            break
        if not isinstance(asset, dict):
            continue
        key = (
            asset.get("kind"),
            asset.get("relativePath"),
            asset.get("pageNumber"),
            asset.get("imageIndex"),
            asset.get("mediaPath"),
        )
        if key in seen:
            continue
        seen.add(key)
        try:
            image_bytes = resolve_visual_asset_bytes(root_path, asset)
            if not image_bytes:
                continue
            mime_type, data_base64 = encode_visual_image(image_bytes)
            resolved.append({"asset": asset, "mimeType": mime_type, "dataBase64": data_base64})
        except Exception:
            continue
    return resolved


def resolve_visual_asset_bytes(root_path: Path, asset: dict[str, Any]) -> bytes:
    source_path = safe_source_path(root_path, str(asset.get("relativePath") or ""))
    kind = str(asset.get("kind") or "")

    if kind in {"pdf-page", "pdf-image"}:
        fitz = load_fitz()
    if kind == "pdf-page":
        if fitz is None:
            return b""
        page_number = int(asset.get("pageNumber") or 0)
        if page_number <= 0:
            return b""
        with fitz.open(source_path) as document:
            if page_number > len(document):
                return b""
            page = document[page_number - 1]
            pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            return pixmap.tobytes("png")

    if kind == "pdf-image":
        if fitz is None:
            return b""
        page_number = int(asset.get("pageNumber") or 0)
        image_index = int(asset.get("imageIndex") or 0)
        if page_number <= 0 or image_index <= 0:
            return b""
        with fitz.open(source_path) as document:
            if page_number > len(document):
                return b""
            images = document[page_number - 1].get_images(full=True)
            if image_index > len(images):
                return b""
            image = document.extract_image(images[image_index - 1][0])
            return image.get("image") or b""

    if kind == "docx-image":
        media_path = str(asset.get("mediaPath") or "")
        if not media_path.startswith("word/media/"):
            return b""
        with zipfile.ZipFile(source_path) as archive:
            return archive.read(media_path)

    if kind == "image-file":
        return source_path.read_bytes()

    return b""


def safe_source_path(root_path: Path, relative_path: str) -> Path:
    root = root_path.resolve()
    candidate = (root / relative_path).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("Visual asset path is outside the indexed root.")
    if not candidate.exists() or not candidate.is_file():
        raise FileNotFoundError("Visual asset source file not found.")
    return candidate


def encode_visual_image(image_bytes: bytes) -> tuple[str, str]:
    if Image is None:
        return "image/png", base64.b64encode(image_bytes).decode("ascii")
    with Image.open(io.BytesIO(image_bytes)) as image:
        prepared = resize_image_for_vision(image).convert("RGB")
        output = io.BytesIO()
        prepared.save(output, format="JPEG", quality=85, optimize=True)
        return "image/jpeg", base64.b64encode(output.getvalue()).decode("ascii")


def resize_image_for_vision(image):
    if Image is None:
        return image

    width, height = image.size
    longest_edge = max(width, height)
    pixel_count = width * height
    if longest_edge <= VISION_MAX_IMAGE_EDGE and pixel_count <= VISION_MAX_IMAGE_PIXELS:
        return image

    edge_scale = VISION_MAX_IMAGE_EDGE / max(longest_edge, 1)
    pixel_scale = (VISION_MAX_IMAGE_PIXELS / max(pixel_count, 1)) ** 0.5
    scale = min(edge_scale, pixel_scale, 1.0)
    if scale >= 1.0:
        return image

    new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
    resampling_module = getattr(Image, "Resampling", Image)
    return image.resize(new_size, resampling_module.LANCZOS)


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

_SENTENCE_END = re.compile(r"[.!?。！？][\"')\]]*\s")


def find_break(segment: str) -> int | None:
    """Return the offset just after the best boundary in `segment`: paragraph, then line, then sentence."""
    paragraph = segment.rfind("\n\n")
    if paragraph != -1:
        return paragraph + 2
    line = segment.rfind("\n")
    if line != -1:
        return line + 1
    last_sentence = None
    for match in _SENTENCE_END.finditer(segment):
        last_sentence = match.end()
    return last_sentence


def split_text(text: str, chunk_size: int = 1200, overlap: int = 200, boundary_window: float = 0.25) -> list[str]:
    chunks: list[str] = []
    cursor = 0
    length = len(text)
    search_span = max(1, int(chunk_size * boundary_window))
    while cursor < length:
        end = min(cursor + chunk_size, length)
        if end < length:
            window_start = end - search_span
            offset = find_break(text[window_start:end])
            if offset is not None and window_start + offset > cursor + overlap:
                end = window_start + offset
        window = text[cursor:end].strip()
        if window:
            chunks.append(window)
        if end >= length:
            break
        cursor = max(end - overlap, cursor + 1)
    return chunks


def build_chunk_payloads(
    normalized_text: str,
    structured_chunks: list[dict[str, Any]],
    visual_assets: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    visual_assets = visual_assets or []
    if structured_chunks:
        payloads: list[dict[str, Any]] = []
        for item in structured_chunks:
            text = normalize_text(str(item.get("text") or ""))
            if not text:
                continue
            payload: dict[str, Any] = {"text": text}
            if item.get("chunkType"):
                payload["chunkType"] = str(item["chunkType"])
            if item.get("sheetName"):
                payload["sheetName"] = str(item["sheetName"])
            if item.get("rowNumber") is not None:
                payload["rowNumber"] = int(item["rowNumber"])
            if item.get("visualAssets"):
                payload["visualAssets"] = list(item["visualAssets"])
            payloads.append(payload)
        if payloads:
            return payloads
    return [
        {"text": chunk, **({"visualAssets": assets} if (assets := visual_assets_for_chunk(chunk, visual_assets)) else {})}
        for chunk in split_text(normalized_text)
    ]


def normalize_visual_assets(assets: list[dict[str, Any]], relative_path: str) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        label = str(asset.get("label") or "").strip()
        kind = str(asset.get("kind") or "").strip()
        if not label or not kind:
            continue
        item = dict(asset)
        item["relativePath"] = relative_path
        normalized.append(item)
    return normalized


def visual_assets_for_chunk(chunk_text: str, visual_assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    matched: list[dict[str, Any]] = []
    for asset in visual_assets:
        anchor = str(asset.get("anchorText") or "").strip()
        if anchor and anchor in chunk_text:
            matched.append(asset)
    return matched


def visual_assets_from_chunks(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    assets: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for chunk in chunks:
        for asset in chunk.get("visualAssets") or []:
            if not isinstance(asset, dict):
                continue
            key = visual_asset_key(asset)
            if key in seen:
                continue
            seen.add(key)
            assets.append(asset)
    return assets


def visual_asset_key(asset: dict[str, Any]) -> tuple[Any, ...]:
    return (
        asset.get("kind"),
        asset.get("relativePath"),
        asset.get("pageNumber"),
        asset.get("imageIndex"),
        asset.get("mediaPath"),
        asset.get("label"),
    )


# ---------------------------------------------------------------------------
# Reuse helpers
# ---------------------------------------------------------------------------


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with fs_path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def format_megabytes(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:g}"


def is_unchanged_by_stat(previous_file: dict[str, Any], stat_result) -> bool:
    return previous_file.get("size") == stat_result.st_size and previous_file.get("mtime") == stat_result.st_mtime


def file_record_kwargs(previous_file: dict[str, Any]) -> dict[str, Any]:
    return {
        "relative_path": previous_file["relativePath"],
        "status": previous_file["status"],
        "size": int(previous_file.get("size", 0)),
        "mtime": previous_file.get("mtime", 0),
        "parser": previous_file.get("parser", "reused"),
        "chunks": int(previous_file.get("chunks", 0)),
        "content_hash": previous_file.get("contentHash"),
        "error_reason": previous_file.get("errorReason"),
    }


def reused_file_record(previous_file: dict[str, Any], stat_result, content_hash: str | None = None) -> FileRecord:
    kwargs = file_record_kwargs(previous_file)
    kwargs.update(size=stat_result.st_size, mtime=stat_result.st_mtime, content_hash=content_hash or kwargs["content_hash"])
    return FileRecord(**kwargs)



def build_embedding_model_key(embedding_provider: dict[str, Any]) -> str:
    return "|".join(
        [
            str(embedding_provider.get("provider") or ""),
            str(embedding_provider.get("baseUrl") or ""),
            str(embedding_provider.get("apiVersion") or ""),
            str(embedding_provider.get("deployment") or ""),
            str(embedding_provider.get("model") or ""),
        ]
    )


def embedding_batch_size(embedding_provider: dict[str, Any]) -> int:
    provider = str(embedding_provider.get("provider") or "").lower()
    if provider == "ollama":
        return 1
    if provider == "google":
        return 100
    return 96


def resolve_retrieval_options(options: dict[str, Any]) -> dict[str, Any]:
    retrieval = options.get("retrieval") or {}
    mode = str(retrieval.get("mode") or "vector")
    if mode not in {"vector", "vectorless"}:
        raise ValueError(f"Retrieval mode '{mode}' is not supported.")
    default_engine = "numpy-cosine" if mode == "vector" else "manifest-first-lexical"
    engine = str(retrieval.get("engine") or default_engine)
    document_ids = [str(item) for item in retrieval.get("documentIds") or [] if str(item).strip()]
    return {"mode": mode, "engine": engine, "documentIds": document_ids}




# ---------------------------------------------------------------------------
# Document records
# ---------------------------------------------------------------------------


def build_document_record(
    relative_path: str,
    parser_name: str,
    stat_result,
    chunks: list[str],
    content_hash: str | None,
    structure: dict[str, Any] | None = None,
    visual_assets: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    full_text = "\n\n".join(chunk for chunk in chunks if chunk.strip())
    summary = summarize_text(full_text)
    section_hints = extract_section_hints(full_text)
    if structure and structure.get("kind") == "spreadsheet":
        summary = summarize_spreadsheet_structure(relative_path, structure)
        section_hints = extract_spreadsheet_section_hints(structure)
    normalized_visual_assets = summarize_document_visual_assets(visual_assets or [])
    visual_summary = build_visual_asset_summary(normalized_visual_assets)
    return {
        "documentId": relative_path,
        "relativePath": relative_path,
        "parser": parser_name,
        "size": stat_result.st_size,
        "mtime": stat_result.st_mtime,
        "chunks": len(chunks),
        "tokenEstimate": max(1, math.ceil(len(full_text) / 4)),
        "summary": summary,
        "sectionHints": section_hints,
        "contentHash": content_hash,
        "structure": structure,
        "visualAssetSummary": visual_summary,
        "visualAssets": normalized_visual_assets[:MAX_DOCUMENT_VISUAL_ASSETS],
    }


def reused_document_record(previous_document: dict[str, Any], stat_result, content_hash: str | None = None) -> dict[str, Any]:
    return {
        **previous_document,
        "size": stat_result.st_size,
        "mtime": stat_result.st_mtime,
        "contentHash": content_hash or previous_document.get("contentHash"),
    }


def summarize_text(text: str, limit: int = 420) -> str:
    compact = re.sub(r"\s+", " ", text or "").strip()
    if len(compact) <= limit:
        return compact
    return f"{compact[: limit - 3].rstrip()}..."


def summarize_document_visual_assets(visual_assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summarized: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for asset in visual_assets:
        if not isinstance(asset, dict):
            continue
        key = visual_asset_key(asset)
        if key in seen:
            continue
        seen.add(key)
        item = {
            key_name: asset[key_name]
            for key_name in [
                "kind",
                "relativePath",
                "label",
                "anchorText",
                "pageNumber",
                "imageIndex",
                "mediaPath",
                "width",
                "height",
                "mimeType",
            ]
            if key_name in asset
        }
        summarized.append(item)
    return summarized


def build_visual_asset_summary(visual_assets: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not visual_assets:
        return None

    by_kind: dict[str, int] = {}
    pages: list[int] = []
    labels: list[str] = []
    for asset in visual_assets:
        kind = str(asset.get("kind") or "").strip()
        if kind:
            by_kind[kind] = by_kind.get(kind, 0) + 1
        page_number = asset.get("pageNumber")
        if isinstance(page_number, int) and page_number not in pages:
            pages.append(page_number)
        label = str(asset.get("label") or "").strip()
        if label and label not in labels:
            labels.append(label)

    pages.sort()
    return {
        "total": len(visual_assets),
        "byKind": by_kind,
        "pages": pages,
        "labels": labels[:MAX_VISUAL_SUMMARY_LABELS],
    }


def extract_section_hints(text: str, limit: int = 6) -> list[str]:
    hints: list[str] = []
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for line in lines:
        if looks_like_heading(line):
            hints.append(summarize_text(line, limit=120))
        if len(hints) >= limit:
            break
    if hints:
        return dedupe_preserve_order(hints)[:limit]
    fallback = [summarize_text(line, limit=120) for line in lines[:limit]]
    return dedupe_preserve_order([item for item in fallback if item])[:limit]


def looks_like_heading(line: str) -> bool:
    if line.startswith("#"):
        return True
    if line.lower().startswith("sheet:"):
        return True
    if len(line) > 120 or len(line) < 4:
        return False
    letters = [char for char in line if char.isalpha()]
    if not letters:
        return False
    uppercase_ratio = sum(1 for char in letters if char.isupper()) / len(letters)
    return uppercase_ratio > 0.55 or line.endswith(":")


def summarize_spreadsheet_structure(relative_path: str, structure: dict[str, Any]) -> str:
    sheet_count = int(structure.get("sheetCount") or 0)
    row_count = int(structure.get("rowCount") or 0)
    sheet_names = [str(item) for item in structure.get("sheetNames") or [] if str(item).strip()]
    column_hints = [str(item) for item in structure.get("columnHints") or [] if str(item).strip()]
    parts = [f"Spreadsheet document {relative_path} with {row_count} rows across {sheet_count} sheets."]
    if sheet_names:
        parts.append(f"Sheets: {', '.join(sheet_names[:6])}.")
    if column_hints:
        parts.append(f"Columns: {', '.join(column_hints[:8])}.")
    return summarize_text(" ".join(parts), limit=420)


def extract_spreadsheet_section_hints(structure: dict[str, Any], limit: int = 6) -> list[str]:
    hints: list[str] = []
    for sheet in structure.get("sheets") or []:
        name = str(sheet.get("name") or "").strip()
        header_hints = [str(item) for item in sheet.get("headerHints") or [] if str(item).strip()]
        if name:
            hints.append(f"Sheet: {name}")
        if header_hints:
            hints.append(f"Columns: {' | '.join(header_hints[:4])}")
        if len(hints) >= limit:
            break
    return dedupe_preserve_order(hints)[:limit]



def main() -> None:
    for raw_line in sys.stdin:
        if not raw_line.strip():
            continue
        try:
            request = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            emit_response(None, False, error=f"Invalid request JSON: {exc.msg}.")
            continue
        handle_request(request)


if __name__ == "__main__":
    # Required for ProcessPoolExecutor (spawn) in a PyInstaller-frozen binary; a no-op otherwise.
    multiprocessing.freeze_support()
    main()
