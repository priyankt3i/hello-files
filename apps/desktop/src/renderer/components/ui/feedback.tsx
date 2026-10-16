import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { cx } from "../../lib/format";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const PILL_TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-text-muted border-border",
  accent: "bg-accent/10 text-accent border-accent/25",
  success: "bg-success/10 text-success border-success/25",
  warning: "bg-warning/10 text-warning border-warning/30",
  danger: "bg-danger/10 text-danger border-danger/25"
};

export function Pill({
  tone = "neutral",
  icon: Icon,
  children,
  title,
  className
}: {
  tone?: Tone;
  icon?: LucideIcon;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium",
        PILL_TONE[tone],
        className
      )}
    >
      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

const CALLOUT: Record<Exclude<Tone, "neutral" | "accent"> | "info", { box: string; icon: LucideIcon }> = {
  info: { box: "border-accent/25 bg-accent/5", icon: Info },
  success: { box: "border-success/25 bg-success/5", icon: CircleCheck },
  warning: { box: "border-warning/30 bg-warning/5", icon: TriangleAlert },
  danger: { box: "border-danger/25 bg-danger/5", icon: CircleAlert }
};

const CALLOUT_ICON_COLOR = { info: "text-accent", success: "text-success", warning: "text-warning", danger: "text-danger" };

export function Callout({
  tone = "info",
  title,
  children,
  actions,
  className
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const { box, icon: Icon } = CALLOUT[tone];
  return (
    <div role={tone === "danger" ? "alert" : undefined} className={cx("flex gap-3 rounded-md border p-3", box, className)}>
      <Icon className={cx("mt-0.5 h-4 w-4 shrink-0", CALLOUT_ICON_COLOR[tone])} aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        {title ? <div className="font-medium text-text">{title}</div> : null}
        {children ? <div className={cx("break-anywhere text-text-muted", Boolean(title) && "mt-0.5")}>{children}</div> : null}
        {actions ? <div className="mt-2 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const known = max > 0;
  const percent = known ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={known ? max : undefined}
      aria-valuenow={known ? value : undefined}
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
    >
      {known ? (
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
      ) : (
        <div className="progress-indeterminate absolute inset-y-0 left-0 w-2/5 rounded-full bg-accent" />
      )}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  actions
}: {
  icon: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-surface-2 text-text-muted">
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <div className="text-sm font-semibold text-text">{title}</div>
      {children ? <div className="mt-1 text-sm leading-relaxed text-text-muted">{children}</div> : null}
      {actions ? <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Small "Technical details" disclosure for jargon that doesn't belong in primary UI. */
export function TechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <details className="group text-xs text-text-muted">
      <summary className="cursor-pointer select-none font-medium hover:text-text">Technical details</summary>
      <div className="mt-2 space-y-1 rounded-md border border-border bg-surface-2 p-3 font-mono text-2xs leading-relaxed">{children}</div>
    </details>
  );
}
