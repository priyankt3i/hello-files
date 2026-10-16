from __future__ import annotations

import hashlib
import os

import numpy as np
import pytest

import worker
from conftest import VECTORLESS


def rel(path: str) -> str:
    return path.replace("/", os.sep)


def test_tokenize():
    assert worker.tokenize("Größe_Total: 42 a Café-Menu") == ["grösse", "total", "42", "café", "menu"]


def test_bm25_ranking(tree, tmp_path):
    root = tree(
        {
            "notes/apples.txt": "apple apple apple orchard harvest",
            "notes/mixed.txt": "apple banana cherry date elderberry fig grape honeydew kiwi lemon mango",
            "notes/other.txt": "nothing relevant here at all",
            "notes/common.txt": "the the the the apple",
        }
    )
    index = tmp_path / "idx"
    worker.build_index("c", root, VECTORLESS, index_path=index)
    results = worker.search_index(root, "apple orchard", 10, VECTORLESS, index_path=index)
    paths = [item["relativePath"] for item in results]
    assert paths[0] == rel("notes/apples.txt")
    assert rel("notes/other.txt") not in paths
    assert all(left["score"] >= right["score"] for left, right in zip(results, results[1:]))

    filtered_options = {"retrieval": {"mode": "vectorless", "documentIds": [rel("notes/mixed.txt")]}}
    filtered = worker.search_index(root, "apple", 10, filtered_options, index_path=index)
    assert [item["relativePath"] for item in filtered] == [rel("notes/mixed.txt")]


def test_bm25_idf_prefers_rare_terms(tree, tmp_path):
    root = tree(
        {
            "a.txt": "report report report quarterly",
            "b.txt": "report summary",
            "c.txt": "report overview",
            "d.txt": "zeppelin report",
        }
    )
    index = tmp_path / "idx"
    worker.build_index("c", root, VECTORLESS, index_path=index)
    results = worker.search_index(root, "report zeppelin", 4, VECTORLESS, index_path=index)
    assert results[0]["relativePath"] == "d.txt"


def test_path_match_boost(tree, tmp_path):
    root = tree({"budget/plan.txt": "numbers for next year", "other/plan.txt": "numbers for next year"})
    index = tmp_path / "idx"
    worker.build_index("c", root, VECTORLESS, index_path=index)
    results = worker.search_index(root, "budget numbers", 2, VECTORLESS, index_path=index)
    assert results[0]["relativePath"] == rel("budget/plan.txt")


def test_lexical_cache_refreshes_after_rebuild(tree, tmp_path):
    root = tree({"a.txt": "zebra"})
    index = tmp_path / "idx"
    worker.build_index("c", root, VECTORLESS, index_path=index)
    assert worker.search_index(root, "zebra", 5, VECTORLESS, index_path=index)
    (root / "a.txt").write_text("giraffe", encoding="utf-8")
    worker.build_index("c", root, VECTORLESS, force=True, index_path=index)
    assert worker.search_index(root, "zebra", 5, VECTORLESS, index_path=index) == []
    assert worker.search_index(root, "giraffe", 5, VECTORLESS, index_path=index)


def fake_embed(provider, texts):
    vectors = []
    for text in texts:
        vector = np.zeros(16, dtype=np.float32)
        for token in worker.tokenize(text):
            vector[int(hashlib.md5(token.encode()).hexdigest(), 16) % 16] += 1.0
        vectors.append(vector.tolist())
    return vectors


def vector_options(model):
    return {"retrieval": {"mode": "vector"}, "embeddingProvider": {"provider": "openai", "model": model, "apiKey": "k"}}


def test_vector_reuse_and_model_mismatch(tree, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(worker, "embed_texts", lambda p, t, **k: calls.append(len(t)) or fake_embed(p, t))
    monkeypatch.setattr(worker, "embed_query", lambda p, t, **k: fake_embed(p, [t])[0])
    root = tree({"a.txt": "solar panels", "b.txt": "wind turbines"})
    index = tmp_path / "idx"
    worker.build_index("c", root, vector_options("m1"), index_path=index)
    assert sum(calls) == 2

    calls.clear()
    (root / "c.txt").write_text("hydro dams", encoding="utf-8")
    result = worker.build_index("c", root, vector_options("m1"), index_path=index)
    assert sum(calls) == 1  # only the new file is embedded
    assert result["stats"]["added"] == 1 and result["stats"]["unchanged"] == 2

    hits = worker.search_index(root, "solar panels", 1, vector_options("m1"), index_path=index)
    assert hits[0]["relativePath"] == "a.txt"
    with pytest.raises(ValueError, match="Index was built with openai/m1.*rebuild required"):
        worker.search_index(root, "solar", 1, vector_options("m2"), index_path=index)

    calls.clear()
    monkeypatch.setattr(worker, "extract_document", lambda path: pytest.fail("chunks should be reused"))
    worker.build_index("c", root, vector_options("m2"), index_path=index)
    assert sum(calls) == 3  # model changed: re-embed everything but reuse extraction
    assert worker.search_index(root, "wind", 1, vector_options("m2"), index_path=index)[0]["relativePath"] == "b.txt"


def test_embedding_failure_aborts_build_and_keeps_previous_index(tree, tmp_path, monkeypatch):
    monkeypatch.setattr(worker, "embed_texts", lambda p, t, **k: fake_embed(p, t))
    root = tree({"a.txt": "solar panels"})
    index = tmp_path / "idx"
    first = worker.build_index("c", root, vector_options("m1"), index_path=index)

    def down(*args, **kwargs):
        raise worker.EmbeddingError("Could not reach embedding provider.")

    monkeypatch.setattr(worker, "embed_texts", down)
    (root / "b.txt").write_text("new file", encoding="utf-8")
    with pytest.raises(worker.EmbeddingError):
        worker.build_index("c", root, vector_options("m1"), index_path=index)
    assert worker.read_manifest(index)["updatedAt"] == first["manifest"]["updatedAt"]
