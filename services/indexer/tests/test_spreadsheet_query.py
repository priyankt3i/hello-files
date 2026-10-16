from __future__ import annotations

import gc
import json
import os
import queue
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime

import pytest

import spreadsheet_sql as sheets
import worker
from conftest import VECTORLESS

openpyxl = pytest.importorskip("openpyxl")

CLAIMS = "claims_xlsx__claims"
POLICIES = "claims_xlsx__policies"

CLAIM_ROWS = [
    # id, state, status, paid, loss date, days to close, zip
    (1, "TX", "Open", 100.50, datetime(2024, 1, 5), None, "07030"),
    (2, "TX", "Closed", 200, datetime(2024, 1, 20), 10, "75001"),
    (3, "CA", "Open", 50.25, datetime(2024, 2, 10), None, "90001"),
    (4, "CA", "Closed", 300, datetime(2024, 2, 11), 20, "90002"),
    (5, "TX", "Open", None, datetime(2024, 3, 1), None, "75002"),
    (6, "FL", "Closed", 99.99, datetime(2024, 3, 15), 5, "33101"),
    (7, "TX", "Open", "N/A", datetime(2024, 3, 20), None, "75003"),
]


def write_workbook(path, claim_rows=CLAIM_ROWS):
    book = openpyxl.Workbook()
    claims = book.active
    claims.title = "Claims"
    # Messy headers: padded spaces, symbols, a blank header cell and a duplicate.
    claims.append([" Claim  ID ", "State", "Status", "Paid Amount ($)", "Loss Date", "Days to Close", "Zip", None, "Status"])
    for row in claim_rows:
        claims.append(list(row) + [None, "dup"])
    policies = book.create_sheet("Policies")
    policies.append(["Policy Report 2024"])  # preamble row before the header
    policies.append(["Policy", "Premium", "Active"])
    policies.append(["P1", 1000.0, True])
    policies.append(["P2", 2500.5, False])
    policies.append(["P3", 1500, True])
    book.create_sheet("Empty")
    book.save(path)


CSV_TEXT = (
    "Policy,Premium,Effective,Count\n"
    'P1,"$1,200.50",01/15/2024,3\n'
    'P2,"(300.00)",2/3/2024,\n'
    "P3,n/a,2024-03-01,5\n"
    "P4,500,13/02/2024,1\n"
)


@pytest.fixture
def env(tree, tmp_path):
    root = tree({"people.csv": CSV_TEXT})
    write_workbook(root / "claims.xlsx")
    index = tmp_path / "idx"
    worker.build_index("c", root, VECTORLESS, index_path=index)
    sheets.clear_spreadsheet_cache()
    yield root, index
    sheets.clear_spreadsheet_cache()


def schema(env, ids=None):
    root, index = env
    return sheets.spreadsheet_schema(root, index, ids)


def query(env, sql, ids=("claims.xlsx",), **kwargs):
    root, index = env
    return sheets.spreadsheet_query(root, index, list(ids), sql, **kwargs)


def query_error(env, sql, ids=("claims.xlsx",), **kwargs) -> str:
    with pytest.raises(sheets.SpreadsheetQueryError) as caught:
        query(env, sql, ids, **kwargs)
    return str(caught.value)


def sheet_by_table(payload, table):
    for document in payload["documents"]:
        for sheet in document["sheets"]:
            if sheet["table"] == table:
                return sheet
    raise AssertionError(f"table {table} not in schema")


# ---------------------------------------------------------------------------
# Schema inference
# ---------------------------------------------------------------------------


def test_schema_tables_columns_and_types(env):
    payload = schema(env, ["claims.xlsx"])
    document = payload["documents"][0]
    assert document["document"] == "claims.xlsx"
    assert [sheet["table"] for sheet in document["sheets"]] == [CLAIMS, POLICIES]  # empty sheet is not a table

    claims = sheet_by_table(payload, CLAIMS)
    assert claims["sheet"] == "Claims" and claims["rowCount"] == 7 and claims["headerRow"] == 1
    by_name = {column["name"]: column for column in claims["columns"]}
    assert [column["name"] for column in claims["columns"]] == [
        "claim_id", "state", "status", "paid_amount_usd", "loss_date", "days_to_close", "zip", "column_8", "status_9",
    ]
    assert by_name["claim_id"]["original"] == "Claim ID"  # whitespace collapsed
    assert by_name["claim_id"]["type"] == "integer"
    assert by_name["state"]["type"] == "text"
    assert by_name["paid_amount_usd"]["type"] == "real"
    assert by_name["loss_date"]["type"] == "date"
    assert by_name["days_to_close"]["type"] == "integer"
    assert by_name["zip"]["type"] == "text"  # leading zero kept
    assert by_name["column_8"]["original"] == "Column 8"  # blank header cell
    assert by_name["status_9"]["original"] == "Status (9)"  # duplicate header
    assert by_name["paid_amount_usd"]["nonNull"] == 5
    assert by_name["days_to_close"]["nonNull"] == 3
    assert by_name["state"]["values"] == ["CA", "FL", "TX"]  # low-cardinality text lists its values
    assert "values" not in by_name["claim_id"]
    # Cells that could not be read as numbers stay available as text.
    assert by_name["paid_amount_usd"]["rawColumn"] == "paid_amount_usd_raw"
    assert claims["sampleRows"] == [
        [1, "TX", "Open", 100.5, "2024-01-05", None, "07030", None, "dup"],
        [2, "TX", "Closed", 200, "2024-01-20", 10, "75001", None, "dup"],
        [3, "CA", "Open", 50.25, "2024-02-10", None, "90001", None, "dup"],
    ]


def test_schema_preamble_row_is_not_data_and_bool_column(env):
    policies = sheet_by_table(schema(env, ["claims.xlsx"]), POLICIES)
    assert policies["rowCount"] == 3 and policies["headerRow"] == 2
    types = {column["name"]: column["type"] for column in policies["columns"]}
    assert types == {"policy": "text", "premium": "real", "active": "integer"}


def test_csv_coercion_money_dates_and_null_tokens(env):
    payload = schema(env, ["people.csv"])
    people = sheet_by_table(payload, "people_csv")
    assert people["sheet"] == "people.csv" and people["rowCount"] == 4
    types = {column["name"]: column["type"] for column in people["columns"]}
    assert types == {"policy": "text", "premium": "real", "effective": "date", "count": "integer"}
    result = query(env, "SELECT sum(premium), min(effective), max(effective), sum(count) FROM people_csv", ids=["people.csv"])
    assert result["rows"] == [[1400.5, "2024-01-15", "2024-03-01", 9]]
    # "n/a" is a null placeholder, not a value; "13/02/2024" can only be day-first.
    dates = query(env, "SELECT effective FROM people_csv ORDER BY policy", ids=["people.csv"])["rows"]
    assert dates == [["2024-01-15"], ["2024-02-03"], ["2024-03-01"], ["2024-02-13"]]


def test_unmatched_cells_become_null_and_raw_text_is_kept(env):
    result = query(env, f"SELECT claim_id, paid_amount_usd, paid_amount_usd_raw FROM {CLAIMS} WHERE claim_id IN (5, 7) ORDER BY claim_id")
    assert result["rows"] == [[5, None, None], [7, None, "N/A"]]


def test_multiple_documents_and_stable_unique_table_names(tree, tmp_path):
    root = tree({})
    for folder in ("a", "b"):
        (root / folder).mkdir()
        write_workbook(root / folder / "claims.xlsx")
    index = tmp_path / "idx"
    worker.build_index("c", root, VECTORLESS, index_path=index)
    payload = sheets.spreadsheet_schema(root, index, None)  # no ids: every spreadsheet document
    names = [sheet["table"] for document in payload["documents"] for sheet in document["sheets"]]
    assert names == [CLAIMS, POLICIES, "claims_xlsx__claims_2", "claims_xlsx__policies_2"]
    again = sheets.spreadsheet_schema(root, index, ["b/claims.xlsx", "a/claims.xlsx"])
    assert [sheet["table"] for document in again["documents"] for sheet in document["sheets"]] == names


def test_unknown_document_and_unreadable_file(env):
    root, _ = env
    assert "is not an indexed spreadsheet" in query_error(env, "SELECT 1", ids=["missing.xlsx"])
    gc.collect()  # the indexer's openpyxl reader leaves the workbook open until collected (Windows locks it)
    (root / "claims.xlsx").unlink()
    sheets.clear_spreadsheet_cache()
    payload = schema(env, ["claims.xlsx"])
    assert payload["documents"] == [] and payload["skipped"][0]["document"] == "claims.xlsx"
    assert "No spreadsheet data could be loaded" in query_error(env, "SELECT 1")


# ---------------------------------------------------------------------------
# Calculations versus hand-computed values
# ---------------------------------------------------------------------------


def test_counts_sums_and_averages_match_hand_computation(env):
    assert query(env, f"SELECT count(*) FROM {CLAIMS}")["rows"] == [[7]]
    assert query(env, f"SELECT count(*) FROM {CLAIMS} WHERE state = 'TX' AND status = 'Open'")["rows"] == [[3]]
    assert query(env, f"SELECT round(sum(paid_amount_usd), 2) FROM {CLAIMS}")["rows"] == [[750.74]]
    assert query(env, f"SELECT round(avg(paid_amount_usd), 3) FROM {CLAIMS}")["rows"] == [[150.148]]  # 750.74 / 5 non-null
    assert query(env, f"SELECT round(avg(days_to_close), 4) FROM {CLAIMS}")["rows"] == [[11.6667]]  # (10 + 20 + 5) / 3
    assert query(env, f"SELECT min(paid_amount_usd), max(paid_amount_usd) FROM {CLAIMS}")["rows"] == [[50.25, 300]]


def test_group_by_and_date_bucketing(env):
    by_state = query(env, f"SELECT state, count(*) AS n, round(sum(paid_amount_usd), 2) AS paid FROM {CLAIMS} GROUP BY state ORDER BY state")
    assert by_state["columns"] == ["state", "n", "paid"]
    assert by_state["rows"] == [["CA", 2, 350.25], ["FL", 1, 99.99], ["TX", 4, 300.5]]
    by_month = query(env, f"SELECT strftime('%Y-%m', loss_date) AS month, count(*) FROM {CLAIMS} GROUP BY month ORDER BY month")
    assert by_month["rows"] == [["2024-01", 2], ["2024-02", 2], ["2024-03", 3]]


def test_null_handling(env):
    assert query(env, f"SELECT count(*), count(paid_amount_usd) FROM {CLAIMS}")["rows"] == [[7, 5]]
    assert query(env, f"SELECT count(*) FROM {CLAIMS} WHERE paid_amount_usd IS NULL")["rows"] == [[2]]
    assert query(env, f"SELECT sum(days_to_close) FROM {CLAIMS} WHERE status = 'Open'")["rows"] == [[None]]
    assert query(env, f"SELECT coalesce(sum(days_to_close), 0) FROM {CLAIMS} WHERE status = 'Open'")["rows"] == [[0]]
    assert query(env, f"SELECT total(days_to_close) FROM {CLAIMS} WHERE status = 'Open'")["rows"] == [[0.0]]


def test_source_row_numbers_and_joins_across_sheets(env):
    assert query(env, f"SELECT _row FROM {CLAIMS} WHERE claim_id = 3")["rows"] == [[4]]  # sheet row, header is row 1
    joined = query(
        env,
        f"SELECT count(*) FROM {CLAIMS} c JOIN {POLICIES} p ON p.policy = 'P' || c.claim_id",
    )
    assert joined["rows"] == [[3]]
    assert {item["table"] for item in joined["tablesUsed"]} == {CLAIMS, POLICIES}
    used = query(env, f"SELECT count(*) FROM {CLAIMS}")["tablesUsed"]
    assert used == [{"document": "claims.xlsx", "sheet": "Claims", "table": CLAIMS}]


def test_cte_window_and_trailing_semicolon_and_comments(env):
    result = query(
        env,
        f"WITH t AS (SELECT state, count(*) AS n FROM {CLAIMS} GROUP BY state) "
        "SELECT state, rank() OVER (ORDER BY n DESC) AS r FROM t ORDER BY r, state; -- done",
    )
    assert result["rows"][0] == ["TX", 1]


def test_result_values_are_json_safe(env):
    result = query(env, "SELECT 1e308 * 10, 9007199254740993, 0.1 + 0.2")
    assert json.dumps(result)  # no Infinity / NaN
    assert result["rows"] == [[None, "9007199254740993", 0.3]]


# ---------------------------------------------------------------------------
# Safety
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "sql",
    [
        "ATTACH DATABASE 'other.db' AS other",
        "PRAGMA table_info(claims_xlsx__claims)",
        f"DROP TABLE {CLAIMS}",
        f"INSERT INTO {CLAIMS} (state) VALUES ('ZZ')",
        f"UPDATE {CLAIMS} SET state = 'ZZ'",
        f"DELETE FROM {CLAIMS}",
        "CREATE TABLE x (a)",
        "VACUUM",
        "EXPLAIN SELECT 1",
        "SELECT 1; SELECT 2",
        f"SELECT 1; DROP TABLE {CLAIMS}",
        "",
        "   ;  ",
    ],
)
def test_non_select_statements_are_rejected_cleanly(env, sql):
    message = query_error(env, sql)
    assert message and "Traceback" not in message
    assert query(env, f"SELECT count(*) FROM {CLAIMS}")["rows"] == [[7]]


@pytest.mark.parametrize(
    "sql, expected",
    [
        ("SELECT load_extension('evil.dll')", "'load_extension' is not allowed"),
        ("SELECT random()", "'random' is not allowed"),
        ("SELECT sqlite_version()", "is not allowed"),
        ("SELECT randomblob(10)", "is not allowed"),
        ("SELECT json_extract('{}', '$')", "is not allowed"),
        ("SELECT * FROM sqlite_master", "'sqlite_master' is not allowed"),
        ("SELECT * FROM sqlite_schema", "is not allowed"),
        ("SELECT * FROM sqlite_temp_master", "is not allowed"),
        ("SELECT * FROM pragma_table_info('claims_xlsx__claims')", "is not allowed"),
        ("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c", "is not allowed"),
    ],
)
def test_authorizer_blocks_dangerous_reads_and_functions(env, sql, expected):
    assert expected in query_error(env, sql)


def test_authorizer_denies_every_write_action_even_without_the_prefix_check(env):
    root, index = env
    tables, _, _ = sheets._load_tables(root, index, ["claims.xlsx"])
    connection = sheets._build_database(tables)
    try:
        sheets._lock_down(connection, {item.table.lower(): item for item in tables}, [], {}, [time.monotonic() + 60])
        for statement in (
            "ATTACH DATABASE ':memory:' AS other",
            f"PRAGMA table_info({CLAIMS})",
            "PRAGMA query_only = OFF",
            f"DROP TABLE {CLAIMS}",
            f"INSERT INTO {CLAIMS} (state) VALUES ('ZZ')",
            f"UPDATE {CLAIMS} SET state = 'ZZ'",
            f"DELETE FROM {CLAIMS}",
            "CREATE TABLE x (a)",
            "CREATE TEMP TABLE x (a)",
            "CREATE VIEW v AS SELECT 1",
            f"ALTER TABLE {CLAIMS} ADD COLUMN z",
            "VACUUM",
            "ANALYZE",
            "BEGIN",
        ):
            with pytest.raises(sqlite3.Error):
                connection.execute(statement)
        assert connection.execute(f"SELECT count(*) FROM {CLAIMS}").fetchone() == (7,)
    finally:
        connection.close()


def test_double_quoted_unknown_names_are_errors_not_string_literals(env):
    message = query_error(env, f'SELECT count(*) FROM {CLAIMS} WHERE state = "Texas"')
    assert "no such column" in message and "Available tables and columns" in message


def test_runaway_cross_join_times_out(env, tmp_path):
    root, index = env
    rows = [(number, "TX", "Open", 1.5, datetime(2024, 1, 1), 1, "00001") for number in range(3000)]
    write_workbook(root / "claims.xlsx", rows)
    started = time.monotonic()
    message = query_error(env, f"SELECT count(*) FROM {CLAIMS} a, {CLAIMS} b, {CLAIMS} c, {CLAIMS} d", timeout_seconds=0.3)
    assert "longer than 0.3 seconds" in message and "Simplify" in message
    assert time.monotonic() - started < 10


def test_row_cap_and_truncated_flag(env):
    root, _ = env
    rows = [(number, "TX", "Open", 1.5, datetime(2024, 1, 1), 1, "00001") for number in range(1500)]
    write_workbook(root / "claims.xlsx", rows)
    default = query(env, f"SELECT claim_id FROM {CLAIMS} ORDER BY claim_id")
    assert default["rowCount"] == 200 and len(default["rows"]) == 200 and default["truncated"] is True
    assert default["rows"][-1] == [199]
    exact = query(env, f"SELECT claim_id FROM {CLAIMS}", max_rows=1500)
    assert exact["rowCount"] == sheets.HARD_MAX_ROWS and exact["truncated"] is True  # hard cap
    small = query(env, f"SELECT claim_id FROM {CLAIMS} LIMIT 5")
    assert small["rowCount"] == 5 and small["truncated"] is False
    exactly_at_cap = query(env, f"SELECT claim_id FROM {CLAIMS} LIMIT 10", max_rows=10)
    assert exactly_at_cap["rowCount"] == 10 and exactly_at_cap["truncated"] is False
    # A huge join stops at the cap instead of materialising millions of rows.
    started = time.monotonic()
    joined = query(env, f"SELECT a._row FROM {CLAIMS} a, {CLAIMS} b")
    assert joined["truncated"] is True and joined["rowCount"] == 200 and time.monotonic() - started < 5


def test_error_messages_are_clean(env):
    assert "no such column: nope" in query_error(env, f"SELECT nope FROM {CLAIMS}")
    assert "claims_xlsx__claims(" in query_error(env, f"SELECT nope FROM {CLAIMS}")  # lists the real columns
    assert "no such table: missing" in query_error(env, "SELECT * FROM missing")
    assert "syntax error" in query_error(env, f"SELECT FROM {CLAIMS} WHERE")
    assert query_error(env, "x" * 9000).startswith("The SQL query is too long")
    assert "Only a single read-only SELECT" in query_error(env, "delete from nowhere")
    assert "at least one" in query_error(env, "SELECT 1", ids=[]).lower()


def test_query_does_not_modify_files_or_leak_state_between_calls(env):
    root, _ = env
    before = (root / "claims.xlsx").read_bytes()
    query(env, f"SELECT count(*) FROM {CLAIMS}")
    query_error(env, f"DELETE FROM {CLAIMS}")
    assert (root / "claims.xlsx").read_bytes() == before
    assert query(env, f"SELECT count(*) FROM {CLAIMS}")["rows"] == [[7]]


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


def test_cache_reuses_parsed_file_and_invalidates_when_it_changes(env, monkeypatch):
    root, _ = env
    reads = []
    original = sheets._read_xlsx_rows
    monkeypatch.setattr(sheets, "_read_xlsx_rows", lambda path: reads.append(path) or original(path))

    assert query(env, f"SELECT count(*) FROM {CLAIMS}")["rows"] == [[7]]
    schema(env, ["claims.xlsx"])
    assert query(env, f"SELECT count(*) FROM {CLAIMS}")["rows"] == [[7]]
    assert len(reads) == 1

    write_workbook(root / "claims.xlsx", CLAIM_ROWS + [(8, "NY", "Open", 10, datetime(2024, 4, 1), None, "10001")])
    stat = (root / "claims.xlsx").stat()
    os.utime(root / "claims.xlsx", (stat.st_atime, stat.st_mtime + 10))
    assert query(env, f"SELECT count(*) FROM {CLAIMS}")["rows"] == [[8]]
    assert sheet_by_table(schema(env, ["claims.xlsx"]), CLAIMS)["rowCount"] == 8
    assert len(reads) == 2


def test_cache_is_bounded(env, monkeypatch):
    monkeypatch.setattr(sheets, "CACHE_CELL_BUDGET", 1)
    schema(env, ["claims.xlsx"])
    schema(env, ["people.csv"])
    assert len(sheets._CACHE) == 1


# ---------------------------------------------------------------------------
# Protocol: drive worker.py over stdin/stdout like Electron
# ---------------------------------------------------------------------------


def test_protocol_schema_and_query_over_stdin(env):
    root, index = env
    process = subprocess.Popen(
        [sys.executable, worker.__file__],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
    )
    lines: queue.Queue = queue.Queue()
    reader = threading.Thread(target=lambda: [lines.put(line) for line in process.stdout], daemon=True)
    reader.start()

    def call(request_id, method, payload):
        process.stdin.write(json.dumps({"id": request_id, "method": method, "payload": payload}) + "\n")
        process.stdin.flush()
        deadline = time.monotonic() + 60
        while True:
            message = json.loads(lines.get(timeout=max(0.1, deadline - time.monotonic())))  # every line is JSON
            if message.get("id") == request_id:
                return message

    base = {"rootPath": str(root), "indexPath": str(index)}
    try:
        reply = call("1", "spreadsheet_schema", {**base, "documentIds": ["claims.xlsx"]})
        assert reply["ok"] and reply["payload"]["documents"][0]["sheets"][0]["table"] == CLAIMS

        reply = call(
            "2",
            "spreadsheet_query",
            {**base, "documentIds": ["claims.xlsx"], "sql": f"SELECT state, count(*) FROM {CLAIMS} GROUP BY state ORDER BY state"},
        )
        assert reply["ok"]
        payload = reply["payload"]
        assert payload["rows"] == [["CA", 2], ["FL", 1], ["TX", 4]]
        assert payload["columns"] == ["state", "count(*)"] and payload["rowCount"] == 3 and payload["truncated"] is False
        assert payload["tablesUsed"] == [{"document": "claims.xlsx", "sheet": "Claims", "table": CLAIMS}]
        assert payload["sql"].startswith("SELECT state")

        reply = call("3", "spreadsheet_query", {**base, "documentIds": ["claims.xlsx"], "sql": "SELECT nope FROM claims_xlsx__claims"})
        assert reply["ok"] is False and reply["error"].startswith("SQL error: no such column: nope")

        reply = call("4", "spreadsheet_query", {**base, "documentIds": ["claims.xlsx"], "sql": "ATTACH DATABASE 'x' AS y"})
        assert reply["ok"] is False and "read-only SELECT" in reply["error"]

        reply = call("5", "spreadsheet_query", {**base, "sql": "SELECT 1"})
        assert reply["ok"] is False and "documentIds" in reply["error"]
    finally:
        process.stdin.close()
        process.wait(timeout=30)
        reader.join(timeout=10)
        process.stdout.close()
