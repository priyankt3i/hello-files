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
