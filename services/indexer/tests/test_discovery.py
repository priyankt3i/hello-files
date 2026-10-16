from __future__ import annotations

import ctypes
import os
import sys

import pytest

import worker


def discovered(root, **options):
    build_options = worker.resolve_build_options(options)
    index_path = options.pop("_index_path", None)
    return sorted(item.relative_path.replace("\\", "/") for item in worker.discover_files(root, build_options, index_path=index_path))


def test_ignored_directories_at_any_depth(tree):
    root = tree(
        {
            "keep.txt": "hello",
            "a/b/node_modules/pkg/index.js": "x",
            "a/.git/config": "x",
            "deep/x/__pycache__/m.pyc": "x",
            "deep/venv/lib.py": "x",
            "nested/.fschat-index/manifest.json": "{}",
            "nested/.fschat-index.tmp/manifest.json": "{}",
            "nested/real.md": "doc",
            "proj/.vs/settings.json": "x",
            "proj/.idea/workspace.xml": "x",
        }
    )
    assert discovered(root) == ["keep.txt", "nested/real.md"]


def test_hidden_and_junk_files_skipped(tree):
    root = tree(
        {
            "report.docx.txt": "ok",
            ".env": "SECRET=1",
            ".hidden/inner.txt": "x",
            "~$report.docx": "lock",
            "Thumbs.db": "x",
            "sub/desktop.ini": "x",
        }
    )
    assert discovered(root) == ["report.docx.txt"]
    assert ".env" in discovered(root, includeHidden=True)
    assert ".hidden/inner.txt" in discovered(root, includeHidden=True)
    # Lock files / OS junk are skipped even when hidden files are included.
    assert "~$report.docx" not in discovered(root, includeHidden=True)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows hidden attribute")
def test_windows_hidden_attribute(tree):
    root = tree({"visible.txt": "a", "secret.txt": "b", "hiddendir/file.txt": "c"})
    for name in ("secret.txt", "hiddendir"):
        ctypes.windll.kernel32.SetFileAttributesW(str(root / name), 0x02)
    assert discovered(root) == ["visible.txt"]
    assert discovered(root, includeHidden=True) == ["hiddendir/file.txt", "secret.txt", "visible.txt"]


def test_symlink_outside_root_skipped(tmp_path, tree):
    root = tree({"inside.txt": "in"})
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("out", encoding="utf-8")
    try:
        os.symlink(outside / "secret.txt", root / "link.txt")
        os.symlink(outside, root / "linkdir", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("Symlinks cannot be created on this platform/account.")
    assert discovered(root) == ["inside.txt"]


def test_exclude_patterns_and_index_dir_inside_root(tree):
    root = tree(
        {
            "a.tmp": "x",
            "docs/b.tmp": "x",
            "archive/old/c.txt": "x",
            "docs/keep.txt": "x",
            "my-index/manifest.json": "{}",
        }
    )
    result = discovered(root, excludePatterns=["**/*.tmp", "archive/**"], _index_path=root / "my-index")
    assert result == ["docs/keep.txt"]


def test_glob_basename_pattern_matches_any_depth():
    pattern = worker.compile_glob("*.log")
    assert pattern.match("a.log")
    assert pattern.match("x/y/a.LOG")
    assert not pattern.match("x/a.log.txt")


def test_include_and_exclude_file_filters(tree):
    root = tree(
        {
            "FR_01_Order.docx": "x",
            "sub/FR_02_Invoice.pdf": "x",
            "sub/FR_03_Test Result_Summary.docx": "x",
            "sub/FR_04_Notes.md": "x",
            "sub/General_Spec.docx": "x",
            "sub/Data.xlsx": "x",
        }
    )
    # 1. Exclude *Test Result* and *.md
    assert discovered(root, excludePatterns=["*Test Result*", "*.md"]) == [
        "FR_01_Order.docx",
        "sub/Data.xlsx",
        "sub/FR_02_Invoice.pdf",
        "sub/General_Spec.docx",
    ]
    # 2. Include file types docx, pdf, xlsx OR filenames containing FR (a union), while excluding *Test Result* and *.md
    assert discovered(
        root,
        excludePatterns=[
            "!*.doc",
            "!*.docx",
            "!*.pdf",
            "!*.xlsx",
            "!*FR*",
            "*Test Result*",
            "*.md",
        ],
    ) == [
        "FR_01_Order.docx",
        "sub/Data.xlsx",
        "sub/FR_02_Invoice.pdf",
        "sub/General_Spec.docx",
    ]


def test_include_types_and_names_combine(tree):
    root = tree({"A.java": "x", "b.docx": "x", "c.txt": "x", "FR_notes.txt": "x", "sub/D.java": "x"})
    assert discovered(root, excludePatterns=["!*.docx", "!*.java"]) == ["A.java", "b.docx", "sub/D.java"]
    assert discovered(root, excludePatterns=["!*.docx", "!*FR*"]) == ["FR_notes.txt", "b.docx"]
    assert discovered(root, excludePatterns=["!*.docx", "!*.java", "!*FR*"]) == [
        "A.java",
        "FR_notes.txt",
        "b.docx",
        "sub/D.java",
    ]


def test_rule_excluded_files_are_reported_with_reason(tree):
    root = tree(
        {
            "keep.txt": "x",
            "a.tmp": "x",
            "archive/old/c.txt": "x",
            "archive/.git/config": "x",
            "node_modules/pkg/index.js": "x",
            "notes.md": "x",
        }
    )
    skipped: list = []
    options = worker.resolve_build_options({"excludePatterns": ["*.tmp", "archive/**", "*.md"]})
    kept = worker.discover_files(root, options, skipped=skipped)
    assert [item.relative_path for item in kept] == ["keep.txt"]
    reasons = {item.relative_path.replace("\\", "/"): item.skip_reason for item in skipped}
    assert reasons == {
        "a.tmp": "Excluded by rule: *.tmp",
        "archive/old/c.txt": "Excluded by rule: archive/**",
        "notes.md": "Excluded by rule: *.md",
    }


def test_include_filter_misses_are_reported(tree):
    root = tree({"a.pdf": "x", "b.txt": "x"})
    skipped: list = []
    options = worker.resolve_build_options({"excludePatterns": ["!*.pdf"]})
    kept = worker.discover_files(root, options, skipped=skipped)
    assert [item.relative_path for item in kept] == ["a.pdf"]
    assert [(item.relative_path, item.skip_reason) for item in skipped] == [("b.txt", "Not one of the file types to include")]
