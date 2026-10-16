import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Channel } from "@fschat/shared";
import { PHASE_LABEL, cx, formatDateTime, formatNumber, formatRelativeTime, isTerminalPhase } from "../lib/format";
import { describeChannelDestination } from "../lib/providers";
import { isBackgroundSyncing, useAppStore } from "../state/store";
import type { KbTab } from "../state/types";
import { DataDestinationBadge, StatusBadge } from "./badges";
import { Button } from "./ui/button";
import { Callout } from "./ui/feedback";

/** Re-renders periodically so relative times ("3 min ago") stay fresh. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

const TABS: Array<{ id: KbTab; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "files", label: "Files" },
  { id: "settings", label: "Settings" }
];

export function KnowledgeBaseHeader({ channel }: { channel: Channel }) {
  const { state, actions, lookup } = useAppStore();
  const now = useNow();
  const destination = describeChannelDestination(channel, lookup, state.settings);
  const snapshot = state.snapshot?.channel.id === channel.id ? state.snapshot : null;
  const progress = state.progressByChannel[channel.id];
  const indexing = channel.status === "indexing";
  const syncing = isBackgroundSyncing(state, channel.id);
  const fileCount = snapshot?.indexedFiles.length ?? null;

  return (
    <header className="shrink-0 border-b border-border bg-surface">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-6 pt-4">
        <h1 className="min-w-0 max-w-full truncate text-lg font-semibold text-text" title={channel.rootPath}>
          {channel.displayName}
        </h1>
        <StatusBadge status={channel.status} />
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
          {fileCount !== null ? <span>{formatNumber(fileCount)} files</span> : null}
          {channel.lastIndexedAt ? (
            <span title={formatDateTime(channel.lastIndexedAt)}>Synced {formatRelativeTime(channel.lastIndexedAt, now)}</span>
          ) : null}
          {indexing && progress && !isTerminalPhase(progress.phase) ? (
            <button type="button" onClick={() => actions.setTab("files")} className="inline-flex items-center gap-1.5 text-accent hover:underline">
              <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />
              {PHASE_LABEL[progress.phase]}
              {progress.totalFiles > 0 ? ` · ${formatNumber(progress.processedFiles)}/${formatNumber(progress.totalFiles)}` : "…"}
            </button>
          ) : null}
          {syncing ? (
            <span className="inline-flex items-center gap-1.5" title="Picking up changes in the folder. Chat stays available.">
              <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />
              Syncing…
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <DataDestinationBadge destination={destination} />
        </div>
      </div>

      <div role="tablist" aria-label="Knowledge base sections" className="mt-2 flex gap-1 px-4">
        {TABS.map((tab) => {
          const active = state.tab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => actions.setTab(tab.id)}
              className={cx(
                "relative h-9 rounded-t px-3 text-sm font-medium transition-colors",
                active ? "text-text" : "text-text-muted hover:text-text"
              )}
            >
              {tab.label}
              {tab.id === "files" && snapshot && snapshot.failedFiles.length > 0 ? (
                <span className="ml-1.5 rounded-full bg-danger/10 px-1.5 text-2xs font-semibold text-danger">
                  {formatNumber(snapshot.failedFiles.length)}
                </span>
              ) : null}
              {active ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
    </header>
  );
}

/** Explains why a knowledge base needs attention, with the obvious next step. */
export function KnowledgeBaseAlerts({ channel }: { channel: Channel }) {
  const { state, actions, lookup } = useAppStore();
  const destination = describeChannelDestination(channel, lookup, state.settings);

  if (destination.tone === "blocked") {
    return (
      <Callout
        tone="danger"
        title="Blocked by Local-only mode"
        className="mx-6 mt-4"
        actions={
          <>
            <Button size="sm" onClick={() => actions.setTab("settings")}>
              Choose local models
            </Button>
            <Button size="sm" variant="ghost" onClick={() => actions.openAppSettings("privacy")}>
              Privacy settings
            </Button>
          </>
        }
      >
        {destination.detail}
      </Callout>
    );
  }
  if (channel.status === "error") {
    return (
      <Callout
        tone="danger"
        title="This knowledge base needs attention"
        className="mx-6 mt-4"
        actions={
          <>
            <Button size="sm" icon={RefreshCw} onClick={() => actions.startSync(channel.id)}>
              Try sync again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => actions.setTab("settings")}>
              Open settings
            </Button>
          </>
        }
      >
        {channel.lastError ?? "The last sync failed."}
      </Callout>
    );
  }
  if (channel.lastError && (channel.status === "ready" || channel.status === "stale")) {
    // Background syncs that fail keep the previous index, so the knowledge base stays usable.
    return (
      <Callout
        tone="warning"
        title="The last automatic sync failed"
        className="mx-6 mt-4"
        actions={
          <Button size="sm" icon={RefreshCw} onClick={() => actions.startSync(channel.id)}>
            Try sync again
          </Button>
        }
      >
        {channel.lastError} Answers still use the previous index, so recent file changes may be missing.
      </Callout>
    );
  }
  if (channel.status === "stale") {
    return (
      <Callout
        tone="warning"
        title="Some files may be missing"
        className="mx-6 mt-4"
        actions={
          <Button size="sm" icon={RefreshCw} onClick={() => actions.startSync(channel.id)}>
            Sync now
          </Button>
        }
      >
        The last indexing run was stopped before it finished. You can still ask questions; sync to include the remaining files.
      </Callout>
    );
  }
  if (channel.status === "idle" && destination.tone !== "unset" && state.tab !== "files") {
    return (
      <Callout
        tone="info"
        title="Not indexed yet"
        className="mx-6 mt-4"
        actions={
          <Button size="sm" variant="primary" icon={RefreshCw} onClick={() => actions.startSync(channel.id)}>
            Index now
          </Button>
        }
      >
        Hello Files needs to read the files in this folder before you can ask questions about them.
      </Callout>
    );
  }
  if (destination.tone === "unset") {
    return (
      <Callout
        tone="warning"
        title="No AI model selected"
        className="mx-6 mt-4"
        actions={
          <Button size="sm" onClick={() => actions.setTab("settings")}>
            Choose a model
          </Button>
        }
      >
        The model used by this knowledge base was removed. Pick another one in Settings.
      </Callout>
    );
  }
  return null;
}
