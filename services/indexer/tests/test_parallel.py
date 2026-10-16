from __future__ import annotations

import multiprocessing
import time

import pytest

import worker
from conftest import VECTORLESS
from index_store import index_exists


def slow_batch(items):
    """Picklable stand-in for extract_batch_task that never finishes in time."""
    time.sleep(60)
    return []


@pytest.fixture
def force_parallel(monkeypatch):
    monkeypatch.setattr(worker, "PARALLEL_MIN_ESTIMATED_SECONDS", 0.0)
    monkeypatch.setattr(worker, "BATCH_MAX_FILES", 3)
    pools = []
    original = worker.create_extraction_pool
    monkeypatch.setattr(
        worker, "create_extraction_pool", lambda workers, **kwargs: pools.append(workers) or original(workers, **kwargs)
    )
    return pools


def wait_for_no_children(timeout=10.0):
    deadline = time.monotonic() + timeout
    while multiprocessing.active_children() and time.monotonic() < deadline:
        time.sleep(0.05)
    return multiprocessing.active_children()


def capture_file_updates(monkeypatch):
    updates = []
    original = worker.emit_file_update
    monkeypatch.setattr(worker, "emit_file_update", lambda payload: updates.append(payload["file"]) or original(payload))
    return updates


def test_parallel_extraction_with_failing_files(tree, tmp_path, monkeypatch, force_parallel):
    files = {f"doc{index:02d}.txt": f"document number {index} about topic{index}" for index in range(10)}
    files["bad.bin"] = b"\x00\x01\x02" * 50
    files["broken.pdf"] = b"this is not really a pdf"
    root = tree(files)
    updates = capture_file_updates(monkeypatch)
    result = worker.build_index("c", root, {**VECTORLESS, "maxWorkers": 2}, index_path=tmp_path / "idx")

    assert force_parallel == [2]
    statuses = {item["relativePath"]: item["status"] for item in result["files"]}
    assert statuses.pop("bad.bin") == "failed"
    assert statuses.pop("broken.pdf") == "failed"
    assert set(statuses.values()) == {"indexed"} and len(statuses) == 10
    assert result["stats"] == {"added": 10, "updated": 0, "removed": 0, "unchanged": 0, "failed": 2, "skipped": 0}
    # Events arrive in discovery order regardless of which worker finished first.
    assert [item["relativePath"] for item in updates] == sorted(files, key=str.lower)
    hits = worker.search_index(root, "topic7", 3, VECTORLESS, index_path=tmp_path / "idx")
    assert hits[0]["relativePath"] == "doc07.txt"
    assert not wait_for_no_children()


def test_cancel_discard_during_parallel_extraction(tree, tmp_path, monkeypatch, force_parallel):
    root = tree({f"doc{index:02d}.txt": f"content {index}" for index in range(30)})
    updates = []

    def cancel_after_two(payload):
        updates.append(payload["file"]["relativePath"])
        if len(updates) == 2:
            worker.register_build("c")
            worker.request_cancel("c", retain_partial=False)

    monkeypatch.setattr(worker, "emit_file_update", cancel_after_two)
    index = tmp_path / "idx"
    started = time.monotonic()
    result = worker.build_index("c", root, {**VECTORLESS, "maxWorkers": 2}, index_path=index)
    assert time.monotonic() - started < 30
    assert result["cancelled"] is True and result["manifest"] is None and result["retainedPartial"] is False
    assert len(updates) == 2 and force_parallel == [2]
    assert not index_exists(index)
    assert not worker.temp_index_path(index).exists()
    assert not wait_for_no_children()


def test_cancel_retain_partial_during_parallel_extraction(tree, tmp_path, monkeypatch, force_parallel):
    root = tree({f"doc{index:02d}.txt": f"content {index}" for index in range(30)})
    updates = []

    def cancel_after_five(payload):
        updates.append(payload["file"]["relativePath"])
        if len(updates) == 5:
            worker.register_build("c")
            worker.request_cancel("c", retain_partial=True)

    monkeypatch.setattr(worker, "emit_file_update", cancel_after_five)
    result = worker.build_index("c", root, {**VECTORLESS, "maxWorkers": 2}, index_path=tmp_path / "idx")
    assert result["cancelled"] is True and result["retainedPartial"] is True and force_parallel == [2]
    assert [item["relativePath"] for item in result["files"]] == updates == [f"doc{index:02d}.txt" for index in range(5)]
    assert not wait_for_no_children()


def test_cancel_is_prompt_while_waiting_on_a_slow_worker(tree, monkeypatch):
    monkeypatch.setattr(worker, "PARALLEL_MIN_ESTIMATED_SECONDS", 0.0)
    root = tree({f"f{index}.txt": "x" for index in range(4)})
    discovered = worker.discover_files(root)
    plans = [worker.FilePlan(item, "work", None, 1, item.stat.st_mtime) for item in discovered]
    deadline = time.monotonic() + 0.5

    def check_cancel(_relative_path):
        if time.monotonic() > deadline:
            raise worker.CancelledBuild(retain_partial=False)

    pipeline = worker.ExtractionPipeline(plans, 2, check_cancel)
    pipeline.batch_task = slow_batch
    assert pipeline.parallel
    started = time.monotonic()
    with pytest.raises(worker.CancelledBuild):
        pipeline.result_for(0)
    pipeline.close(cancel=True)
    assert time.monotonic() - started < 10  # not the 60 s the task would take
    assert not wait_for_no_children()


def test_small_batches_stay_in_process(tree, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(worker, "create_extraction_pool", lambda workers, **kwargs: calls.append(workers))
    root = tree({"a.txt": "alpha", "b.txt": "bravo", "c.txt": "charlie"})
    result = worker.build_index("c", root, {**VECTORLESS, "maxWorkers": 4}, index_path=tmp_path / "idx")
    assert result["stats"]["added"] == 3 and calls == []


def test_max_workers_option():
    assert worker.resolve_build_options({"maxWorkers": 3}).max_workers == 3
    assert worker.resolve_build_options({"maxWorkers": 0}).max_workers == 1
    assert worker.resolve_build_options({"maxWorkers": "bad"}).max_workers == worker.default_max_workers()
    assert 1 <= worker.default_max_workers() <= 4


def test_protocol_build_uses_pool_with_stdin_pipe(tree, tmp_path):
    """Regression: on Windows, spawned workers inherited the stdin pipe the protocol loop
    is blocked reading, and hung at start-up. Drive worker.py exactly like Electron does."""
    import json
    import queue
    import subprocess
    import sys
    import threading

    files = {f"scan{index}.pdf": b"%PDF-broken" for index in range(10)}  # "heavy" -> parallel
    files.update({f"note{index}.txt": f"note {index}" for index in range(3)})
    root = tree(files)
    worker_script = worker.__file__
    process = subprocess.Popen(
        [sys.executable, worker_script],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
    )
    lines: queue.Queue = queue.Queue()
    reader = threading.Thread(target=lambda: [lines.put(line) for line in process.stdout], daemon=True)
    reader.start()
    try:
        request = {
            "id": "1",
            "method": "build_index",
            "payload": {"rootPath": str(root), "indexPath": str(tmp_path / "idx"), "channelId": "c", "options": {**VECTORLESS, "maxWorkers": 2}},
        }
        process.stdin.write(json.dumps(request) + "\n")
        process.stdin.flush()
        deadline = time.monotonic() + 90
        response = None
        while response is None:
            message = json.loads(lines.get(timeout=max(0.1, deadline - time.monotonic())))  # every line is JSON
            if message.get("id") == "1":
                response = message
        assert response["ok"], response
        assert response["payload"]["stats"]["failed"] == 10 and response["payload"]["stats"]["added"] == 3
    finally:
        process.stdin.close()
        process.wait(timeout=30)
        reader.join(timeout=10)
        process.stdout.close()


def test_pool_that_never_starts_falls_back_to_in_process(tree, tmp_path, monkeypatch, force_parallel):
    monkeypatch.setattr(worker, "POOL_START_TIMEOUT_SECONDS", 0.0)
    original = worker.create_extraction_pool
    # Workers never report that they started (as if spawning hung).
    monkeypatch.setattr(worker, "create_extraction_pool", lambda workers, **kwargs: original(workers))
    warnings = []
    monkeypatch.setattr(worker, "log_warning", warnings.append)
    root = tree({f"doc{index:02d}.txt": f"content {index}" for index in range(8)})
    result = worker.build_index("c", root, {**VECTORLESS, "maxWorkers": 2}, index_path=tmp_path / "idx")
    assert result["stats"]["added"] == 8
    assert any("did not start" in message for message in warnings)
    assert not wait_for_no_children()
