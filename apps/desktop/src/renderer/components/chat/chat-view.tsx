import { useEffect, useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import type { Channel, Message } from "@fschat/shared";
import { describeChannelDestination } from "../../lib/providers";
import { useAppStore } from "../../state/store";
import { Button, IconButton } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { SourcesDrawer, type SourcesSelection } from "./sources-drawer";

export function ChatView({ channel }: { channel: Channel }) {
  const { state, actions, lookup } = useAppStore();
  const [sources, setSources] = useState<SourcesSelection | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const snapshot = state.snapshot?.channel.id === channel.id ? state.snapshot : null;
  const thread = snapshot?.threads.find((item) => item.id === state.selectedThreadId) ?? null;
  const pendingTurn =
    state.pendingTurn && state.pendingTurn.channelId === channel.id && state.pendingTurn.threadId === state.selectedThreadId
      ? state.pendingTurn
      : null;
  const failedTurn =
    state.failedTurn && state.failedTurn.channelId === channel.id && state.failedTurn.threadId === state.selectedThreadId
      ? state.failedTurn
      : null;

  // Close the drawer when switching chats.
  useEffect(() => setSources(null), [state.selectedThreadId, channel.id]);

  const disabledReason = getDisabledReason(channel, describeChannelDestination(channel, lookup, state.settings).tone);

  function openCitation(message: Message, index: number) {
    setSources({ messageId: message.id, citations: message.citations, activeIndex: index });
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ThreadBar
          key={thread?.id ?? "none"}
          title={thread?.title ?? "New chat"}
          canEdit={Boolean(thread)}
          onRename={(title) => thread && void actions.renameThread(thread.id, title)}
          onDelete={() => {
            if (!thread) return;
            if (state.messages.length > 0) setConfirmDelete(true);
            else void actions.deleteThread(thread.id);
          }}
          onNew={() => void actions.createThread()}
        />
        <MessageList
          knowledgeBaseName={channel.displayName}
          messages={state.selectedThreadId ? state.messages : []}
          pendingTurn={pendingTurn}
          failedTurn={failedTurn}
          canAsk={!disabledReason}
          activeSourceMessageId={sources?.messageId ?? null}
          onAskExample={actions.seedComposer}
          onOpenCitation={openCitation}
          onOpenExternalUrl={(url) => void actions.openExternalUrl(url)}
          onRetry={() => void actions.retryFailedTurn()}
          onEdit={actions.editFailedTurn}
          onDiscard={actions.discardFailedTurn}
        />
        <Composer
          draftKey={`${channel.id}:${state.selectedThreadId ?? "new"}`}
          placeholder={`Ask about ${channel.displayName}…`}
          disabledReason={disabledReason}
          busy={Boolean(state.pendingTurn)}
          seed={state.composerSeed}
          onSeedConsumed={actions.consumeComposerSeed}
          onSend={actions.sendMessage}
        />
      </div>
      {sources ? (
        <SourcesDrawer
          selection={sources}
          onSelect={(index) => setSources((current) => (current ? { ...current, activeIndex: index } : current))}
          onClose={() => setSources(null)}
          onOpen={(path) => void actions.openFile(channel.id, path)}
          onReveal={(path) => void actions.revealFile(channel.id, path)}
        />
      ) : null}
      {confirmDelete && thread ? (
        <ConfirmDialog
          title="Delete this chat?"
          confirmLabel="Delete chat"
          onConfirm={() => actions.deleteThread(thread.id)}
          onClose={() => setConfirmDelete(false)}
        >
          <p>
            “{thread.title}” and its messages will be removed from this app. Your files are not affected.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function getDisabledReason(channel: Channel, destinationTone: string): string | null {
  if (destinationTone === "unset") return "Choose a chat model in Settings before asking questions.";
  if (destinationTone === "blocked") return "This knowledge base uses a cloud model, which Local-only mode blocks.";
  switch (channel.status) {
    case "indexing":
      return "Indexing is in progress. You can ask questions when it finishes.";
    case "idle":
      return "This knowledge base hasn't been indexed yet.";
    case "error":
      return "This knowledge base needs attention before you can ask questions.";
    default:
      return null;
  }
}

function ThreadBar({
  title,
  canEdit,
  onRename,
  onDelete,
  onNew
}: {
  title: string;
  canEdit: boolean;
  onRename: (title: string) => void;
  onDelete: () => void;
  onNew: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  function commit() {
    const next = draft.trim();
    if (next && next !== title) onRename(next);
    setEditing(false);
  }

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-6">
      {editing ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
        >
          <input
            autoFocus
            aria-label="Chat title"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(title);
                setEditing(false);
              }
            }}
            className="control h-7 max-w-md"
          />
          <IconButton type="submit" icon={Check} label="Save title" size="sm" />
          <IconButton
            icon={X}
            label="Cancel rename"
            size="sm"
            onClick={() => {
              setDraft(title);
              setEditing(false);
            }}
          />
        </form>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <h2 className="truncate text-sm font-medium text-text" title={title}>
            {title}
          </h2>
          {canEdit ? (
            <>
              <IconButton icon={Pencil} label="Rename chat" size="sm" onClick={() => setEditing(true)} />
              <IconButton icon={Trash2} label="Delete chat" size="sm" tone="danger" onClick={onDelete} />
            </>
          ) : null}
        </div>
      )}
      <Button size="sm" icon={Plus} onClick={onNew}>
        New chat
      </Button>
    </div>
  );
}
