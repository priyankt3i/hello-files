import { Cloud, CloudOff, Lock, ShieldAlert } from "lucide-react";
import type { AppSettings, Channel } from "@fschat/shared";
import { STATUS_LABEL, cx } from "../lib/format";
import type { DataDestination } from "../lib/providers";
import { Pill, type Tone } from "./ui/feedback";

const STATUS_TONE: Record<Channel["status"], Tone> = {
  ready: "success",
  indexing: "accent",
  stale: "warning",
  error: "danger",
  idle: "neutral"
};

const DOT_COLOR: Record<Channel["status"], string> = {
  ready: "bg-success",
  indexing: "bg-accent animate-pulse",
  stale: "bg-warning",
  error: "bg-danger",
  idle: "bg-text-muted/50"
};

export function StatusDot({ status, className }: { status: Channel["status"]; className?: string }) {
  return <span aria-hidden className={cx("inline-block h-2 w-2 shrink-0 rounded-full", DOT_COLOR[status], className)} />;
}

export function StatusBadge({ status }: { status: Channel["status"] }) {
  return (
    <span
      className={cx(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium",
        {
          success: "border-success/25 bg-success/10 text-success",
          accent: "border-accent/25 bg-accent/10 text-accent",
          warning: "border-warning/30 bg-warning/10 text-warning",
          danger: "border-danger/25 bg-danger/10 text-danger",
          neutral: "border-border bg-surface-2 text-text-muted"
        }[STATUS_TONE[status]]
      )}
    >
      <StatusDot status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Tells the user where their content goes for a knowledge base (important for DLP review). */
export function DataDestinationBadge({ destination }: { destination: DataDestination }) {
  const config = {
    local: { tone: "success" as const, icon: Lock },
    external: { tone: "warning" as const, icon: Cloud },
    blocked: { tone: "danger" as const, icon: ShieldAlert },
    unset: { tone: "neutral" as const, icon: CloudOff }
  }[destination.tone];
  return (
    <Pill tone={config.tone} icon={config.icon} title={destination.detail} className="max-w-[22rem]">
      {destination.label}
    </Pill>
  );
}

/** App-wide data policy indicator (sidebar footer). */
export function DataPolicyBadge({ settings, onClick }: { settings: AppSettings; onClick?: () => void }) {
  const localOnly = settings.dataPolicy === "local-only";
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        localOnly
          ? "Local-only mode: only models running on this computer (Ollama) can be used."
          : "Cloud providers are allowed. Each knowledge base shows where its content is sent."
      }
      className={cx(
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs font-medium transition-colors",
        localOnly ? "border-success/25 bg-success/10 text-success hover:bg-success/15" : "border-border bg-surface-2 text-text-muted hover:text-text"
      )}
    >
      {localOnly ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <Cloud className="h-3.5 w-3.5" aria-hidden />}
      {localOnly ? "Local only" : "Cloud allowed"}
    </button>
  );
}
