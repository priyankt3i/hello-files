from __future__ import annotations

import json
import os
import sqlite3

import numpy as np
import pytest

import worker
from conftest import VECTORLESS
from index_store import db_path, open_index_db, read_documents, read_manifest, read_meta
from test_search import fake_embed, vector_options
from vector_store import VectorMatrix, cosine_scores, quantize_vector


def rel(path: str) -> str:
    return path.replace("/", os.sep)


def build(root, index, options=VECTORLESS, **extra):
    return worker.build_index("c", root, {**options, **extra}, index_path=index)


def search(root, index, query, top_k=10, document_ids=None):
    options = {"retrieval": {"mode": "vectorless", **({"documentIds": document_ids} if document_ids else {})}}
    return worker.search_index(root, query, top_k, options, index_path=index)


def chunk_rows(index):
    with open_index_db(index) as conn:
        return {row[1]: row[0] for row in conn.execute("SELECT id, relative_path FROM chunks")}


def fts_integrity_check(index):
    conn = sqlite3.connect(db_path(index))
    try:
        conn.execute("INSERT INTO chunks_fts(chunks_fts, rank) VALUES ('integrity-check', 1)")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Migration from v2/v3 JSON indexes
# ---------------------------------------------------------------------------


def write_json_index(root, index, version, provider):
    index.mkdir(parents=True)
    texts = {"a.txt": "solar panels", "b.txt": "wind turbines"}
    files, documents, chunks = [], [], []
    vectors = np.asarray(fake_embed(provider, list(texts.values())), dtype=np.float32)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    for label, (name, text) in enumerate(texts.items()):
        path = root / name
        path.write_text(text, encoding="utf-8")
        stat_result = path.stat()
        file_hash = worker.hash_file(path)
        files.append(
            {
                "relativePath": name,
                "status": "indexed",
                "size": stat_result.st_size,
                "mtime": stat_result.st_mtime,
                "parser": "text",
                "chunks": 1,
                "contentHash": file_hash,
            }
        )
        documents.append(worker.build_document_record(name, "text", stat_result, [text], file_hash))
        chunks.append(
            {
                "label": label,
                "chunkId": f"{name}:0:legacy{label}",
                "relativePath": name,
                "snippet": text,
                "text": text,
                "chunkHash": worker.hash_text(text),
                "fileHash": file_hash,
            }
        )
    manifest = {
        "version": version,
        "rootPath": str(root),
        "createdAt": "2025-01-01T00:00:00+00:00",
        "updatedAt": "2025-01-02T00:00:00+00:00",
        "files": files,
        "chunkCount": len(chunks),
        "documentCount": len(documents),
        "embeddingDimension": int(vectors.shape[1]),
        "embeddingModelKey": worker.build_embedding_model_key(provider),
    }
    if version == 3:
        manifest.update(retrievalMode="vector", indexEngine="numpy-cosine")
    (index / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (index / "documents.json").write_text(json.dumps(documents), encoding="utf-8")
    (index / "chunk_metadata.jsonl").write_text("".join(json.dumps(chunk) + "\n" for chunk in chunks), encoding="utf-8")
    np.save(index / "vectors.npy", vectors)


@pytest.mark.parametrize("version", [2, 3])
def test_migrates_json_index_once_and_reuses_chunks_and_vectors(tmp_path, monkeypatch, capsys, version):
    root = tmp_path / "root"
    root.mkdir()
    index = tmp_path / "idx"
    options = vector_options("m1")
    write_json_index(root, index, version, options["embeddingProvider"])

    worker.handle_request({"id": "s", "method": "get_index_status", "payload": {"rootPath": str(root), "indexPath": str(index)}})
    status = json.loads(capsys.readouterr().out.strip().splitlines()[-1])["payload"]
    assert status["exists"] is True
    manifest = status["manifest"]
    assert manifest["version"] == worker.INDEX_VERSION
    assert manifest["updatedAt"] == "2025-01-02T00:00:00+00:00"
    assert manifest["retrievalMode"] == "vector" and manifest["embeddingDimension"] == 16
    assert manifest["embeddingModelKey"] == worker.build_embedding_model_key(options["embeddingProvider"])
    assert [item["relativePath"] for item in manifest["files"]] == ["a.txt", "b.txt"]
    assert manifest["chunkCount"] == 2 and manifest["documentCount"] == 2
    # Old JSON files are gone; the database (plus the small marker) replaces them.
    assert sorted(path.name for path in index.iterdir()) == ["index.sqlite", "manifest.json"]
    assert [document["summary"] for document in read_documents(index)] == ["solar panels", "wind turbines"]

    # Nothing is re-extracted or re-embedded after migration.
    calls = []
    monkeypatch.setattr(worker, "embed_texts", lambda p, t, **k: calls.append(len(t)) or fake_embed(p, t))
    monkeypatch.setattr(worker, "embed_query", lambda p, t, **k: fake_embed(p, [t])[0])
    monkeypatch.setattr(worker, "extract_document", lambda path: pytest.fail("should reuse migrated chunks"))
    result = build(root, index, options)
    assert result["stats"]["unchanged"] == 2 and not calls
    hits = worker.search_index(root, "wind turbines", 1, options, index_path=index)
    assert hits[0]["relativePath"] == "b.txt" and hits[0]["chunkId"] == "b.txt:0:legacy1"


def test_unreadable_json_index_is_replaced_by_build(tree, tmp_path):
    root = tree({"a.txt": "alpha"})
    index = tmp_path / "idx"
    index.mkdir()
    (index / "manifest.json").write_text(json.dumps({"version": 3, "files": "nonsense"}), encoding="utf-8")
    result = build(root, index)
    assert result["stats"]["added"] == 1
    assert db_path(index).exists()


# ---------------------------------------------------------------------------
# Incremental row updates
# ---------------------------------------------------------------------------


def test_incremental_sync_only_touches_changed_rows(tree, tmp_path):
    index = tmp_path / "idx"
    root = tree({"a.txt": "alpha apple", "b.txt": "bravo banana", "c.txt": "charlie cherry"})
    build(root, index)
    before = chunk_rows(index)

    (root / "b.txt").write_text("bravo zulu", encoding="utf-8")
    stat_result = (root / "b.txt").stat()
    os.utime(root / "b.txt", (stat_result.st_atime, stat_result.st_mtime + 10))
    (root / "c.txt").unlink()
    (root / "d.txt").write_text("delta date", encoding="utf-8")
    result = build(root, index)
    assert result["stats"] == {"added": 1, "updated": 1, "removed": 1, "unchanged": 1, "failed": 0, "skipped": 0}

    after = chunk_rows(index)
    assert after["a.txt"] == before["a.txt"]  # untouched row
    assert after["b.txt"] != before["b.txt"]  # replaced
    assert "c.txt" not in after
    fts_integrity_check(index)
    assert search(root, index, "charlie") == []
    assert search(root, index, "banana") == []
    assert [hit["relativePath"] for hit in search(root, index, "zulu")] == ["b.txt"]
    assert [hit["relativePath"] for hit in search(root, index, "date")] == ["d.txt"]
    with open_index_db(index) as conn:
        assert conn.execute("SELECT count(*) FROM documents").fetchone()[0] == 3
        assert {row[0] for row in conn.execute("SELECT relative_path FROM files")} == {"a.txt", "b.txt", "d.txt"}


def test_vector_rows_follow_chunks(tree, tmp_path, monkeypatch):
    monkeypatch.setattr(worker, "embed_texts", lambda p, t, **k: fake_embed(p, t))
    index = tmp_path / "idx"
    root = tree({"a.txt": "solar panels", "b.txt": "wind turbines"})
    build(root, index, vector_options("m1"))
    (root / "b.txt").unlink()
    build(root, index, vector_options("m1"))
    with open_index_db(index) as conn:
        assert conn.execute("SELECT count(*) FROM vectors").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM vectors v LEFT JOIN chunks c ON c.id = v.chunk_id WHERE c.id IS NULL").fetchone()[0] == 0
    # Switching to keyword search keeps the vectors and the embedding metadata.
    manifest = build(root, index)["manifest"]
    assert manifest["retrievalMode"] == "vectorless"
    assert manifest["embeddingModelKey"] and manifest["embeddingDimension"]
    with open_index_db(index) as conn:
        assert conn.execute("SELECT count(*) FROM vectors").fetchone()[0] == 1


def test_switching_between_keyword_and_semantic_search_does_not_re_embed(tree, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(worker, "embed_texts", lambda p, t, **k: calls.append(len(t)) or fake_embed(p, t))
    monkeypatch.setattr(worker, "embed_query", lambda p, t, **k: fake_embed(p, [t])[0])
    index = tmp_path / "idx"
    root = tree({"a.txt": "solar panels", "b.txt": "wind turbines"})
    build(root, index, vector_options("m1"))
    assert sum(calls) == 2

    calls.clear()
    keyword = build(root, index)
    assert keyword["manifest"]["retrievalMode"] == "vectorless" and not calls
    # A file changed while using keyword search: its old vector goes with its old chunks.
    (root / "b.txt").write_text("hydro dams", encoding="utf-8")
    stat_result = (root / "b.txt").stat()
    os.utime(root / "b.txt", (stat_result.st_atime, stat_result.st_mtime + 10))
    build(root, index)
    assert not calls

    # Back to semantic search: only the changed file is embedded; the unchanged one is reused.
    back = build(root, index, vector_options("m1"))
    assert sum(calls) == 1 and back["manifest"]["retrievalMode"] == "vector"
    assert worker.search_index(root, "solar", 1, vector_options("m1"), index_path=index)[0]["relativePath"] == "a.txt"

    # A different embedding model does invalidate the stored vectors.
    calls.clear()
    build(root, index)
    build(root, index, vector_options("m2"))
    assert sum(calls) == 2


def test_meta_and_manifest_shape(tree, tmp_path):
    root = tree({"b.txt": "bravo", "A.txt": "alpha"})
    index = tmp_path / "idx"
    manifest = build(root, index)["manifest"]
    assert set(manifest) == {
        "version", "rootPath", "createdAt", "updatedAt", "files", "chunkCount", "documentCount", "retrievalMode", "indexEngine",
    }
    assert [item["relativePath"] for item in manifest["files"]] == ["A.txt", "b.txt"]
    assert read_manifest(index) == manifest
    with open_index_db(index) as conn:
        meta = read_meta(conn)
    assert meta["version"] == 4 and meta["rootPath"] == str(root) and meta["dataVersion"]


# ---------------------------------------------------------------------------
# Keyword search
# ---------------------------------------------------------------------------


def test_fts_query_escaping():
    expression = worker.fts_match_expression('say "hi" NEAR(alpha beta) -gamma text:delta x* ^eps (zeta OR')
    assert expression == '"say" OR "hi" OR "NEAR" OR "alpha" OR "beta" OR "gamma" OR "text" OR "delta" OR "eps" OR "zeta" OR "OR"'
    assert worker.fts_match_expression('" * - ( ) : ^ a') is None


@pytest.mark.parametrize(
    "query",
    [
        '"',
        '"unbalanced',
        "alpha*",
        "NEAR(alpha beta)",
        "alpha NEAR beta",
        "NEAR/2 alpha",
        "-alpha",
        "alpha -beta",
        "(alpha OR",
        "alpha AND NOT beta",
        "text:alpha",
        "{text relative_path}: alpha",
        "^alpha",
        'alpha"beta',
        "***",
        "",
        "a",
    ],
)
def test_hostile_queries_never_reach_fts_syntax(tree, tmp_path, query):
    root = tree({"one.txt": "alpha beta gamma", "two.txt": "alphabet soup"})
    index = tmp_path / "idx"
    build(root, index)
    results = search(root, index, query)
    paths = [hit["relativePath"] for hit in results]
    assert "two.txt" not in paths  # `alpha*` is not a prefix query
    if "alpha" in query.lower():
        assert paths and paths[0] == "one.txt"


def test_operator_words_are_plain_terms(tree, tmp_path):
    root = tree({"drill.txt": "this is NOT a drill", "other.txt": "nothing here"})
    index = tmp_path / "idx"
    build(root, index)
    assert [hit["relativePath"] for hit in search(root, index, "NOT")] == ["drill.txt"]


def test_identifier_and_diacritic_matching(tree, tmp_path):
    root = tree({"code.txt": "call snake_case_name and Café-Menu here", "other.txt": "case study"})
    index = tmp_path / "idx"
    build(root, index)
    hits = search(root, index, "snake_case_name")
    assert hits[0]["relativePath"] == "code.txt"
    assert search(root, index, "cafe")[0]["relativePath"] == "code.txt"
    assert search(root, index, "CAFÉ menu")[0]["relativePath"] == "code.txt"


def test_document_ids_filter_applies_to_text_and_path_matches(tree, tmp_path):
    root = tree(
        {
            "budget/plan.txt": "numbers for next year",
            "other/plan.txt": "unrelated words",
            "x/budget-notes.txt": "something else",
        }
    )
    index = tmp_path / "idx"
    build(root, index)
    unfiltered = [hit["relativePath"] for hit in search(root, index, "budget numbers")]
    assert unfiltered[0] == rel("budget/plan.txt") and rel("x/budget-notes.txt") in unfiltered
    assert rel("other/plan.txt") not in unfiltered
    assert search(root, index, "budget", document_ids=[rel("other/plan.txt")]) == []
    only_notes = search(root, index, "budget numbers", document_ids=[rel("x/budget-notes.txt")])
    assert [hit["relativePath"] for hit in only_notes] == [rel("x/budget-notes.txt")]
    assert only_notes[0]["score"] == pytest.approx(worker.PATH_MATCH_BOOST)
    text_only = search(root, index, "numbers", document_ids=[rel("budget/plan.txt"), rel("other/plan.txt")])
    assert [hit["relativePath"] for hit in text_only] == [rel("budget/plan.txt")]


def test_search_result_fields(tree, tmp_path):
    root = tree({"a.txt": "alpha"})
    index = tmp_path / "idx"
    build(root, index)
    (hit,) = search(root, index, "alpha")
    assert set(hit) == {"chunkId", "relativePath", "score", "snippet", "text"}
    assert hit["score"] > 0 and hit["chunkId"].startswith("a.txt:0:")


# ---------------------------------------------------------------------------
# Quantized vectors
# ---------------------------------------------------------------------------


def test_quantized_vector_search_matches_float32():
    rng = np.random.default_rng(42)
    vectors = rng.standard_normal((3000, 256)).astype(np.float32)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    quantized = [quantize_vector(vector) for vector in vectors]
    data = np.frombuffer(b"".join(item[2] for item in quantized), dtype=np.int8).reshape(len(vectors), 256)
    norms = np.linalg.norm(data.astype(np.float32), axis=1)
    matrix = VectorMatrix("v", np.arange(len(vectors), dtype=np.int64), data, (1.0 / norms).astype(np.float32))

    overlaps = []
    for _ in range(50):
        # Queries near stored vectors, like real retrieval (a relevant chunk exists).
        query = vectors[rng.integers(len(vectors))] + 0.8 * rng.standard_normal(256).astype(np.float32) / 16
        query /= np.linalg.norm(query)
        exact = vectors @ query
        approx = cosine_scores(matrix, query)
        assert np.max(np.abs(exact - approx)) < 0.02
        top_exact = set(np.argsort(-exact)[:10].tolist())
        top_approx = set(np.argsort(-approx)[:10].tolist())
        overlaps.append(len(top_exact & top_approx) / 10)
        assert int(np.argmax(exact)) == int(np.argmax(approx))
    assert float(np.mean(overlaps)) >= 0.9


def test_quantize_round_trip():
    vector = np.array([3.0, -4.0, 0.0, 0.5], dtype=np.float32)
    dimension, scale, data = quantize_vector(vector)
    assert dimension == 4 and len(data) == 4
    restored = np.frombuffer(data, dtype=np.int8).astype(np.float32) * scale
    assert np.allclose(restored, vector / np.linalg.norm(vector), atol=scale)
