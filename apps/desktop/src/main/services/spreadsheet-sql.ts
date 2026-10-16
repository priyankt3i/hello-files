import type {
  Citation,
  MessageCalculation,
  SpreadsheetSheetSchema,
  WorkerSpreadsheetQueryResponse,
  WorkerSpreadsheetSchemaResponse
} from "@fschat/shared";

/**
 * Pure helpers for exact spreadsheet calculations: intent detection, the SQL-generation prompts,
 * validation of the model's reply and formatting of the result for the answer call.
 * Nothing here does I/O, so it can be checked with a throwaway script.
 */

export const RESULT_ROWS_IN_NOTE = 50;
const MAX_SAMPLE_CELL_CHARS = 60;
const MAX_TABLE_CELL_CHARS = 200;
const MAX_SQL_CHARS = 8000;
const MAX_DISPLAY_SQL_CHARS = 4000;

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

const PASSIVE_BY = /\b(written|signed|approved|created|prepared|submitted|authored|sent|owned|reviewed|issued|made|modified|updated|edited|followed|caused|driven|covered|governed|required)\s+by\b/g;

const ANALYTICAL_SIGNALS: Array<[string, RegExp]> = [
  ["count", /\b(how many|count|counts|number of|# of)\b/],
  ["total", /\b(totals?|sum|sums|add up|tally)\b/],
  ["how much", /\bhow much\b/],
  ["average", /\b(average|averages|avg|the mean|mean (?:of|for|value))\b/],
  ["extreme", /\b(minimum|maximum|min|max|highest|lowest|largest|smallest|biggest|greatest|most (?:common|frequent|expensive|costly)|least (?:common|frequent|expensive|costly))\b/],
  ["top n", /\b(top|bottom)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\b/],
  ["grouping", /\b(break ?down|breakdown|group(?:ed)? by|grouped|distribution|histogram)\b/],
  ["per", /\b(per|for each|each)\s+[a-z]/],
  ["by", /\bby\s+[a-z]/],
  ["trend", /\b(trends?|over time|month over month|year over year|monthly|quarterly|weekly|yearly|daily)\b/],
  ["chart", /\b(chart|charts|plot|graph|visuali[sz]e)\b/],
  ["compare", /\b(compare|compared|comparison|versus|vs)\b/],
  ["percent", /\b(percent|percentage|ratio|proportion|share of)\b|%/]
];

/**
 * True when the question asks for a calculation (count, total, average, grouping, trend, chart...)
 * that must be computed over every row instead of estimated from a handful of excerpts.
 * Biased toward recall: a false positive costs one extra model call, a false negative costs exactness.
 */
export function detectAnalyticalIntent(query: string): { analytical: boolean; signals: string[] } {
  const normalized = query.toLowerCase().replace(PASSIVE_BY, " ");
  const signals = ANALYTICAL_SIGNALS.filter(([, pattern]) => pattern.test(normalized)).map(([name]) => name);
  return { analytical: signals.length > 0, signals };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const SQL_GENERATION_SYSTEM_PROMPT = [
  "You translate a question about spreadsheet data into ONE read-only SQLite query.",
  'Reply with strict JSON only: {"sql": "SELECT ..."} or {"sql": null} when the question cannot be answered from the tables below.',
  "Rules:",
  "- One SELECT statement (a WITH ... SELECT is fine). No semicolons, comments, PRAGMA, writes or recursive queries.",
  "- Use only the tables and columns listed, spelled exactly as listed (lowercase, underscores). Do not select _row unless asked for row numbers.",
  "- String literals use single quotes. Never use double quotes for values.",
  "- Text comparison is case-sensitive: when a column lists its values, copy them exactly; otherwise compare with lower(column) = 'value'.",
  "- Dates are ISO text (YYYY-MM-DD, optionally with a time). Use strftime('%Y-%m', col), date(col) and ranges for months, years and periods.",
  "- Aggregates skip NULL. Columns typed text hold text even if they look numeric; only cast(col as real) when the question clearly needs it.",
  "- Round money and averages with round(x, 2). Give columns short aliases. Order grouped results largest first, or chronologically for dates.",
  "- Do not add LIMIT unless the question asks for a top N. Join sheets only when the question needs it.",
  "- Questions about the data itself (counts, totals, averages, groups, trends) need a query; if the question is about anything else, reply {\"sql\": null}."
].join("\n");

function formatSampleCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    const trimmed = value.length > MAX_SAMPLE_CELL_CHARS ? `${value.slice(0, MAX_SAMPLE_CELL_CHARS)}...` : value;
    return JSON.stringify(trimmed);
  }
  return String(value);
}

export function describeSheetForPrompt(sheet: SpreadsheetSheetSchema, documentPath: string): string {
  const lines: string[] = [`Table ${sheet.table}: sheet "${sheet.sheet}" in ${documentPath}, ${sheet.rowCount.toLocaleString("en-US")} data rows`];
  for (const column of sheet.columns) {
    const parts = [`- ${column.name} (${column.type})`];
    if (column.original && column.original.toLowerCase() !== column.name.replace(/_/g, " ")) {
      parts.push(`header "${column.original}"`);
    }
    if (column.values && column.values.length > 0) {
      parts.push(`values: ${column.values.map((value) => JSON.stringify(value)).join(", ")}`);
    }
    if (column.rawColumn) {
      parts.push(`${column.coerceFailures ?? 0} cell(s) not readable as ${column.type} are NULL here; their original text is in ${column.rawColumn}`);
    }
    lines.push(`  ${parts.join("; ")}`);
  }
  lines.push("  (every table also has _row: the source row number in the sheet)");
  if (sheet.sampleRows.length > 0) {
    lines.push(`  Sample rows (same column order as above):`);
    for (const row of sheet.sampleRows) {
      lines.push(`  [${row.map(formatSampleCell).join(", ")}]`);
    }
  }
  return lines.join("\n");
}

export function describeSchemaForPrompt(schema: WorkerSpreadsheetSchemaResponse): string {
  return schema.documents
    .flatMap((document) => document.sheets.map((sheet) => describeSheetForPrompt(sheet, document.document)))
    .join("\n\n");
}

export function buildSqlGenerationPrompt(args: {
  question: string;
  schema: WorkerSpreadsheetSchemaResponse;
  /** Earlier user questions in this thread, oldest first, so follow-ups ("and in Florida?") resolve. */
  recentQuestions?: string[];
  /** Set for the single repair attempt. */
  repair?: { sql: string; error: string };
}): { systemPrompt: string; prompt: string } {
  const recent = (args.recentQuestions ?? []).slice(-2).map((question) => `- ${question.replace(/\s+/g, " ").slice(0, 300)}`);
  const parts = ["Tables:", describeSchemaForPrompt(args.schema), ""];
  if (recent.length > 0) {
    parts.push("Earlier questions in this conversation (for context only):", ...recent, "");
  }
  parts.push(`Question: ${args.question.replace(/\s+/g, " ").trim()}`);
  if (args.repair) {
    parts.push(
      "",
      "Your previous query failed.",
      `Previous SQL: ${args.repair.sql.replace(/\s+/g, " ").slice(0, 2000)}`,
      `Error: ${args.repair.error.replace(/\s+/g, " ").slice(0, 1500)}`,
      'Return corrected JSON in the same shape, or {"sql": null} if the question cannot be answered.'
    );
  }
  return { systemPrompt: SQL_GENERATION_SYSTEM_PROMPT, prompt: parts.join("\n") };
}

// ---------------------------------------------------------------------------
// Parsing and validating the model's reply
// ---------------------------------------------------------------------------

export type SqlReply = { kind: "sql"; sql: string } | { kind: "none" } | { kind: "invalid"; reason: string };

function parseJsonLoosely(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  const braced = braceStart >= 0 && braceEnd > braceStart ? trimmed.slice(braceStart, braceEnd + 1) : "";
  for (const candidate of [trimmed, fenced, braced]) {
    if (!candidate) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Strips comments and string literals so structural checks do not trip over their contents. */
function stripSqlLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Validates the model's reply. This is a cheap first filter (shape, single statement, SELECT/WITH only);
 * the Python worker enforces the real safety rules with a SQLite authorizer.
 */
export function parseSqlReply(raw: string): SqlReply {
  const parsed = parseJsonLoosely(raw);
  let sql: unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "sql" in parsed) {
    sql = (parsed as { sql: unknown }).sql;
  } else {
    // Some models answer with a bare ```sql block instead of JSON.
    const block = raw.match(/```sql\s*([\s\S]*?)```/i)?.[1];
    if (block) {
      sql = block;
    } else if (parsed === undefined) {
      return { kind: "invalid", reason: "The reply was not valid JSON." };
    } else {
      return { kind: "invalid", reason: 'The reply had no "sql" field.' };
    }
  }

  if (sql === null) {
    return { kind: "none" };
  }
  if (typeof sql !== "string") {
    return { kind: "invalid", reason: '"sql" must be a string or null.' };
  }
  const trimmed = sql.trim().replace(/;+\s*$/, "").trim();
  if (!trimmed) {
    return { kind: "none" };
  }
  if (trimmed.length > MAX_SQL_CHARS) {
    return { kind: "invalid", reason: "The query is too long." };
  }
  const structural = stripSqlLiterals(trimmed);
  if (structural.includes(";")) {
    return { kind: "invalid", reason: "Only one statement is allowed." };
  }
  if (!/^\s*(select|with)\b/i.test(structural)) {
    return { kind: "invalid", reason: "Only SELECT queries are allowed." };
  }
  return { kind: "sql", sql: trimmed };
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatTableCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  const text = typeof value === "string" ? value : String(value);
  const flat = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > MAX_TABLE_CELL_CHARS ? `${flat.slice(0, MAX_TABLE_CELL_CHARS)}...` : flat;
}

/** Markdown table of at most `maxRows` rows, followed by a "N rows total" line. */
export function formatResultTable(
  result: Pick<WorkerSpreadsheetQueryResponse, "columns" | "rows" | "rowCount" | "truncated">,
  maxRows = RESULT_ROWS_IN_NOTE
): string {
  const header = `| ${result.columns.map((column) => formatTableCell(column)).join(" | ")} |`;
  const divider = `| ${result.columns.map(() => "---").join(" | ")} |`;
  const shown = result.rows.slice(0, maxRows);
  const body = shown.map((row) => `| ${row.map(formatTableCell).join(" | ")} |`);
  const total = `${result.rowCount.toLocaleString("en-US")}${result.truncated ? "+" : ""}`;
  let footer = `${total} row${result.rowCount === 1 && !result.truncated ? "" : "s"} total`;
  if (result.truncated) {
    footer += " (the result hit the row limit, so more rows exist that are not included)";
  }
  if (shown.length < result.rows.length) {
    footer += `; the first ${shown.length} are shown`;
  }
  return [header, divider, ...body, "", `${footer}.`].join("\n");
}

export function describeSheetLabel(document: string, sheet: string): string {
  // A CSV has one implicit sheet named after the file.
  return sheet === document.split(/[\\/]/).pop() ? document : `${document} > ${sheet}`;
}

function findSheet(schema: WorkerSpreadsheetSchemaResponse, document: string, table: string): SpreadsheetSheetSchema | undefined {
  return schema.documents.find((item) => item.document === document)?.sheets.find((sheet) => sheet.table === table);
}

export function buildCalculationNote(args: {
  sql: string;
  result: WorkerSpreadsheetQueryResponse;
  schema: WorkerSpreadsheetSchemaResponse;
}): string {
  const { sql, result, schema } = args;
  const sheets = result.tablesUsed.map((used) => {
    const rows = findSheet(schema, used.document, used.table)?.rowCount;
    return `${describeSheetLabel(used.document, used.sheet)}${rows !== undefined ? ` (${rows.toLocaleString("en-US")} rows)` : ""}`;
  });
  return [
    "EXACT CALCULATION RESULT. These numbers were computed by running a query over every row of the spreadsheet, not estimated.",
    "These numbers are exact; use them verbatim, do not recompute or re-derive them, and mention the sheet names in your answer.",
    "Any spreadsheet row excerpts below are only samples: do not count or sum them.",
    `Sheets used: ${sheets.join("; ")}`,
    `SQL: ${sanitizeCalculationSql(sql, 1500).replace(/\s+/g, " ")}`,
    "Result:",
    formatResultTable(result),
    ...(result.rowCount === 0 ? ["The query matched no rows: say that no matching data was found and state the conditions the SQL used."] : []),
    "If you add a ```chart block, use only numbers from this result table and set its \"source\" to the sheet name(s) above."
  ].join("\n");
}

/** Synthetic citations, one per sheet read, so the answer points at the calculated source. */
export function buildCalculationCitations(args: {
  result: Pick<WorkerSpreadsheetQueryResponse, "tablesUsed">;
  schema: WorkerSpreadsheetSchemaResponse;
}): Citation[] {
  return args.result.tablesUsed.map((used) => {
    const rows = findSheet(args.schema, used.document, used.table)?.rowCount;
    return {
      relativePath: used.document,
      chunkId: `calc:${used.document}#${used.sheet}`,
      score: 1,
      snippet: `Calculated from sheet '${used.sheet}'${rows !== undefined ? ` (${rows.toLocaleString("en-US")} rows)` : ""}`
    };
  });
}

/**
 * The SQL is model-generated, so it is cleaned before it is stored or shown: control characters
 * removed and length capped. The renderer displays it as plain text in a code block.
 */
export function sanitizeCalculationSql(sql: string, limit = MAX_DISPLAY_SQL_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = sql.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}...` : cleaned;
}

export function buildCalculation(args: { sql: string; result: Pick<WorkerSpreadsheetQueryResponse, "tablesUsed"> }): MessageCalculation {
  return {
    sql: sanitizeCalculationSql(args.sql),
    sheets: args.result.tablesUsed.map((used) => describeSheetLabel(used.document, used.sheet))
  };
}

/** Spreadsheet-like documents the worker can load (xlsx/xlsm/xls/csv). */
export function isTabularDocumentPath(relativePath: string, parser?: string): boolean {
  return parser === "spreadsheet" || parser === "spreadsheet-xls" || parser === "csv" || /\.(xlsx|xlsm|xls|csv)$/i.test(relativePath);
}
