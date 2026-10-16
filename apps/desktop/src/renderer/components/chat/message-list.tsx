import { useCallback, useEffect, useRef } from "react";
import { CircleAlert, MessageSquare, Pencil, RotateCcw, Sparkles, X } from "lucide-react";
import type { Message } from "@fschat/shared";
import { cx, fileName, formatDateTime } from "../../lib/format";
import type { FailedTurn, PendingTurn } from "../../state/types";
import { RichLinkContext, RichMarkdown } from "../rich/rich-markdown";
import { Button } from "../ui/button";

const EXAMPLE_QUESTIONS = [
  "Summarize the main topics covered in these documents.",
  "Which documents mention deadlines or required timeframes?",
  "What are the key differences between the most recent versions of these files?"
];

export function MessageList({
  knowledgeBaseName,
  messages,
  pendingTurn,
  failedTurn,
  canAsk,
  activeSourceMessageId,
  onAskExample,
  onOpenCitation,
  onOpenExternalUrl,
  onRetry,
  onEdit,
  onDiscard
}: {
  knowledgeBaseName: string;
  messages: Message[];
  pendingTurn: PendingTurn | null;
  failedTurn: FailedTurn | null;
  canAsk: boolean;
  activeSourceMessageId: string | null;
  onAskExample: (text: string) => void;
  onOpenCitation: (message: Message, index: number) => void;
  onOpenExternalUrl: (url: string) => void;
  onRetry: () => void;
  onEdit: () => void;
  onDiscard: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Stable link handler so memoised answers don't re-render when the parent passes a new closure.
  const openUrlRef = useRef(onOpenExternalUrl);
  openUrlRef.current = onOpenExternalUrl;
  const openUrl = useCallback((url: string) => openUrlRef.current(url), []);
  const visible = messages.filter((message) => message.role !== "system");

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    window.requestAnimationFrame(() => viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" }));
  }, [visible.length, pendingTurn, failedTurn]);

  const isEmpty = visible.length === 0 && !pendingTurn && !failedTurn;

  return (
    <RichLinkContext.Provider value={openUrl}>
      <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="mx-auto flex h-full max-w-xl flex-col justify-center px-6 py-10">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
              <MessageSquare className="h-5 w-5" aria-hidden />
            </div>
            <h2 className="text-base font-semibold text-text">Ask about {knowledgeBaseName}</h2>
            <p className="mt-1 text-sm leading-relaxed text-text-muted">
              Answers are written from the files in this folder. Each answer lists its sources so you can open the original
              document and check it.
            </p>
            {canAsk ? (
              <div className="mt-5 space-y-2">
                <div className="text-2xs font-semibold uppercase tracking-wide text-text-muted">Try asking</div>
                {EXAMPLE_QUESTIONS.map((question) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => onAskExample(question)}
                    className="flex w-full items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-left text-sm text-text shadow-card transition-colors hover:bg-surface-2"
                  >
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
                    {question}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
            {visible.map((message) =>
              message.role === "user" ? (
                <UserBubble key={message.id} text={message.content} time={message.createdAt} />
              ) : (
                <AssistantMessage
                  key={message.id}
                  message={message}
                  activeSources={activeSourceMessageId === message.id}
                  onOpenCitation={(index) => onOpenCitation(message, index)}
                />
              )
            )}
            {pendingTurn ? (
              <>
                <UserBubble text={pendingTurn.text} time={pendingTurn.createdAt} />
                <div className="flex items-center gap-2 text-sm text-text-muted" role="status">
                  <AssistantAvatar />
                  <span>Searching your files</span>
                  <span className="flex gap-1" aria-hidden>
                    <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-text-muted" />
                    <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-text-muted" />
                    <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-text-muted" />
                  </span>
                </div>
              </>
            ) : null}
            {failedTurn ? (
              <div className="space-y-2">
                <UserBubble text={failedTurn.text} failed />
                <div className="ml-auto max-w-[85%] rounded-md border border-danger/30 bg-danger/5 p-3 text-sm" role="alert">
                  <div className="flex items-start gap-2">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-text">Not sent — the assistant couldn't answer.</div>
                      <div className="break-anywhere mt-0.5 text-xs text-text-muted">{failedTurn.error}</div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="ghost" icon={X} onClick={onDiscard}>
                      Discard
                    </Button>
                    <Button size="sm" icon={Pencil} onClick={onEdit}>
                      Edit
                    </Button>
                    <Button size="sm" variant="primary" icon={RotateCcw} onClick={onRetry}>
                      Retry
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </RichLinkContext.Provider>
  );
}

function UserBubble({ text, time, failed }: { text: string; time?: string; failed?: boolean }) {
  return (
    <div className="flex justify-end">
      <div
        title={time ? formatDateTime(time) : undefined}
        className={cx(
          "break-anywhere max-w-[85%] whitespace-pre-wrap rounded-md px-3.5 py-2 text-sm leading-relaxed",
          failed ? "border border-dashed border-danger/40 bg-surface text-text-muted" : "bg-accent/10 text-text"
        )}
      >
        {text}
      </div>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-accent" aria-hidden>
      <Sparkles className="h-3.5 w-3.5" />
    </span>
  );
}

function AssistantMessage({
  message,
  activeSources,
  onOpenCitation
}: {
  message: Message;
  activeSources: boolean;
  onOpenCitation: (index: number) => void;
}) {
  return (
    <div className="flex gap-3">
      <AssistantAvatar />
      <div className="min-w-0 flex-1">
        <RichMarkdown content={message.content} />
        {message.citations.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-2xs font-medium uppercase tracking-wide text-text-muted">Sources</span>
            {message.citations.map((citation, index) => (
              <button
                key={`${citation.chunkId}-${index}`}
                type="button"
                onClick={() => onOpenCitation(index)}
                title={citation.relativePath}
                className={cx(
                  "inline-flex h-6 max-w-[16rem] items-center gap-1.5 rounded-sm border px-1.5 text-xs transition-colors",
                  activeSources ? "border-accent/40 bg-accent/5" : "border-border bg-surface hover:bg-surface-2"
                )}
              >
                <span className="font-semibold text-accent">{index + 1}</span>
                <span className="truncate text-text">{fileName(citation.relativePath)}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
