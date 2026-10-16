/**
 * Pure helpers that turn a rectangular grid of cell strings into CSV or a GFM Markdown table.
 * Used by the table and chart toolbars ("Copy as CSV", "Copy as Markdown", "Copy data as CSV").
 * Row 0 is treated as the header row.
 */

/** RFC 4180 CSV. Cells containing a comma, quote, CR or LF are quoted; quotes are doubled. Lines end with CRLF. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value: string): string {
  // Neutralise spreadsheet formula injection: a leading =, +, -, @ (or tab/CR) gets a leading quote,
  // unless the cell is a plain number such as "-12.5".
  let cell = value;
  if (/^[=+\-@\t\r]/.test(cell) && !/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(cell)) {
    cell = `'${cell}`;
  }
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** GFM pipe table. Pipes and backslashes are escaped and newlines become spaces. Short rows are padded. */
export function toMarkdownTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const width = Math.max(1, ...rows.map((row) => row.length));
  const line = (row: readonly string[]) =>
    `| ${Array.from({ length: width }, (_, index) => mdCell(row[index] ?? "")).join(" | ")} |`;
  const [header, ...body] = rows;
  return [line(header), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(line)].join("\n");
}

function mdCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
