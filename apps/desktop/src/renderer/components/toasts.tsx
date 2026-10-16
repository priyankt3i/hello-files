import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { cx } from "../lib/format";
import { useToastList, useToasts, type ToastTone } from "../state/toasts";

const ICON = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert };
const ICON_COLOR: Record<ToastTone, string> = {
  info: "text-accent",
  success: "text-success",
  warning: "text-warning",
  error: "text-danger"
};

export function ToastViewport() {
  const toasts = useToastList();
  const { dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = ICON[toast.tone];
        return (
          <div
            key={toast.id}
            role={toast.tone === "error" ? "alert" : "status"}
            className={cx(
              "pointer-events-auto flex gap-3 rounded-md border bg-surface p-3 shadow-popover",
              toast.tone === "error" ? "border-danger/40" : "border-border"
            )}
          >
            <Icon className={cx("mt-0.5 h-4 w-4 shrink-0", ICON_COLOR[toast.tone])} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text">{toast.title}</div>
              {toast.description ? (
                <div className="break-anywhere mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-text-muted">
                  {toast.description}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
              className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
