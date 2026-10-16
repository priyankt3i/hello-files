import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, type LucideIcon } from "lucide-react";

/** Header strip of a rich block: a title on the left, keyboard-accessible action buttons on the right. */
export function BlockToolbar({ title, label, children }: { title: ReactNode; label: string; children?: ReactNode }) {
  return (
    <div className="rich-toolbar" role="toolbar" aria-label={label}>
      <span className="rich-toolbar-title">{title}</span>
      {children}
    </div>
  );
}

export function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  pressed,
  disabled
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={pressed} disabled={disabled} title={label}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span>{label}</span>
    </button>
  );
}

/** A button that runs an async action and briefly confirms success ("Copied", "Saved"). */
export function ActionButton({
  icon,
  label,
  doneLabel,
  action
}: {
  icon: LucideIcon;
  label: string;
  doneLabel: string;
  action: () => Promise<boolean> | boolean | Promise<void> | void;
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function run() {
    let ok = true;
    try {
      const result = await action();
      ok = result !== false;
    } catch {
      ok = false;
    }
    setState(ok ? "done" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  }

  return (
    <>
      <ToolbarButton
        icon={state === "done" ? Check : icon}
        label={state === "done" ? doneLabel : state === "failed" ? "Failed" : label}
        onClick={() => void run()}
      />
      <span className="sr-only" aria-live="polite">
        {state === "done" ? doneLabel : state === "failed" ? `${label} failed` : ""}
      </span>
    </>
  );
}
