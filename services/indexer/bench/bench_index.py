"""Indexer benchmark on a synthetic folder.

    python services/indexer/bench/bench_index.py [--files 3000] [--large 4] [--workers N] [--vector]

Reports first build, no-change sync, 1-file-change sync, keyword (and optionally vector)
query latency and peak memory of this process. Worker events are serialized to os.devnull
so their cost is included. Extraction child processes are not included in peak memory.
"""

from __future__ import annotations

import argparse
import ctypes
import os
import random
import shutil
import statistics
import sys
import tempfile
import time
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parents[1] / "fschat_indexer"
sys.path.insert(0, str(PACKAGE_DIR))

import numpy as np  # noqa: E402

import worker  # noqa: E402

WORDS = (
    "budget forecast revenue invoice contract renewal policy premium claim adjuster vehicle "
    "property liability coverage deductible underwriting quote broker agent customer report "
    "quarterly annual summary meeting notes roadmap migration database index search keyword "
    "semantic vector embedding chunk document folder spreadsheet chart diagram figure image "
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november"
).split()


def peak_memory_mb() -> float:
    if os.name == "nt":
        class Counters(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32")
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.K32GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
        kernel32.K32GetProcessMemoryInfo.restype = ctypes.c_int
        counters = Counters()
        counters.cb = ctypes.sizeof(Counters)
        kernel32.K32GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb)
        return counters.PeakWorkingSetSize / 1024 / 1024
    import resource

    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / 1024 / 1024 if sys.platform == "darwin" else peak / 1024


def paragraph(rng: random.Random, words: int) -> str:
    tokens = [rng.choice(WORDS) for _ in range(words)]
    tokens.append(f"ID_{rng.randint(1000, 9999)}-{rng.choice('ABCDEF')}")
    return " ".join(tokens) + ".\n"


def generate(root: Path, files: int, large: int, seed: int = 7) -> None:
    rng = random.Random(seed)
    for index in range(files):
        folder = root / f"dept{index % 30:02d}" / f"team{index % 7}"
        folder.mkdir(parents=True, exist_ok=True)
        body = "".join(paragraph(rng, rng.randint(30, 120)) for _ in range(rng.randint(1, 4)))
        (folder / f"note_{index:05d}.txt").write_text(body, encoding="utf-8")
    big = root / "archive"
    big.mkdir(exist_ok=True)
    for index in range(large):
        with (big / f"large_{index}.md").open("w", encoding="utf-8") as handle:
            for _ in range(6000):
                handle.write(paragraph(rng, 50))


def fake_embed(provider, texts, **_kwargs):
    vectors = []
    for text in texts:
        seed = int.from_bytes(worker.hash_text(text)[:8].encode(), "little") % (2**32)
        vectors.append(np.random.default_rng(seed).standard_normal(384).astype(np.float32).tolist())
    return vectors


def timed(label: str, func, results: dict):
    started = time.perf_counter()
    value = func()
    results[label] = time.perf_counter() - started
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--files", type=int, default=3000)
    parser.add_argument("--large", type=int, default=4)
    parser.add_argument("--workers", type=int, default=None)
    parser.add_argument("--queries", type=int, default=50)
    parser.add_argument("--vector", action="store_true", help="also benchmark vector mode with a fake local embedder")
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()

    base = Path(tempfile.mkdtemp(prefix="hello-files-bench-"))
    root, index = base / "root", base / "index"
    root.mkdir()
    real_stdout = sys.stdout
    report = lambda line: print(line, file=real_stdout, flush=True)  # noqa: E731
    try:
        started = time.perf_counter()
        generate(root, args.files, args.large)
        report(f"generated {args.files} small + {args.large} large files in {time.perf_counter() - started:.1f}s at {root}")

        options = {"retrieval": {"mode": "vectorless"}}
        if args.workers:
            options["maxWorkers"] = args.workers
        results: dict[str, float] = {}
        sys.stdout = open(os.devnull, "w", encoding="utf-8")  # protocol events
        first = timed("first build", lambda: worker.build_index("bench", root, options, index_path=index), results)
        second = timed("no-change sync", lambda: worker.build_index("bench", root, options, index_path=index), results)
        target = root / "dept00" / "team0" / "note_00000.txt"
        target.write_text(target.read_text(encoding="utf-8") + "\nzeppelin appended line\n", encoding="utf-8")
        third = timed("1-file change sync", lambda: worker.build_index("bench", root, options, index_path=index), results)

        rng = random.Random(3)
        queries = [" ".join(rng.sample(WORDS, rng.randint(1, 4))) for _ in range(args.queries)]
        queries += ["budget dept03 report", "chart of quarterly revenue", "ID_1234-A", '"policy" NEAR (claim*) -premium']
        latencies = []
        for query in queries:
            started = time.perf_counter()
            worker.search_index(root, query, 8, options, index_path=index)
            latencies.append((time.perf_counter() - started) * 1000)

        vector_results: dict[str, float] = {}
        vector_latencies: list[float] = []
        if args.vector:
            worker.embed_texts = fake_embed
            worker.embed_query = lambda provider, text, **kw: fake_embed(provider, [text])[0]
            vector_options = {
                **options,
                "retrieval": {"mode": "vector"},
                "embeddingProvider": {"provider": "openai", "model": "fake-384", "apiKey": "x"},
            }
            vector_index = base / "vector-index"
            timed("vector first build", lambda: worker.build_index("bench-v", root, vector_options, index_path=vector_index), vector_results)
            timed("vector no-change sync", lambda: worker.build_index("bench-v", root, vector_options, index_path=vector_index), vector_results)
            for query in queries:
                started = time.perf_counter()
                worker.search_index(root, query, 8, vector_options, index_path=vector_index)
                vector_latencies.append((time.perf_counter() - started) * 1000)
        sys.stdout.close()
        sys.stdout = real_stdout

        manifest = first["manifest"]
        report(f"workers={worker.resolve_build_options(options).max_workers} cpu={os.cpu_count()} chunks={manifest['chunkCount']}")
        report(f"first build stats: {first['stats']}")
        report(f"no-change stats: {second['stats']}")
        report(f"1-file stats: {third['stats']}")
        for label, seconds in {**results, **vector_results}.items():
            report(f"{label:24s} {seconds:8.2f} s")
        for label, values in (("keyword query", latencies), ("vector query", vector_latencies)):
            if values:
                ordered = sorted(values)
                p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
                report(
                    f"{label:24s} first {values[0]:.1f} ms, median {statistics.median(values):.1f} ms, "
                    f"p95 {p95:.1f} ms, max {ordered[-1]:.1f} ms ({len(values)} queries)"
                )
        size_mb = sum(path.stat().st_size for path in index.rglob("*") if path.is_file()) / 1024 / 1024
        report(f"index size {size_mb:.1f} MB; peak memory (this process) {peak_memory_mb():.0f} MB")
    finally:
        sys.stdout = real_stdout
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    main()
