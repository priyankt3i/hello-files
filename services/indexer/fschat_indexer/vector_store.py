from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from index_store import (
    chunk_metadata_path,
    read_chunk_metadata,
    root_index_path,
    vector_index_path,
    write_chunk_metadata,
)


_INDEX_CACHE: dict[str, dict[str, Any]] = {}


def clear_index_cache(root_path: Path | None = None) -> None:
    if root_path is None:
        for bundle in list(_INDEX_CACHE.values()):
            release_index_bundle(bundle)
        _INDEX_CACHE.clear()
        return
    cache_key = str(root_index_path(root_path))
    bundle = _INDEX_CACHE.pop(cache_key, None)
    if bundle is not None:
        release_index_bundle(bundle)


def write_vector_store(index_path: Path, chunks: list[dict], embedding_dimension: int) -> None:
    metadata_rows = []
    vectors = []
    for label, chunk in enumerate(chunks):
        row = {
            "label": label,
            "chunkId": chunk["chunkId"],
            "relativePath": chunk["relativePath"],
            "snippet": chunk["snippet"],
            "text": chunk["text"],
            "chunkHash": chunk["chunkHash"],
            "fileHash": chunk["fileHash"],
        }
        if chunk.get("chunkType"):
            row["chunkType"] = chunk["chunkType"]
        if chunk.get("sheetName"):
            row["sheetName"] = chunk["sheetName"]
        if chunk.get("rowNumber") is not None:
            row["rowNumber"] = chunk["rowNumber"]
        if chunk.get("visualAssets"):
            row["visualAssets"] = chunk["visualAssets"]
        metadata_rows.append(row)
        if "embedding" in chunk:
            vectors.append(chunk["embedding"])

    write_chunk_metadata(index_path, metadata_rows)

    vector_file = vector_index_path(index_path)
    if not vectors:
        if vector_file.exists():
            vector_file.unlink()
        return

    matrix = np.asarray(vectors, dtype=np.float32)
    normalized = normalize_rows(matrix)
    if embedding_dimension and normalized.shape[1] != embedding_dimension:
        raise ValueError("Embedding dimension mismatch while writing vector store.")
    np.save(vector_file, normalized)


def load_index_bundle(root_path: Path, manifest: dict) -> dict[str, Any]:
    cache_key = str(root_index_path(root_path))
    vector_file = vector_index_path(root_index_path(root_path))
    metadata_file = chunk_metadata_path(root_index_path(root_path))
    fingerprint = (
        manifest.get("updatedAt"),
        vector_file.stat().st_mtime if vector_file.exists() else 0,
        metadata_file.stat().st_mtime if metadata_file.exists() else 0,
    )

    cached = _INDEX_CACHE.get(cache_key)
    if cached and cached.get("fingerprint") == fingerprint:
        return cached

    chunks = read_chunk_metadata(root_path)
    vectors = None
    if manifest.get("chunkCount", 0) > 0 and manifest.get("embeddingDimension", 0) > 0 and vector_file.exists():
        vectors = np.load(vector_file, mmap_mode="r")

    bundle: dict[str, Any] = {
        "fingerprint": fingerprint,
        "chunks": chunks,
        "chunkByLabel": {chunk["label"]: chunk for chunk in chunks},
        "vectors": vectors,
    }

    _INDEX_CACHE[cache_key] = bundle
    return bundle


def get_vectors_for_labels(index_bundle: dict[str, Any], labels: list[int]) -> list[list[float]]:
    if not labels:
        return []
    vectors = index_bundle.get("vectors")
    if vectors is None:
        return []
    return np.asarray(vectors[labels], dtype=np.float32).tolist()


def release_index_bundle(index_bundle: dict[str, Any] | None) -> None:
    if not index_bundle:
        return
    vectors = index_bundle.get("vectors")
    if vectors is None:
        return

    mmap_handle = getattr(vectors, "_mmap", None)
    if mmap_handle is not None:
        mmap_handle.close()
    index_bundle["vectors"] = None


def normalize_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms
