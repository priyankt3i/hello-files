import { useState, type ReactNode } from "react";
import { toErrorMessage } from "../../lib/format";
import { Button } from "./button";
import { Callout } from "./feedback";
import { TextInput } from "./form";
import { Modal } from "./modal";

/**
 * Confirmation dialog. `onConfirm` may be async; errors are shown inline and the dialog stays open.
 * Set `confirmText` to require the user to type a phrase (for irreversible actions).
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  confirmText,
  onConfirm,
  onClose
}: {
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  confirmText?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const blocked = Boolean(confirmText) && typed.trim() !== confirmText;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (caught) {
      setError(toErrorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      size="sm"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy} data-autofocus={confirmText ? undefined : true}>
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} loading={busy} disabled={blocked} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed text-text-muted">
        {children}
        {confirmText ? (
          <div>
            <label className="mb-1 block text-xs font-medium text-text">
              Type <span className="font-mono">{confirmText}</span> to confirm
            </label>
            <TextInput data-autofocus value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
          </div>
        ) : null}
        {error ? <Callout tone="danger">{error}</Callout> : null}
      </div>
    </Modal>
  );
}
