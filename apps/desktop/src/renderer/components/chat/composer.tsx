import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { SendHorizontal } from "lucide-react";
import { cx } from "../../lib/format";

const MAX_HEIGHT = 200;

// Unsent text per chat, kept for the app session so switching tabs or chats doesn't lose a draft.
const drafts = new Map<string, string>();

export function Composer({
  draftKey,
  placeholder,
  disabledReason,
  busy,
  seed,
  onSeedConsumed,
  onSend
}: {
  /** Identifies the chat this draft belongs to. */
  draftKey: string;
  placeholder: string;
  /** When set, the composer is disabled and this explains why. */
  disabledReason: string | null;
  busy: boolean;
  /** Text pushed in from outside (example question, "Edit" on a failed message). */
  seed: { text: string; nonce: number } | null;
  onSeedConsumed: () => void;
  onSend: (text: string) => Promise<boolean>;
}) {
  const [text, setTextState] = useState(() => drafts.get(draftKey) ?? "");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const keyRef = useRef(draftKey);
  const disabled = Boolean(disabledReason);

  const setText = (value: string) => {
    setTextState(value);
    if (value) {
      drafts.set(keyRef.current, value);
    } else {
      drafts.delete(keyRef.current);
    }
  };

  // Switching chats while mounted: load that chat's draft.
  useEffect(() => {
    if (keyRef.current === draftKey) return;
    keyRef.current = draftKey;
    setTextState(drafts.get(draftKey) ?? "");
  }, [draftKey]);

  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    ref.current?.focus();
    onSeedConsumed();
  }, [seed, onSeedConsumed]);

  // Auto-size between one line and MAX_HEIGHT.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
    element.style.overflowY = element.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

  async function submit() {
    const value = text.trim();
    if (!value || disabled || busy) return;
    // Clear optimistically; on failure the message is shown with Retry / Edit (nothing is lost).
    setText("");
    await onSend(value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="shrink-0 px-6 pb-4 pt-2">
      <div className="mx-auto max-w-3xl">
        <div
          className={cx(
            "flex items-end gap-2 rounded-md border bg-surface p-2 shadow-card transition-colors",
            disabled ? "border-border opacity-70" : "border-border focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25"
          )}
        >
          <textarea
            ref={ref}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={disabled ? "Chat is unavailable right now" : placeholder}
            disabled={disabled}
            rows={1}
            aria-label="Message"
            className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent px-1 py-0.5 text-sm leading-6 text-text outline-none placeholder:text-text-muted disabled:cursor-not-allowed"
            style={{ outline: "none" }}
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={disabled || busy || !text.trim()}
            aria-label="Send message"
            title="Send (Enter)"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent text-accent-fg transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendHorizontal className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="mt-1.5 flex justify-between gap-4 px-1 text-2xs text-text-muted">
          <span className="truncate">{disabled ? disabledReason : "Answers are based on the files in this knowledge base and may contain mistakes. Check the sources."}</span>
          <span className="hidden shrink-0 sm:inline">Enter to send · Shift+Enter for a new line</span>
        </div>
      </div>
    </div>
  );
}
