from __future__ import annotations

import worker


def test_prefers_paragraph_boundary():
    first = "A" * 1000
    text = first + "\n\n" + "B" * 1500
    assert worker.split_text(text)[0] == first


def test_paragraph_beats_later_line_break():
    text = "A" * 950 + "\n\n" + "B" * 100 + "\n" + "C" * 1500
    assert worker.split_text(text)[0] == "A" * 950


def test_prefers_line_then_sentence_boundary():
    line_text = "x" * 950 + "\n" + "y" * 1000
    assert worker.split_text(line_text)[0] == "x" * 950

    sentence_text = ("word " * 190) + "End of sentence. " + ("tail " * 300)
    assert worker.split_text(sentence_text)[0].endswith("End of sentence.")


def test_ignores_boundary_outside_window():
    text = "a" * 100 + "\n\n" + "b" * 2000
    assert len(worker.split_text(text)[0]) == 1200


def test_hard_cut_keeps_size_and_overlap():
    text = "".join(chr(ord("a") + (index % 26)) for index in range(3000))
    chunks = worker.split_text(text)
    assert len(chunks[0]) == 1200
    assert all(len(chunk) <= 1200 for chunk in chunks)
    assert chunks[1].startswith(chunks[0][-200:])
    assert text.endswith(chunks[-1])


def test_spreadsheet_row_chunks_unchanged():
    payloads = worker.build_chunk_payloads(
        "ignored",
        [{"text": "# Sheet: S\nRow: 2\nName: Ann", "chunkType": "spreadsheet-row", "sheetName": "S", "rowNumber": 2}],
    )
    assert payloads == [{"text": "# Sheet: S\nRow: 2\nName: Ann", "chunkType": "spreadsheet-row", "sheetName": "S", "rowNumber": 2}]
