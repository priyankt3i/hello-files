from __future__ import annotations

import ctypes
import os
import sys
import time

import pytest

import worker
from conftest import VECTORLESS
from index_store import legacy_index_path, old_index_path, read_chunk_metadata, read_manifest, temp_index_path


def build(root, index_path=None, force=False, channel="c1", **options):
    return worker.build_index(channel, root, {**VECTORLESS, **options}, force=force, index_path=index_path)


def statuses(result):
    return {item["relativePath"].replace("\\", "/"): item["status"] for item in result["files"]}


def bump_mtime(path):
    stat = path.stat()
    os.utime(path, (stat.st_atime, stat.st_mtime + 10))


def test_size_cap_marks_file_skipped(tree, tmp_path):
    root = tree({"small.txt": "tiny file", "big.txt": "x" * 3000})
    result = build(root, tmp_path / "idx", maxFileSizeMb=0.001)
    assert statuses(result) == {"small.txt": "indexed", "big.txt": "skipped"}
    big = next(item for item in result["files"] if item["relativePath"] == "big.txt")
    assert big["errorReason"] == "Larger than 0.001 MB limit"
    assert big["chunks"] == 0
    assert result["stats"]["skipped"] == 1


def test_default_size_limit():
    assert worker.resolve_build_options({}).max_file_size_mb == 50
    assert worker.format_megabytes(50.0) == "50"


def test_incremental_build_stats(tree, tmp_path):
    index = tmp_path / "idx"
    root = tree({"a.txt": "alpha content", "b.txt": "bravo content", "c.txt": "charlie content"})
    first = build(root, index)
    assert first["stats"] == {"added": 3, "updated": 0, "removed": 0, "unchanged": 0, "failed": 0, "skipped": 0}

    (root / "b.txt").write_text("bravo content changed", encoding="utf-8")
    bump_mtime(root / "b.txt")
    (root / "c.txt").unlink()
    (root / "d.txt").write_text("delta content", encoding="utf-8")
    (root / "e.bin").write_bytes(b"\x00\x01\x02" * 10)

    second = build(root, index)
    assert second["stats"] == {"added": 1, "updated": 1, "removed": 1, "unchanged": 1, "failed": 1, "skipped": 0}
    assert statuses(second) == {"a.txt": "indexed", "b.txt": "indexed", "d.txt": "indexed", "e.bin": "failed"}
    chunk_text = {chunk["relativePath"]: chunk["text"] for chunk in read_chunk_metadata(index)}
    assert chunk_text == {"a.txt": "alpha content", "b.txt": "bravo content changed", "d.txt": "delta content"}


def test_reuses_unchanged_files_without_reextracting(tree, tmp_path, monkeypatch):
    index = tmp_path / "idx"
    root = tree({"a.txt": "alpha", "b.txt": "bravo"})
    build(root, index)
    calls = []
    original = worker.extract_document
    monkeypatch.setattr(worker, "extract_document", lambda path: calls.append(path.name) or original(path))
    (root / "b.txt").write_text("bravo two", encoding="utf-8")
    bump_mtime(root / "b.txt")
    build(root, index)
    assert calls == ["b.txt"]


def test_touched_but_identical_file_is_reused_by_hash(tree, tmp_path, monkeypatch):
    index = tmp_path / "idx"
    root = tree({"a.txt": "alpha"})
    build(root, index)
    bump_mtime(root / "a.txt")
    monkeypatch.setattr(worker, "extract_document", lambda path: pytest.fail("should not re-extract"))
    result = build(root, index)
    assert result["stats"]["unchanged"] == 1
    # mtime is refreshed in the manifest so the next build is stat-only.
    assert read_manifest(index)["files"][0]["mtime"] == (root / "a.txt").stat().st_mtime


def test_no_change_build_does_not_rewrite_index(tree, tmp_path):
    index = tmp_path / "idx"
    root = tree({"a.txt": "alpha", "b.txt": "bravo", "big.txt": "x" * 3000})
    first = build(root, index, maxFileSizeMb=0.001)
    manifest_file = index / "manifest.json"
    before = manifest_file.stat().st_mtime_ns
    time.sleep(0.05)
    second = build(root, index, maxFileSizeMb=0.001)
    assert second["manifest"]["updatedAt"] == first["manifest"]["updatedAt"]
    assert manifest_file.stat().st_mtime_ns == before
    assert second["stats"] == {"added": 0, "updated": 0, "removed": 0, "unchanged": 2, "failed": 0, "skipped": 1}
    assert not temp_index_path(index).exists()


def test_force_rebuild_rewrites(tree, tmp_path):
    index = tmp_path / "idx"
    root = tree({"a.txt": "alpha"})
    first = build(root, index)
    time.sleep(0.01)
    second = build(root, index, force=True)
    assert second["manifest"]["updatedAt"] != first["manifest"]["updatedAt"]
    assert second["stats"]["updated"] == 1


def test_file_deleted_mid_build_does_not_abort(tree, tmp_path, monkeypatch):
    root = tree({"a.txt": "alpha", "b.txt": "bravo"})
    original = worker.discover_files

    def discover_then_delete(*args, **kwargs):
        files = original(*args, **kwargs)
        (root / "a.txt").unlink()
        return files

    monkeypatch.setattr(worker, "discover_files", discover_then_delete)
    result = build(root, tmp_path / "idx")
    assert statuses(result) == {"b.txt": "indexed"}


def test_cancel_while_idle_does_not_poison_next_build(tree, tmp_path, capsys):
    root = tree({"a.txt": "alpha"})
    worker.handle_request({"id": "1", "method": "cancel_build", "payload": {"channelId": "c1", "retainPartial": False}})
    assert '"cancelled": false' in capsys.readouterr().out
    assert "c1" not in worker.CANCELLED_CHANNELS
    # Even a stale flag left behind by an earlier build is cleared at build start.
    worker.CANCELLED_CHANNELS["c1"] = worker.CancelRequest(retain_partial=False, sequence=0)
    result = build(root, tmp_path / "idx")
    assert result["cancelled"] is False
    assert statuses(result) == {"a.txt": "indexed"}


def test_cancel_discard_keeps_previous_index(tree, tmp_path, monkeypatch):
    index = tmp_path / "idx"
    root = tree({"a.txt": "alpha", "b.txt": "bravo"})
    first = build(root, index)
    (root / "a.txt").write_text("alpha two", encoding="utf-8")
    bump_mtime(root / "a.txt")

    original_ensure = worker.ensure_not_cancelled

    def cancel_then_check(*args, **kwargs):
        worker.register_build("c1")
        worker.request_cancel("c1", retain_partial=False)
        return original_ensure(*args, **kwargs)

    monkeypatch.setattr(worker, "ensure_not_cancelled", cancel_then_check)
    monkeypatch.setattr(worker, "extract_document", lambda path: pytest.fail("cancelled"))
    result = build(root, index)
    assert result["cancelled"] is True and result["manifest"] is None
    assert read_manifest(index)["updatedAt"] == first["manifest"]["updatedAt"]


def test_retain_partial_keeps_previous_entries(tree, tmp_path, monkeypatch):
    index = tmp_path / "idx"
    root = tree({"a.txt": "alpha", "b.txt": "bravo", "c.txt": "charlie"})
    build(root, index)
    (root / "a.txt").write_text("alpha two", encoding="utf-8")
    bump_mtime(root / "a.txt")
    (root / "d.txt").write_text("delta", encoding="utf-8")

    original = worker.extract_document

    def cancel_after_first(path):
        worker.register_build("c1")
        worker.request_cancel("c1", retain_partial=True)
        return original(path)

    monkeypatch.setattr(worker, "extract_document", cancel_after_first)
    result = build(root, index)
    assert result["cancelled"] is True and result["retainedPartial"] is True
    # a.txt was re-extracted; b/c carried over from the previous index; d.txt was never reached.
    assert statuses(result) == {"a.txt": "indexed", "b.txt": "indexed", "c.txt": "indexed"}
    texts = {chunk["relativePath"]: chunk["text"] for chunk in read_chunk_metadata(index)}
    assert texts == {"a.txt": "alpha two", "b.txt": "bravo", "c.txt": "charlie"}


def test_index_path_outside_root(tree, tmp_path):
    root = tree({"a.txt": "alpha"})
    index = tmp_path / "appdata" / "indexes" / "chan"
    build(root, index)
    assert (index / "manifest.json").exists()
    assert not legacy_index_path(root).exists()
    assert [path.name for path in index.parent.iterdir()] == ["chan"]
    if sys.platform == "win32":
        attributes = ctypes.windll.kernel32.GetFileAttributesW(str(index))
        assert not attributes & 0x02


def test_legacy_fallback_and_migration(tree, tmp_path, capsys):
    root = tree({"a.txt": "alpha"})
    build(root, None)
    assert (legacy_index_path(root) / "manifest.json").exists()
    worker.handle_request({"id": "s", "method": "get_index_status", "payload": {"rootPath": str(root)}})
    assert '"exists": true' in capsys.readouterr().out
    if sys.platform == "win32":
        attributes = ctypes.windll.kernel32.GetFileAttributesW(str(legacy_index_path(root)))
        assert attributes & 0x02

    index = tmp_path / "new-index"
    result = build(root, index)
    assert (index / "manifest.json").exists()
    assert result["stats"]["unchanged"] == 1  # reused from the legacy in-folder index


def test_commit_recovers_from_interrupted_swap(tree, tmp_path):
    index = tmp_path / "idx"
    root = tree({"a.txt": "alpha"})
    build(root, index)
    index.replace(old_index_path(index))  # simulate a crash after "final -> old"
    result = build(root, index)
    assert result["stats"]["unchanged"] == 1
    assert not old_index_path(index).exists()


def test_svg_indexed_as_text(tree, tmp_path):
    root = tree({"logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'><title>Company logo</title></svg>"})
    result = build(root, tmp_path / "idx")
    assert result["files"][0]["status"] == "indexed"
    assert result["files"][0]["parser"] == "text"


def test_error_response_is_concise(capsys):
    worker.handle_request({"id": "x", "method": "open_index", "payload": {}})
    captured = capsys.readouterr()
    assert "Missing required field 'rootPath'." in captured.out
    assert "Traceback" not in captured.out
    assert "Traceback" in captured.err
