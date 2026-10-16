import { useEffect, useRef } from "react";
import { ExternalLink, FolderOpen, X } from "lucide-react";
import type { Citation } from "@fschat/shared";
import { cx, fileName } from "../../lib/format";
import { Button, IconButton } from "../ui/button";
import { FileTypeIcon } from "../files/file-type-icon";

export interface SourcesSelection {
  messageId: string;
  citations: Citation[];
  activeIndex: number;
}

/** Converts a raw retrieval score into a plain-language relevance label. */
function relevance(score: number, best: number) {
  if (!Number.isFinite(score)) return null;
  const ratio = best > 0 ? score / best : 0;
  if (ratio >= 0.85) return "High relevance";
  if (ratio >= 0.6) return "Medium relevance";
  return "Lower relevance";
}

export function SourcesDrawer({
  selection,
  onSelect,
  onClose,
  onOpen,
  onReveal
}: {
  selection: SourcesSelection;
  onSelect: (index: number) => void;
  onClose: () => void;
  onOpen: (relativePath: string) => void;
  onReveal: (relativePath: string) => void;
}) {
  const activeRef = useRef<HTMLLIElement | null>(null);
  const best = Math.max(...selection.citations.map((citation) => citation.score), 0);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [selection.activeIndex, selection.messageId]);

  return (
    <aside aria-label="Sources" className="flex w-[340px] shrink-0 flex-col border-l border-border bg-surface xl:w-[380px]">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="text-sm font-semibold text-text">
          Sources <span className="font-normal text-text-muted">({selection.citations.length})</span>
        </div>
        <IconButton icon={X} label="Close sources" onClick={onClose} />
      </div>
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {selection.citations.map((citation, index) => {
          const active = index === selection.activeIndex;
          const label = relevance(citation.score, best);
          return (
            <li
              key={`${citation.chunkId}-${index}`}
              ref={active ? activeRef : null}
              className={cx("rounded-md border transition-colors", active ? "border-accent bg-accent/5" : "border-border hover:bg-surface-2")}
            >
              <button type="button" onClick={() => onSelect(index)} aria-expanded={active} className="flex w-full items-start gap-2 p-3 text-left">
                <span className="flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-sm bg-surface-2 px-1 text-2xs font-semibold text-text-muted">
                  {index + 1}
                </span>
                <FileTypeIcon path={citation.relativePath} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text" title={citation.relativePath}>
                    {fileName(citation.relativePath)}
                  </span>
                  <span className="break-anywhere block text-2xs text-text-muted">{citation.relativePath}</span>
                </span>
              </button>
              {active ? (
                <div className="border-t border-border px-3 pb-3 pt-2">
                  {label ? (
                    <div className="mb-2 text-2xs text-text-muted" title={`Score ${citation.score.toFixed(3)}`}>
                      {label}
                    </div>
                  ) : null}
                  <blockquote className="break-anywhere max-h-72 overflow-y-auto whitespace-pre-wrap border-l-2 border-accent/40 pl-3 text-xs leading-relaxed text-text">
                    {citation.snippet || "No preview available."}
                  </blockquote>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" icon={ExternalLink} onClick={() => onOpen(citation.relativePath)}>
                      Open file
                    </Button>
                    <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => onReveal(citation.relativePath)}>
                      Show in folder
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
