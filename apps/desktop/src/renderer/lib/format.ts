import type { Channel, IndexProgressEvent } from "@fschat/shared";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    // Electron prefixes IPC errors with "Error invoking remote method '...': Error: ".
    return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  }
  return typeof error === "string" ? error : "Something went wrong.";
}

const numberFormat = new Intl.NumberFormat();
export function formatNumber(value: number) {
  return numberFormat.format(value);
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatRelativeTime(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "never";
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "unknown";
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  return new Date(time).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "";
}

export const STATUS_LABEL: Record<Channel["status"], string> = {
  ready: "Ready",
  indexing: "Indexing…",
  stale: "Needs sync",
  error: "Needs attention",
  idle: "Not indexed yet"
};

export const PHASE_LABEL: Record<IndexProgressEvent["phase"], string> = {
  discovering: "Finding files",
  extracting: "Reading files",
  embedding: "Building search index",
  writing: "Saving",
  completed: "Finished",
  cancelled: "Cancelled",
  error: "Failed"
};

export function isTerminalPhase(phase: IndexProgressEvent["phase"]) {
  return phase === "completed" || phase === "cancelled" || phase === "error";
}

export function isChatReady(status: Channel["status"]) {
  return status === "ready" || status === "stale";
}

export function fileName(relativePath: string) {
  const parts = relativePath.split(/[\\/]/);
  return parts[parts.length - 1] || relativePath;
}

export function fileExtension(relativePath: string) {
  const name = fileName(relativePath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export type FileKind = "pdf" | "doc" | "sheet" | "image" | "slides" | "text" | "other";

export function fileKind(relativePath: string): FileKind {
  const ext = fileExtension(relativePath);
  if (ext === "pdf") return "pdf";
  if (["doc", "docx", "rtf", "odt"].includes(ext)) return "doc";
  if (["xls", "xlsx", "xlsm", "csv", "tsv", "ods"].includes(ext)) return "sheet";
  if (["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "svg"].includes(ext)) return "image";
  if (["ppt", "pptx", "odp"].includes(ext)) return "slides";
  if (["txt", "md", "json", "xml", "html", "htm", "log", "yaml", "yml", "ini", "eml", "msg"].includes(ext)) return "text";
  return "other";
}

export function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}
