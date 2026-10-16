import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, FolderOpen } from "lucide-react";
import type { FileIndexStatus, IndexedFileRecord } from "@fschat/shared";
import { cx, fileName, formatBytes, formatNumber } from "../../lib/format";
import { IconButton } from "../ui/button";
import { FileTypeIcon } from "./file-type-icon";

export type SortKey = "path" | "size" | "chunks" | "status";
const ROW_HEIGHT = 40;
const OVERSCAN = 12;
const COLUMNS = "grid-cols-[minmax(0,1fr)_88px_72px_104px_minmax(0,0.8fr)_72px]";

const STATUS_STYLE: Record<FileIndexStatus, { label: string; className: string }> = {
  indexed: { label: "Indexed", className: "text-success" },
  failed: { label: "Failed", className: "text-danger" },
  skipped: { label: "Skipped", className: "text-text-muted" }
};

/**
 * Dense, sortable file table with simple windowing (only visible rows are rendered),
 * so it stays responsive with thousands of files.
 */
export function FileTable({
  files,
  onOpen,
  onReveal
}: {
  files: IndexedFileRecord[];
  onOpen: (relativePath: string) => void;
  onReveal: (relativePath: string) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "path", dir: 1 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const sorted = useMemo(() => {
    const copy = [...files];
    const { key, dir } = sort;
    copy.sort((a, b) => {
      let result = 0;
      if (key === "size") result = a.size - b.size;
      else if (key === "chunks") result = a.chunks - b.chunks;
      else if (key === "status") result = a.status.localeCompare(b.status);
      if (result === 0) result = a.relativePath.localeCompare(b.relativePath);
      return result * dir;
    });
    return copy;
  }, [files, sort]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(sorted.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const rows = sorted.slice(start, end);

  function header(key: SortKey, label: string, align: "left" | "right" = "left") {
    const active = sort.key === key;
    return (
      <button
        type="button"
        onClick={() => setSort((current) => ({ key, dir: current.key === key ? ((current.dir * -1) as 1 | -1) : 1 }))}
        aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
        className={cx("inline-flex items-center gap-1 hover:text-text", align === "right" && "justify-end", active && "text-text")}
      >
        {label}
        {active ? sort.dir === 1 ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden /> : null}
      </button>
    );
  }

  return (
    <div role="table" aria-label="Files" aria-rowcount={sorted.length} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface shadow-card">
      <div role="row" className={cx("grid shrink-0 items-center gap-3 border-b border-border bg-surface-2 py-2 pl-3 pr-[22px] text-xs font-medium text-text-muted", COLUMNS)}>
        <div role="columnheader">{header("path", "File")}</div>
        <div role="columnheader" className="text-right">{header("size", "Size", "right")}</div>
        <div role="columnheader" className="text-right">{header("chunks", "Sections", "right")}</div>
        <div role="columnheader">{header("status", "Status")}</div>
        <div role="columnheader">Details</div>
        <div role="columnheader" className="sr-only">Actions</div>
      </div>
      <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-scroll" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        <div style={{ height: sorted.length * ROW_HEIGHT, position: "relative" }}>
          {rows.map((file, offset) => {
            const status = STATUS_STYLE[file.status] ?? STATUS_STYLE.indexed;
            return (
              <div
                key={file.relativePath}
                role="row"
                className={cx("group absolute inset-x-0 grid items-center gap-3 border-b border-border/60 px-3 text-sm hover:bg-surface-2", COLUMNS)}
                style={{ top: (start + offset) * ROW_HEIGHT, height: ROW_HEIGHT }}
              >
                <div role="cell" className="flex min-w-0 items-center gap-2" title={file.relativePath}>
                  <FileTypeIcon path={file.relativePath} />
                  <span className="min-w-0 truncate">
                    <span className="text-text">{fileName(file.relativePath)}</span>
                    {file.relativePath !== fileName(file.relativePath) ? (
                      <span className="ml-2 text-xs text-text-muted">{file.relativePath.slice(0, -fileName(file.relativePath).length - 1)}</span>
                    ) : null}
                  </span>
                </div>
                <div role="cell" className="text-right text-xs tabular-nums text-text-muted">{formatBytes(file.size)}</div>
                <div role="cell" className="text-right text-xs tabular-nums text-text-muted">{file.status === "indexed" ? formatNumber(file.chunks) : "—"}</div>
                <div role="cell" className={cx("text-xs font-medium", status.className)}>{status.label}</div>
                <div role="cell" className="truncate text-xs text-text-muted" title={file.errorReason ?? undefined}>
                  {file.errorReason ?? ""}
                </div>
                <div role="cell" className="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100">
                  <IconButton icon={ExternalLink} label={`Open ${fileName(file.relativePath)}`} size="sm" onClick={() => onOpen(file.relativePath)} />
                  <IconButton icon={FolderOpen} label="Show in folder" size="sm" onClick={() => onReveal(file.relativePath)} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
