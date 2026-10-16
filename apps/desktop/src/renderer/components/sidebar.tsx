import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Settings } from "lucide-react";
import type { Channel, Thread } from "@fschat/shared";
import helloFilesLogo from "../assets/hello-files-logo.png";
import { STATUS_LABEL, cx } from "../lib/format";
import { orderThreads } from "../lib/snapshot";
import { isBackgroundSyncing, useAppStore } from "../state/store";
import { DataPolicyBadge, StatusDot } from "./badges";
import { Button, IconButton } from "./ui/button";

const COLLAPSE_KEY = "fschat-sidebar-collapsed";

export function Sidebar() {
  const { state, actions } = useAppStore();
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem(COLLAPSE_KEY) === "1");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  if (collapsed) {
    return (
      <nav aria-label="Knowledge bases" className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-3">
        <IconButton icon={PanelLeftOpen} label="Expand sidebar" onClick={() => setCollapsed(false)} />
        <IconButton icon={Plus} label="New knowledge base" onClick={actions.openNewKb} />
        <div className="my-1 h-px w-8 bg-border" />
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
          {state.channels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              title={`${channel.displayName} — ${STATUS_LABEL[channel.status]}`}
              aria-label={channel.displayName}
              aria-current={channel.id === state.selectedChannelId ? "page" : undefined}
              onClick={() => void actions.selectChannel(channel.id)}
              className={cx(
                "relative flex h-8 w-8 items-center justify-center rounded text-xs font-semibold uppercase",
                channel.id === state.selectedChannelId ? "bg-accent/10 text-accent" : "text-text-muted hover:bg-surface-2"
              )}
            >
              {channel.displayName.slice(0, 2)}
              <StatusDot status={channel.status} className="absolute bottom-0.5 right-0.5 h-1.5 w-1.5" />
            </button>
          ))}
        </div>
        <IconButton icon={Settings} label="Settings" onClick={() => actions.openAppSettings("providers")} />
      </nav>
    );
  }

  const isExpanded = (channel: Channel) => expanded[channel.id] ?? channel.id === state.selectedChannelId;

  return (
    <nav aria-label="Knowledge bases" className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <img src={helloFilesLogo} alt="" className="h-7 w-7 shrink-0 rounded object-contain" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-text">Hello Files</div>
        <IconButton icon={PanelLeftClose} label="Collapse sidebar" onClick={() => setCollapsed(true)} />
      </div>

      <div className="shrink-0 px-3 pb-3">
        <Button variant="primary" icon={Plus} className="w-full" onClick={actions.openNewKb}>
          New knowledge base
        </Button>
      </div>

      <div className="px-4 pb-1 text-2xs font-semibold uppercase tracking-wide text-text-muted">Knowledge bases</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {state.channels.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-text-muted">
            None yet. A knowledge base is a folder on your computer that you can ask questions about.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {state.channels.map((channel) => {
              const selected = channel.id === state.selectedChannelId;
              const open = isExpanded(channel);
              const syncing = isBackgroundSyncing(state, channel.id);
              return (
                <li key={channel.id}>
                  <div
                    className={cx(
                      "group flex h-8 items-center gap-1 rounded pr-1 text-sm",
                      selected ? "bg-accent/10 text-text" : "text-text hover:bg-surface-2"
                    )}
                  >
                    <button
                      type="button"
                      aria-label={open ? `Collapse ${channel.displayName}` : `Expand ${channel.displayName}`}
                      aria-expanded={open}
                      onClick={() => setExpanded((current) => ({ ...current, [channel.id]: !open }))}
                      className="flex h-8 w-6 shrink-0 items-center justify-center rounded text-text-muted hover:text-text"
                    >
                      {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                    </button>
                    <button
                      type="button"
                      aria-current={selected ? "page" : undefined}
                      onClick={() => {
                        setExpanded((current) => ({ ...current, [channel.id]: true }));
                        void actions.selectChannel(channel.id);
                      }}
                      title={`${channel.rootPath}\n${STATUS_LABEL[channel.status]}`}
                      className={cx("flex min-w-0 flex-1 items-center gap-2 text-left", selected && "font-medium")}
                    >
                      <StatusDot status={channel.status} />
                      <span className="min-w-0 flex-1 truncate">{channel.displayName}</span>
                      {syncing ? <RefreshCw className="h-3 w-3 shrink-0 animate-spin text-text-muted" aria-label="Syncing" /> : null}
                    </button>
                  </div>
                  {open ? <ThreadList channel={channel} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2">
        <Button variant="ghost" size="sm" icon={Settings} onClick={() => actions.openAppSettings("providers")}>
          Settings
        </Button>
        <DataPolicyBadge settings={state.settings} onClick={() => actions.openAppSettings("privacy")} />
      </div>
    </nav>
  );
}

/** Chats of a knowledge base. The selected KB uses its fresh snapshot; others use the list from bootstrap. */
function ThreadList({ channel }: { channel: Channel }) {
  const { state, actions } = useAppStore();
  const selected = channel.id === state.selectedChannelId;
  const threads: Thread[] = orderThreads(
    selected && state.snapshot?.channel.id === channel.id
      ? state.snapshot.threads
      : state.threads.filter((thread) => thread.channelId === channel.id)
  );

  return (
    <ul className="mb-1 ml-5 mt-0.5 space-y-px border-l border-border pl-2">
      {threads.map((thread) => {
        const active = selected && thread.id === state.selectedThreadId && state.tab === "chat";
        return (
          <li key={thread.id}>
            <button
              type="button"
              onClick={() => void actions.openThread(channel.id, thread.id)}
              aria-current={active ? "page" : undefined}
              title={thread.title}
              className={cx(
                "flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs",
                active ? "bg-surface-2 font-medium text-text" : "text-text-muted hover:bg-surface-2 hover:text-text"
              )}
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{thread.title}</span>
            </button>
          </li>
        );
      })}
      <li>
        <button
          type="button"
          onClick={() => void (selected ? actions.createThread() : actions.selectChannel(channel.id).then(() => actions.createThread(channel.id)))}
          className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs text-text-muted hover:bg-surface-2 hover:text-text"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
          New chat
        </button>
      </li>
    </ul>
  );
}
