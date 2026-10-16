import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleMinus, FolderSearch, History, RefreshCw, Search } from "lucide-react";
import type { Channel, IndexedFileRecord } from "@fschat/shared";
import { cx, formatDateTime, formatNumber, formatRelativeTime } from "../../lib/format";
import { useAppStore } from "../../state/store";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/feedback";
import { SegmentedControl } from "../ui/form";
import { FileTable } from "./file-table";
import { IndexProgressPanel } from "./index-progress";

type Filter = "all" | "indexed" | "failed" | "skipped";

export function FilesView({ channel }: { channel: Channel }) {
  const { state, actions } = useAppStore();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const snapshot = state.snapshot?.channel.id === channel.id ? state.snapshot : null;
  const indexed = snapshot?.indexedFiles ?? [];
  const failed = snapshot?.failedFiles ?? [];
  const skipped = snapshot?.skippedFiles ?? [];
  const indexing = channel.status === "indexing";
  const stats = channel.lastIndexStats;

  const files = useMemo(() => {
    const source: IndexedFileRecord[] =
      filter === "indexed" ? indexed : filter === "failed" ? failed : filter === "skipped" ? skipped : [...indexed, ...failed, ...skipped];
    const needle = deferredQuery.trim().toLowerCase();
    return needle ? source.filter((file) => file.relativePath.toLowerCase().includes(needle)) : source;
  }, [filter, indexed, failed, skipped, deferredQuery]);

  const total = indexed.length + failed.length + skipped.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 py-5">
      {indexing ? <IndexProgressPanel channel={channel} progress={state.progressByChannel[channel.id]} /> : null}

      <div className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard icon={CircleCheck} tone="text-success" label="Indexed" value={formatNumber(indexed.length)} onClick={() => setFilter("indexed")} />
        <SummaryCard
          icon={CircleAlert}
          tone="text-danger"
          label="Failed"
          value={formatNumber(failed.length)}
          hint={failed.length > 0 ? "Couldn't be read" : undefined}
          onClick={() => setFilter("failed")}
        />
        <SummaryCard
          icon={CircleMinus}
          tone="text-text-muted"
          label="Skipped"
          value={formatNumber(skipped.length)}
          hint={skipped.length > 0 ? "Excluded or too large" : undefined}
          onClick={() => setFilter("skipped")}
        />
        <SummaryCard
          icon={History}
          tone="text-accent"
          label="Last sync"
          value={channel.lastIndexedAt ? formatRelativeTime(channel.lastIndexedAt) : "Never"}
          title={formatDateTime(channel.lastIndexedAt)}
          hint={
            stats
              ? `${formatNumber(stats.added)} added · ${formatNumber(stats.updated)} updated · ${formatNumber(stats.removed)} removed`
              : undefined
          }
        />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search file names and folders"
            aria-label="Search files"
            className="control h-8 pl-8"
          />
        </div>
        <SegmentedControl<Filter>
          label="Filter files by status"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: total },
            { value: "indexed", label: "Indexed", count: indexed.length },
            { value: "failed", label: "Failed", count: failed.length },
            { value: "skipped", label: "Skipped", count: skipped.length }
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs tabular-nums text-text-muted">{formatNumber(files.length)} shown</span>
          <Button size="sm" icon={RefreshCw} onClick={() => actions.startSync(channel.id)} disabled={indexing}>
            Sync now
          </Button>
        </div>
      </div>

      {total === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-dashed border-border">
          <EmptyState
            icon={FolderSearch}
            title={indexing ? "Looking for files…" : "No files indexed yet"}
            actions={
              !indexing ? (
                <Button variant="primary" icon={RefreshCw} onClick={() => actions.startSync(channel.id)}>
                  Index this folder
                </Button>
              ) : undefined
            }
          >
            {indexing
              ? "Files will appear here as they're read."
              : "Hello Files reads the documents in this folder so you can ask questions about them. Your files are not changed."}
          </EmptyState>
        </div>
      ) : files.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-dashed border-border">
          <EmptyState icon={Search} title="No matching files">
            Try a different search or filter.
          </EmptyState>
        </div>
      ) : (
        <FileTable
          files={files}
          onOpen={(path) => void actions.openFile(channel.id, path)}
          onReveal={(path) => void actions.revealFile(channel.id, path)}
        />
      )}
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  tone,
  label,
  value,
  hint,
  title,
  onClick
}: {
  icon: typeof CircleCheck;
  tone: string;
  label: string;
  value: ReactNode;
  hint?: string;
  title?: string;
  onClick?: () => void;
}) {
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={title}
      className={cx(
        "min-w-0 rounded-md border border-border bg-surface p-3 text-left shadow-card",
        onClick && "transition-colors hover:bg-surface-2"
      )}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
        <Icon className={cx("h-3.5 w-3.5", tone)} aria-hidden />
        {label}
      </div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums text-text">{value}</div>
      <div className="truncate text-2xs text-text-muted">{hint ?? " "}</div>
    </Wrapper>
  );
}
