import { Children, cloneElement, isValidElement, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Copy, FileSpreadsheet } from "lucide-react";
import { copyText } from "../../lib/rich-export";
import { toCsv, toMarkdownTable } from "../../lib/table-export";
import { ActionButton, BlockToolbar } from "./toolbar";

/** Rows rendered before "Show all" (the copy actions always use every row). */
export const TABLE_ROW_CAP = 500;

/** Minimal hast shape (react-markdown passes the hast element as `node`). */
export interface HastLike {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastLike[];
}

function hastText(node: HastLike): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "br") return "\n";
  return (node.children ?? []).map(hastText).join("");
}

/** Extracts the table as a grid of plain-text cells (header row first). */
export function hastTableToRows(table: HastLike | undefined): string[][] {
  const rows: string[][] = [];
  const visit = (node: HastLike) => {
    if (node.tagName === "tr") {
      rows.push(
        (node.children ?? [])
          .filter((cell) => cell.tagName === "th" || cell.tagName === "td")
          .map((cell) => hastText(cell).trim())
      );
      return;
    }
    (node.children ?? []).forEach(visit);
  };
  if (table) visit(table);
  return rows;
}

export function TableBlock({ node, children }: { node?: HastLike; children?: ReactNode }) {
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => hastTableToRows(node), [node]);
  const bodyRowCount = Math.max(0, rows.length - 1);
  const capped = !showAll && bodyRowCount > TABLE_ROW_CAP;

  const rendered = capped
    ? Children.map(children, (child) => {
        if (!isValidElement(child) || child.type !== "tbody") return child;
        const tbody = child as ReactElement<{ children?: ReactNode }>;
        const bodyRows = Children.toArray(tbody.props.children).filter(isValidElement).slice(0, TABLE_ROW_CAP);
        return cloneElement(tbody, undefined, bodyRows);
      })
    : children;

  const columns = rows[0]?.length ?? 0;
  const summary = `Table · ${bodyRowCount} row${bodyRowCount === 1 ? "" : "s"} × ${columns} column${columns === 1 ? "" : "s"}`;

  return (
    <div className="rich-block">
      <BlockToolbar title={summary} label="Table actions">
        <ActionButton icon={FileSpreadsheet} label="Copy as CSV" doneLabel="Copied" action={() => copyText(toCsv(rows))} />
        <ActionButton icon={Copy} label="Copy as Markdown" doneLabel="Copied" action={() => copyText(toMarkdownTable(rows))} />
      </BlockToolbar>
      <div className="rich-table-scroll" tabIndex={0} aria-label={summary} role="region">
        <table>{rendered}</table>
      </div>
      {capped ? (
        <div className="rich-note">
          Showing the first {TABLE_ROW_CAP} of {bodyRowCount} rows.{" "}
          <button type="button" className="font-medium text-accent underline underline-offset-2" onClick={() => setShowAll(true)}>
            Show all rows
          </button>
        </div>
      ) : null}
    </div>
  );
}
