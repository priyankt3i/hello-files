from __future__ import annotations

import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parents[1] / "fschat_indexer"
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

import worker  # noqa: E402

VECTORLESS = {"retrieval": {"mode": "vectorless"}}


@pytest.fixture(autouse=True)
def reset_worker_state():
    worker.CANCELLED_CHANNELS.clear()
    worker._PENDING_BUILDS.clear()
    worker.clear_lexical_cache()
    yield
    worker.CANCELLED_CHANNELS.clear()
    worker._PENDING_BUILDS.clear()
    worker.clear_lexical_cache()


@pytest.fixture
def tree(tmp_path):
    """Create files from a {relative_path: content} mapping under tmp_path/root."""
    root = tmp_path / "root"
    root.mkdir()

    def make(files: dict[str, str | bytes]) -> Path:
        for relative, content in files.items():
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, bytes):
                target.write_bytes(content)
            else:
                target.write_text(content, encoding="utf-8")
        return root

    return make
