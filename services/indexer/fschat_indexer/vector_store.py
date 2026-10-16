"""Quantized vector storage helpers and the in-memory search cache.

Vectors are L2-normalized, then stored in SQLite as int8 with a per-vector scale
(`value ~= int8 * scale`). Cosine similarity only needs the direction, so search
scores are `(q_int8 . query) / ||q_int8||`; the scale is kept so vectors can be
dequantized exactly when needed.
"""

from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from typing import Any

import numpy as np


SCORE_BLOCK_ROWS = 8192

# Keyed by index key. Guarded by _CACHE_LOCK because searches run on the stdin
# thread while builds run on the executor thread.
_VECTOR_CACHE: dict[str, "VectorMatrix"] = {}
_VECTOR_CACHE_LIMIT = 4
_CACHE_LOCK = threading.RLock()


@dataclass
class VectorMatrix:
    data_version: str
    chunk_ids: np.ndarray  # int64, row -> chunks.id
    quantized: np.ndarray  # int8, (n, dim)
    inverse_norms: np.ndarray  # float32, 1 / ||quantized row||

    @property
    def dimension(self) -> int:
        return int(self.quantized.shape[1]) if self.quantized.ndim == 2 else 0


def normalize_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def quantize_vector(vector: Any) -> tuple[int, float, bytes]:
    """Normalize and quantize one vector. Returns (dimension, scale, int8 bytes)."""
    values = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(values))
    if norm > 0:
        values = values / norm
    peak = float(np.max(np.abs(values))) if values.size else 0.0
    scale = peak / 127.0 if peak > 0 else 1.0
    quantized = np.clip(np.rint(values / scale), -127, 127).astype(np.int8)
    return int(values.shape[0]), scale, quantized.tobytes()


def dequantize_vector(scale: float, data: bytes) -> np.ndarray:
    return np.frombuffer(data, dtype=np.int8).astype(np.float32) * np.float32(scale)


def clear_index_cache(index_key: str | None = None) -> None:
    with _CACHE_LOCK:
        if index_key is None:
            _VECTOR_CACHE.clear()
        else:
            _VECTOR_CACHE.pop(index_key, None)


def load_vector_matrix(conn: sqlite3.Connection, index_key: str, data_version: str) -> VectorMatrix | None:
    with _CACHE_LOCK:
        cached = _VECTOR_CACHE.get(index_key)
        if cached is not None and cached.data_version == data_version:
            return cached

    rows = conn.execute("SELECT chunk_id, dim, data FROM vectors ORDER BY chunk_id").fetchall()
    if not rows:
        matrix = None
    else:
        dimension = int(rows[0][1])
        if any(int(row[1]) != dimension for row in rows):
            raise ValueError("Index vectors have inconsistent dimensions; rebuild required.")
        chunk_ids = np.fromiter((row[0] for row in rows), dtype=np.int64, count=len(rows))
        quantized = np.frombuffer(b"".join(row[2] for row in rows), dtype=np.int8).reshape(len(rows), dimension)
        norms = np.sqrt(np.einsum("ij,ij->i", quantized, quantized, dtype=np.float32))
        norms[norms == 0] = 1.0
        matrix = VectorMatrix(data_version, chunk_ids, quantized, (1.0 / norms).astype(np.float32))
    del rows

    if matrix is not None:
        with _CACHE_LOCK:
            _VECTOR_CACHE[index_key] = matrix
            while len(_VECTOR_CACHE) > _VECTOR_CACHE_LIMIT:
                _VECTOR_CACHE.pop(next(iter(_VECTOR_CACHE)))
    return matrix


def cosine_scores(matrix: VectorMatrix, query_vector: np.ndarray) -> np.ndarray:
    """Cosine of a normalized float32 query against every stored vector, computed in
    fixed-size blocks so the dequantized working set stays small."""
    if matrix.dimension != query_vector.shape[0]:
        raise ValueError(
            f"Query embedding has {query_vector.shape[0]} dimensions but the index has "
            f"{matrix.dimension}; rebuild required."
        )
    query = np.asarray(query_vector, dtype=np.float32)
    total = matrix.quantized.shape[0]
    scores = np.empty(total, dtype=np.float32)
    for start in range(0, total, SCORE_BLOCK_ROWS):
        block = matrix.quantized[start : start + SCORE_BLOCK_ROWS].astype(np.float32)
        scores[start : start + block.shape[0]] = block @ query
    scores *= matrix.inverse_norms
    return scores
