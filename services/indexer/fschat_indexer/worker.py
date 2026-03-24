from __future__ import annotations

import hashlib
import json
import math
import re
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np

from embeddings import batched, embed_query, embed_texts
from extractors import extract_text, normalize_text
from index_store import (
    INDEX_DIR_NAME,
    INDEX_VERSION,
    cleanup_temp_store,
    commit_temp_store,
    index_exists,
    read_chunk_metadata,
    read_documents,
    prepare_temp_store,
    read_manifest,
    write_documents,
    write_manifest,
)
from vector_store import clear_index_cache, get_vectors_for_labels, load_index_bundle, release_index_bundle, write_vector_store


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


class CancelledBuild(RuntimeError):
    def __init__(self, retain_partial: bool):
        super().__init__("Indexing cancelled.")
        self.retain_partial = retain_partial


CANCELLED_CHANNELS: dict[str, CancelRequest] = {}
BUILD_EXECUTOR = ThreadPoolExecutor(max_workers=1)


def emit_response(request_id: str | None, ok: bool, payload: Any = None, error: str | None = None) -> None:
    print(json.dumps({"id": request_id, "type": "response", "ok": ok, "payload": payload, "error": error}), flush=True)


def emit_progress(payload: dict[str, Any]) -> None:
    print(json.dumps({"type": "event", "method": "progress", "payload": payload}), flush=True)


def emit_file_update(payload: dict[str, Any]) -> None:
    print(json.dumps({"type": "event", "method": "file_update", "payload": payload}), flush=True)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def handle_request(request: dict[str, Any]) -> None:
    request_id = request.get("id")
    method = request.get("method")
    payload = request.get("payload") or {}

    try:
        if method == "get_index_status":
            root_path = Path(payload["rootPath"])
            if not index_exists(root_path):
                emit_response(request_id, True, {"exists": False})
                return
            try:
                emit_response(request_id, True, {"exists": True, "manifest": read_manifest(root_path)})
            except ValueError:
                emit_response(request_id, True, {"exists": False})
            return

        if method == "open_index":
            emit_response(request_id, True, {"manifest": read_manifest(Path(payload["rootPath"]))})
            return

        if method == "build_index":
            submit_build_request(
                request_id,
                payload["channelId"],
                Path(payload["rootPath"]),
                payload.get("options") or {},
                False,
            )
            return

        if method == "rebuild_index":
            submit_build_request(
                request_id,
                payload["channelId"],
                Path(payload["rootPath"]),
                payload.get("options") or {},
                True,
            )
            return

        if method == "cancel_build":
            CANCELLED_CHANNELS[payload["channelId"]] = CancelRequest(retain_partial=bool(payload.get("retainPartial")))
            emit_response(request_id, True, {"cancelled": True})
            return

        if method == "list_files":
            manifest = read_manifest(Path(payload["rootPath"]))
            files = [item for item in manifest["files"] if item["status"] == payload["status"]]
            emit_response(request_id, True, {"files": files})
            return

        if method == "list_documents":
            emit_response(request_id, True, {"documents": read_documents(Path(payload["rootPath"]))})
            return

        if method == "search":
            result = search_index(Path(payload["rootPath"]), payload["query"], int(payload.get("topK", 6)), payload.get("options") or {})
            emit_response(request_id, True, {"results": result})
            return

        raise ValueError(f"Unknown method '{method}'.")
    except Exception as exc:
        emit_response(request_id, False, error=f"{exc}\n{traceback.format_exc(limit=2)}")


def build_index(channel_id: str, root_path: Path, options: dict, force: bool = False) -> dict[str, Any]:
    if not root_path.exists() or not root_path.is_dir():
        raise ValueError("Selected root path does not exist or is not a directory.")
    retrieval = resolve_retrieval_options(options)
    if not force and index_exists(root_path):
        try:
            manifest = read_manifest(root_path)
            if manifest.get("retrievalMode") == retrieval["mode"]:
                return {"manifest": manifest, "files": manifest["files"], "cancelled": False, "retainedPartial": False}
        except ValueError:
            pass

    embedding_provider = options.get("embeddingProvider") or {}
    if retrieval["mode"] == "vector" and not embedding_provider:
        raise ValueError("Embedding provider configuration is required.")

    temp_store = prepare_temp_store(root_path)
    try:
        previous_manifest = read_manifest(root_path) if index_exists(root_path) else None
    except ValueError:
        previous_manifest = None
    previous_file_map: dict[str, dict[str, Any]] = {}
    previous_chunks_by_path: dict[str, list[dict[str, Any]]] = {}
    previous_vectors_by_hash: dict[str, list[float]] = {}
    previous_documents_by_path: dict[str, dict[str, Any]] = {}
    created_at = previous_manifest.get("createdAt") if previous_manifest else utc_now()

    if previous_manifest:
        try:
            previous_chunks = read_chunk_metadata(root_path)
            for chunk in previous_chunks:
                previous_chunks_by_path.setdefault(chunk["relativePath"], []).append(chunk)
            previous_documents_by_path = {
                item["relativePath"]: item for item in read_documents(root_path)
            }
            if previous_manifest.get("retrievalMode") == "vector":
                index_bundle = load_index_bundle(root_path, previous_manifest)
                labels = [chunk["label"] for chunk in index_bundle["chunks"]]
                vectors = get_vectors_for_labels(index_bundle, labels)
                for chunk, vector in zip(index_bundle["chunks"], vectors):
                    if chunk.get("chunkHash") not in previous_vectors_by_hash:
                        previous_vectors_by_hash[chunk["chunkHash"]] = vector
            previous_file_map = {item["relativePath"]: item for item in previous_manifest.get("files", [])}
        except Exception:
            clear_index_cache(root_path)
            previous_manifest = None
            previous_file_map = {}
            previous_chunks_by_path = {}
            previous_vectors_by_hash = {}
            previous_documents_by_path = {}
            created_at = utc_now()
        finally:
            release_index_bundle(locals().get("index_bundle"))
            clear_index_cache(root_path)

    try:
        emit_progress(
            {
                "channelId": channel_id,
                "phase": "discovering",
                "totalFiles": 0,
                "processedFiles": 0,
                "successCount": 0,
                "failureCount": 0,
                "message": "Scanning folder for supported files.",
            }
        )

        file_paths = discover_files(
            root_path,
            on_progress=lambda discovered_count: emit_progress(
                {
                    "channelId": channel_id,
                    "phase": "discovering",
                    "totalFiles": discovered_count,
                    "processedFiles": 0,
                    "successCount": 0,
                    "failureCount": 0,
                    "message": f"Scanning folder... discovered {discovered_count} files so far.",
                }
            ),
        )
        total_files = len(file_paths)
        emit_progress(
            {
                "channelId": channel_id,
                "phase": "discovering",
                "totalFiles": total_files,
                "processedFiles": 0,
                "successCount": 0,
                "failureCount": 0,
                "message": f"Discovered {total_files} files.",
            }
        )

        file_records: list[FileRecord] = []
        embedded_chunks: list[dict[str, Any]] = []
        document_records: list[dict[str, Any]] = []
        success_count = 0
        failure_count = 0
        processed_files = 0

        for path in file_paths:
            relative_path = str(path.relative_to(root_path))
            ensure_not_cancelled(channel_id, total_files, processed_files, success_count, failure_count, relative_path)
            stat = path.stat()
            previous_file = previous_file_map.get(relative_path)
            previous_chunks = previous_chunks_by_path.get(relative_path, [])
            previous_document = previous_documents_by_path.get(relative_path)

            emit_progress(
                {
                    "channelId": channel_id,
                    "phase": "extracting",
                    "totalFiles": total_files,
                    "processedFiles": processed_files,
                    "successCount": success_count,
                    "failureCount": failure_count,
                    "currentFile": relative_path,
                }
            )

            completed_current_file = False
            file_hash: str | None = None
            try:
                if previous_file and is_unchanged_by_stat(previous_file, stat):
                    reused_chunks = reuse_previous_chunks(
                        previous_chunks,
                        previous_vectors_by_hash,
                        include_embeddings=retrieval["mode"] == "vector",
                    )
                    can_reuse = len(reused_chunks) == len(previous_chunks) and (
                        retrieval["mode"] != "vector" or len(reused_chunks) > 0 or len(previous_chunks) == 0
                    )
                    if can_reuse:
                        record = reused_file_record(previous_file, stat)
                        file_records.append(record)
                        embedded_chunks.extend(reused_chunks)
                        if previous_document:
                            document_records.append(reused_document_record(previous_document, stat))
                        elif record.status == "indexed":
                            document_records.append(
                                build_document_record(
                                    relative_path,
                                    record.parser,
                                    stat,
                                    [chunk["text"] for chunk in reused_chunks],
                                    record.content_hash,
                                )
                            )
                        if record.status == "indexed":
                            success_count += 1
                        else:
                            failure_count += 1
                        emit_file_update({"channelId": channel_id, "file": record.to_dict()})
                        completed_current_file = True
                        continue

                file_hash = hash_file(path)
                if previous_file and previous_file.get("contentHash") == file_hash:
                    reused_chunks = reuse_previous_chunks(
                        previous_chunks,
                        previous_vectors_by_hash,
                        include_embeddings=retrieval["mode"] == "vector",
                    )
                    can_reuse = len(reused_chunks) == len(previous_chunks) and (
                        retrieval["mode"] != "vector" or len(reused_chunks) > 0 or len(previous_chunks) == 0
                    )
                    if can_reuse:
                        record = reused_file_record(previous_file, stat, content_hash=file_hash)
                        file_records.append(record)
                        embedded_chunks.extend(reused_chunks)
                        if previous_document:
                            document_records.append(reused_document_record(previous_document, stat, content_hash=file_hash))
                        elif record.status == "indexed":
                            document_records.append(
                                build_document_record(
                                    relative_path,
                                    record.parser,
                                    stat,
                                    [chunk["text"] for chunk in reused_chunks],
                                    record.content_hash,
                                )
                            )
                        if record.status == "indexed":
                            success_count += 1
                        else:
                            failure_count += 1
                        emit_file_update({"channelId": channel_id, "file": record.to_dict()})
                        completed_current_file = True
                        continue

                raw_text, parser_name = extract_text(path)
                normalized = normalize_text(raw_text)
                if not normalized:
                    raise ValueError("No extractable text found.")
                chunks = split_text(normalized)
                if not chunks:
                    raise ValueError("No extractable text chunks found.")

                file_chunk_entries: list[dict[str, Any]] = []
                entries_to_embed: list[dict[str, Any]] = []
                for chunk_index, chunk_text in enumerate(chunks):
                    chunk_hash = hash_text(chunk_text)
                    entry = {
                        "chunkId": f"{relative_path}:{chunk_index}:{uuid4().hex[:8]}",
                        "relativePath": relative_path,
                        "snippet": chunk_text[:240],
                        "text": chunk_text,
                        "chunkHash": chunk_hash,
                        "fileHash": file_hash,
                    }
                    cached_vector = previous_vectors_by_hash.get(chunk_hash)
                    if cached_vector is not None:
                        entry["embedding"] = cached_vector
                    else:
                        entries_to_embed.append(entry)
                    file_chunk_entries.append(entry)

                if retrieval["mode"] == "vector":
                    batch_size = embedding_batch_size(embedding_provider)
                    total_batches = max(1, math.ceil(len(entries_to_embed) / batch_size)) if entries_to_embed else 0
                    embedded_chunk_count = 0
                    for batch_index, batch in enumerate(batched(entries_to_embed, batch_size), start=1):
                        ensure_not_cancelled(channel_id, total_files, processed_files, success_count, failure_count, relative_path)
                        emit_progress(
                            {
                                "channelId": channel_id,
                                "phase": "embedding",
                                "totalFiles": total_files,
                                "processedFiles": processed_files,
                                "successCount": success_count,
                                "failureCount": failure_count,
                                "currentFile": relative_path,
                                "message": (
                                    f"Embedding batch {batch_index}/{total_batches} "
                                    f"({embedded_chunk_count + 1}-{embedded_chunk_count + len(batch)} of {len(entries_to_embed)} new chunks)."
                                ),
                            }
                        )
                        vectors = embed_texts(embedding_provider, [item["text"] for item in batch], timeout_seconds=None)
                        for item, vector in zip(batch, vectors):
                            item["embedding"] = vector
                            previous_vectors_by_hash[item["chunkHash"]] = vector
                        embedded_chunk_count += len(batch)

                    if any("embedding" not in entry for entry in file_chunk_entries):
                        raise ValueError("Failed to create embeddings for one or more chunks.")

                embedded_chunks.extend(file_chunk_entries)
                document_records.append(build_document_record(relative_path, parser_name, stat, chunks, file_hash))
                record = FileRecord(
                    relative_path=relative_path,
                    status="indexed",
                    size=stat.st_size,
                    mtime=stat.st_mtime,
                    parser=parser_name,
                    chunks=len(chunks),
                    content_hash=file_hash,
                )
                file_records.append(record)
                success_count += 1
                emit_file_update({"channelId": channel_id, "file": record.to_dict()})
                completed_current_file = True
            except CancelledBuild:
                raise
            except Exception as exc:
                record = FileRecord(
                    relative_path=relative_path,
                    status="failed",
                    size=stat.st_size if path.exists() else 0,
                    mtime=stat.st_mtime if path.exists() else 0,
                    parser="unavailable",
                    chunks=0,
                    content_hash=file_hash,
                    error_reason=str(exc),
                )
                file_records.append(record)
                emit_file_update({"channelId": channel_id, "file": record.to_dict()})
                failure_count += 1
                completed_current_file = True
            finally:
                if completed_current_file:
                    processed_files += 1
                    emit_progress(
                        {
                            "channelId": channel_id,
                            "phase": "extracting",
                            "totalFiles": total_files,
                            "processedFiles": processed_files,
                            "successCount": success_count,
                            "failureCount": failure_count,
                            "currentFile": relative_path,
                        }
                    )

        emit_progress(
            {
                "channelId": channel_id,
                "phase": "writing",
                "totalFiles": total_files,
                "processedFiles": processed_files,
                "successCount": success_count,
                "failureCount": failure_count,
                "message": "Writing index files.",
            }
        )
        manifest = finalize_index(
            temp_store,
            root_path,
            file_records,
            embedded_chunks,
            document_records,
            created_at,
            embedding_provider,
            retrieval,
        )
        emit_progress(
            {
                "channelId": channel_id,
                "phase": "completed",
                "totalFiles": total_files,
                "processedFiles": processed_files,
                "successCount": success_count,
                "failureCount": failure_count,
                "message": "Index complete.",
            }
        )
        return {"manifest": manifest, "files": manifest["files"], "cancelled": False, "retainedPartial": False}
    except CancelledBuild as exc:
        retainable_records = [record.to_dict() for record in file_records]
        if exc.retain_partial:
            if not retainable_records and not embedded_chunks:
                cleanup_temp_store(root_path)
                return {"manifest": None, "files": [], "cancelled": True, "retainedPartial": False}
            manifest = finalize_index(
                temp_store,
                root_path,
                file_records,
                embedded_chunks,
                document_records,
                created_at,
                embedding_provider,
                retrieval,
            )
            return {"manifest": manifest, "files": retainable_records, "cancelled": True, "retainedPartial": True}
        cleanup_temp_store(root_path)
        clear_index_cache(root_path)
        return {"manifest": None, "files": [], "cancelled": True, "retainedPartial": False}
    except Exception:
        cleanup_temp_store(root_path)
        clear_index_cache(root_path)
        raise


def search_index(root_path: Path, query: str, top_k: int, options: dict) -> list[dict[str, Any]]:
    retrieval = resolve_retrieval_options(options)
    manifest = read_manifest(root_path)
    if manifest.get("retrievalMode") != retrieval["mode"]:
        raise ValueError("Index retrieval mode does not match the requested retrieval mode.")
    if manifest.get("chunkCount", 0) == 0:
        return []

    if retrieval["mode"] == "vectorless":
        selected_document_ids = set(retrieval.get("documentIds") or [])
        query_tokens = tokenize_query(query)
        query_lower = query.lower().strip()
        scored_chunks: list[tuple[float, dict[str, Any]]] = []
        for chunk in read_chunk_metadata(root_path):
            if selected_document_ids and chunk.get("relativePath") not in selected_document_ids:
                continue
            score = lexical_chunk_score(query_tokens, query_lower, chunk.get("text", ""), chunk.get("relativePath", ""))
            if score <= 0:
                continue
            scored_chunks.append((score, chunk))
        scored_chunks.sort(key=lambda item: item[0], reverse=True)
        results: list[dict[str, Any]] = []
        for score, chunk in scored_chunks[: max(int(top_k), 0)]:
            results.append(
                {
                    "chunkId": chunk["chunkId"],
                    "relativePath": chunk["relativePath"],
                    "score": float(score),
                    "snippet": chunk["snippet"],
                    "text": chunk["text"],
                }
            )
        return results

    embedding_provider = options.get("embeddingProvider") or {}
    if not embedding_provider:
        raise ValueError("Embedding provider configuration is required for search.")

    bundle = load_index_bundle(root_path, manifest)
    vectors = bundle.get("vectors")
    if vectors is None:
        return []

    query_embedding = np.asarray(embed_query(embedding_provider, query), dtype=np.float32)
    query_norm = np.linalg.norm(query_embedding)
    if query_norm == 0:
        return []
    normalized_query = query_embedding / query_norm
    scores = np.asarray(vectors @ normalized_query, dtype=np.float32)
    limit = min(int(top_k), int(scores.shape[0]))
    if limit <= 0:
        return []
    if limit == scores.shape[0]:
        top_labels = np.argsort(scores)[::-1]
    else:
        candidate_labels = np.argpartition(scores, -limit)[-limit:]
        top_labels = candidate_labels[np.argsort(scores[candidate_labels])[::-1]]

    results: list[dict[str, Any]] = []
    for label in top_labels.tolist():
        chunk = bundle["chunkByLabel"].get(int(label))
        if not chunk:
            continue
        results.append(
            {
                "chunkId": chunk["chunkId"],
                "relativePath": chunk["relativePath"],
                "score": max(0.0, float(scores[int(label)])),
                "snippet": chunk["snippet"],
                "text": chunk["text"],
            }
        )
    return results


def discover_files(root_path: Path, on_progress=None) -> list[Path]:
    files: list[Path] = []
    for path in root_path.rglob("*"):
        if not path.is_file():
            continue
        relative_parts = path.relative_to(root_path).parts
        if relative_parts and relative_parts[0] in {INDEX_DIR_NAME, ".fschat-index.tmp"}:
            continue
        files.append(path)
        if on_progress and (len(files) == 1 or len(files) % 25 == 0):
            on_progress(len(files))
    files.sort(key=lambda item: str(item.relative_to(root_path)).lower())
    return files


def split_text(text: str, chunk_size: int = 1200, overlap: int = 200) -> list[str]:
    chunks: list[str] = []
    cursor = 0
    length = len(text)
    while cursor < length:
        window = text[cursor : cursor + chunk_size].strip()
        if window:
            chunks.append(window)
        if cursor + chunk_size >= length:
            break
        cursor += chunk_size - overlap
    return chunks


def finalize_index(
    temp_store: Path,
    root_path: Path,
    file_records: list[FileRecord],
    embedded_chunks: list[dict[str, Any]],
    document_records: list[dict[str, Any]],
    created_at: str,
    embedding_provider: dict[str, Any],
    retrieval: dict[str, Any],
) -> dict[str, Any]:
    files_payload = [record.to_dict() for record in file_records]
    timestamp = utc_now()
    manifest = {
        "version": INDEX_VERSION,
        "rootPath": str(root_path),
        "createdAt": created_at,
        "updatedAt": timestamp,
        "files": files_payload,
        "chunkCount": len(embedded_chunks),
        "documentCount": len(document_records),
        "retrievalMode": retrieval["mode"],
        "indexEngine": retrieval["engine"],
    }
    if retrieval["mode"] == "vector":
        embedding_dimension = len(embedded_chunks[0]["embedding"]) if embedded_chunks else 0
        manifest["embeddingDimension"] = embedding_dimension
        manifest["embeddingModelKey"] = build_embedding_model_key(embedding_provider)
    write_manifest(temp_store, manifest)
    write_documents(temp_store, document_records)
    write_vector_store(temp_store, embedded_chunks, int(manifest.get("embeddingDimension", 0)))
    clear_index_cache(root_path)
    commit_temp_store(root_path)
    clear_index_cache(root_path)
    return manifest


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def is_unchanged_by_stat(previous_file: dict[str, Any], stat_result) -> bool:
    return previous_file.get("size") == stat_result.st_size and previous_file.get("mtime") == stat_result.st_mtime


def reused_file_record(previous_file: dict[str, Any], stat_result, content_hash: str | None = None) -> FileRecord:
    return FileRecord(
        relative_path=previous_file["relativePath"],
        status=previous_file["status"],
        size=stat_result.st_size,
        mtime=stat_result.st_mtime,
        parser=previous_file.get("parser", "reused"),
        chunks=int(previous_file.get("chunks", 0)),
        content_hash=content_hash or previous_file.get("contentHash"),
        error_reason=previous_file.get("errorReason"),
    )


def reuse_previous_chunks(
    previous_chunks: list[dict[str, Any]],
    previous_vectors_by_hash: dict[str, list[float]],
    include_embeddings: bool = True,
) -> list[dict[str, Any]]:
    reused: list[dict[str, Any]] = []
    for chunk in previous_chunks:
        entry = {
            "chunkId": chunk["chunkId"],
            "relativePath": chunk["relativePath"],
            "snippet": chunk["snippet"],
            "text": chunk["text"],
            "chunkHash": chunk["chunkHash"],
            "fileHash": chunk.get("fileHash"),
        }
        if include_embeddings:
            vector = previous_vectors_by_hash.get(chunk.get("chunkHash"))
            if vector is None:
                continue
            entry["embedding"] = vector
        reused.append(entry)
    return reused


def ensure_not_cancelled(
    channel_id: str,
    total_files: int,
    processed_files: int,
    success_count: int,
    failure_count: int,
    current_file: str | None = None,
) -> None:
    request = CANCELLED_CHANNELS.get(channel_id)
    if request is None:
        return
    CANCELLED_CHANNELS.pop(channel_id, None)
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


def submit_build_request(request_id: str | None, channel_id: str, root_path: Path, options: dict, force: bool) -> None:
    def run() -> None:
        try:
            emit_response(request_id, True, build_index(channel_id, root_path, options, force=force))
        except Exception as exc:
            emit_response(request_id, False, error=f"{exc}\n{traceback.format_exc(limit=2)}")

    BUILD_EXECUTOR.submit(run)


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
    return 24


def resolve_retrieval_options(options: dict[str, Any]) -> dict[str, Any]:
    retrieval = options.get("retrieval") or {}
    mode = str(retrieval.get("mode") or "vector")
    if mode not in {"vector", "vectorless"}:
        raise ValueError(f"Retrieval mode '{mode}' is not supported.")
    default_engine = "numpy-cosine" if mode == "vector" else "manifest-first-lexical"
    engine = str(retrieval.get("engine") or default_engine)
    document_ids = [str(item) for item in retrieval.get("documentIds") or [] if str(item).strip()]
    return {"mode": mode, "engine": engine, "documentIds": document_ids}


def build_document_record(
    relative_path: str,
    parser_name: str,
    stat_result,
    chunks: list[str],
    content_hash: str | None,
) -> dict[str, Any]:
    full_text = "\n\n".join(chunk for chunk in chunks if chunk.strip())
    return {
        "documentId": relative_path,
        "relativePath": relative_path,
        "parser": parser_name,
        "size": stat_result.st_size,
        "mtime": stat_result.st_mtime,
        "chunks": len(chunks),
        "tokenEstimate": max(1, math.ceil(len(full_text) / 4)),
        "summary": summarize_text(full_text),
        "sectionHints": extract_section_hints(full_text),
        "contentHash": content_hash,
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


def dedupe_preserve_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        ordered.append(item)
    return ordered


def tokenize_query(text: str) -> list[str]:
    return [token for token in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(token) > 1]


def lexical_chunk_score(query_tokens: list[str], query_lower: str, text: str, relative_path: str) -> float:
    haystack = f"{relative_path}\n{text}".lower()
    if not haystack.strip():
        return 0.0
    score = 0.0
    if query_lower and query_lower in haystack:
        score += 4.0
    unique_matches = 0
    path_lower = relative_path.lower()
    for token in set(query_tokens):
        count = haystack.count(token)
        if count:
            unique_matches += 1
            score += min(count, 8) * 0.65
        if token in path_lower:
            score += 1.5
    score += unique_matches * 0.9
    return score


def main() -> None:
    for raw_line in sys.stdin:
        if raw_line.strip():
            handle_request(json.loads(raw_line))


if __name__ == "__main__":
    main()
