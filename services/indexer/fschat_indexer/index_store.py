from __future__ import annotations

import ctypes
import json
import os
import shutil
from pathlib import Path
from typing import Iterable


INDEX_DIR_NAME = ".fschat-index"
INDEX_TEMP_DIR_NAME = ".fschat-index.tmp"
INDEX_VERSION = 3
SUPPORTED_INDEX_VERSIONS = {2, 3}


def root_index_path(root_path: Path) -> Path:
    return root_path / INDEX_DIR_NAME


def temp_index_path(root_path: Path) -> Path:
    return root_path / INDEX_TEMP_DIR_NAME


def manifest_path(index_path: Path) -> Path:
    return index_path / "manifest.json"


def chunk_metadata_path(index_path: Path) -> Path:
    return index_path / "chunk_metadata.jsonl"


def documents_path(index_path: Path) -> Path:
    return index_path / "documents.json"


def vector_index_path(index_path: Path) -> Path:
    return index_path / "vectors.npy"


def prepare_temp_store(root_path: Path) -> Path:
    temp_path = temp_index_path(root_path)
    if temp_path.exists():
        shutil.rmtree(temp_path, ignore_errors=True)
    temp_path.mkdir(parents=True, exist_ok=True)
    return temp_path


def commit_temp_store(root_path: Path) -> Path:
    final_path = root_index_path(root_path)
    temp_path = temp_index_path(root_path)
    if final_path.exists():
        shutil.rmtree(final_path, ignore_errors=True)
    temp_path.replace(final_path)
    hide_path(final_path)
    return final_path


def cleanup_temp_store(root_path: Path) -> None:
    temp_path = temp_index_path(root_path)
    if temp_path.exists():
        shutil.rmtree(temp_path, ignore_errors=True)


def write_manifest(index_path: Path, manifest: dict) -> None:
    manifest_path(index_path).write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def read_manifest(root_path: Path) -> dict:
    path = manifest_path(root_index_path(root_path))
    if not path.exists():
        raise FileNotFoundError("Index manifest not found.")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    version = manifest.get("version")
    if version not in SUPPORTED_INDEX_VERSIONS:
        raise ValueError("Unsupported index version.")
    if version == 2:
        manifest["retrievalMode"] = "vector"
        manifest["indexEngine"] = "numpy-cosine"
        return manifest
    manifest.setdefault("retrievalMode", "vector")
    manifest.setdefault("indexEngine", "numpy-cosine")
    return manifest


def index_exists(root_path: Path) -> bool:
    return manifest_path(root_index_path(root_path)).exists()


def write_chunk_metadata(index_path: Path, chunks: Iterable[dict]) -> None:
    with chunk_metadata_path(index_path).open("w", encoding="utf-8") as handle:
        for chunk in chunks:
            handle.write(json.dumps(chunk, ensure_ascii=True) + "\n")


def write_documents(index_path: Path, documents: list[dict]) -> None:
    documents_path(index_path).write_text(json.dumps(documents, indent=2), encoding="utf-8")


def read_chunk_metadata(root_path: Path) -> list[dict]:
    path = chunk_metadata_path(root_index_path(root_path))
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def read_documents(root_path: Path) -> list[dict]:
    path = documents_path(root_index_path(root_path))
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def hide_path(path: Path) -> None:
    if os.name != "nt":
        return
    FILE_ATTRIBUTE_HIDDEN = 0x02
    ctypes.windll.kernel32.SetFileAttributesW(str(path), FILE_ATTRIBUTE_HIDDEN)
