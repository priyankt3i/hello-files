import type { ReactNode } from "react";
import type { Channel, IndexProgressEvent, IndexedFileRecord, Message } from "@fschat/shared";

export function ProgressCard({ progress }: { progress: IndexProgressEvent }) {
  const percentage = Math.min(100, (progress.processedFiles / Math.max(progress.totalFiles || 1, 1)) * 100);
  return (
    <div className="mb-4 min-w-0 rounded-3xl bg-white/6 p-4">
      <div className="mb-2 flex items-center justify-between text-sm text-paper">
        <span>{progress.phase}</span>
        <span>
          {progress.processedFiles}/{Math.max(progress.totalFiles, 1)}
        </span>
      </div>
      <div className="h-2 rounded-full bg-white/8">
        <div className="h-2 rounded-full bg-gradient-to-r from-ember to-coral" style={{ width: `${percentage}%` }} />
      </div>
      <div className="break-anywhere mt-3 max-h-28 overflow-y-auto text-xs leading-5 text-mist/70">
        {progress.message ? <div>{progress.message}</div> : null}
        {progress.currentFile ? <div className={progress.message ? "mt-1 text-mist/55" : ""}>{progress.currentFile}</div> : null}
      </div>
      <div className="mt-3 flex gap-2 text-xs text-mist/80">
        <span>{progress.successCount} indexed</span>
        <span>{progress.failureCount} failed</span>
      </div>
    </div>
  );
}

export function CitationsPanel({ messages }: { messages: Message[] }) {
  const citedMessage = [...messages].reverse().find((message) => message.role === "assistant" && message.citations.length > 0);
  if (!citedMessage) {
    return <div className="text-sm text-mist/70">Assistant citations will appear here after a grounded response.</div>;
  }
  return (
    <>
      {citedMessage.citations.map((citation) => (
        <div key={`${citation.chunkId}-${citation.relativePath}`} className="mb-3 rounded-3xl bg-black/15 p-4">
          <div className="break-anywhere text-sm font-medium text-paper">{citation.relativePath}</div>
          <div className="mt-1 text-xs text-mist/55">Score {citation.score.toFixed(3)}</div>
          <div className="break-anywhere mt-3 text-xs leading-6 text-mist/80">{citation.snippet}</div>
        </div>
      ))}
    </>
  );
}

export function StatusPill({ status }: { status: Channel["status"] }) {
  const tones: Record<Channel["status"], string> = {
    ready: "bg-moss/20 text-moss",
    indexing: "bg-ember/20 text-ember",
    stale: "bg-yellow-400/20 text-yellow-300",
    error: "bg-coral/20 text-coral",
    idle: "bg-white/10 text-mist"
  };
  return <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${tones[status]}`}>{status}</span>;
}

export function FileRow({ file, tone }: { file: IndexedFileRecord; tone: "success" | "failed" }) {
  return (
    <div className="mb-2 min-w-0 rounded-2xl bg-black/10 px-3 py-3">
      <div className="break-anywhere text-sm text-paper">{file.relativePath}</div>
      <div className="mt-1 text-xs text-mist/65">
        {file.parser} - {file.chunks} chunks
      </div>
      {tone === "failed" && file.errorReason ? <div className="break-anywhere mt-2 text-xs text-coral">{file.errorReason}</div> : null}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm text-mist">{label}</span>
      {children}
    </label>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="glass-panel shell-border max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-[30px] p-6 shadow-panel">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div className="min-w-0 font-display text-3xl text-paper">{title}</div>
          <button className="shrink-0 rounded-full border border-white/10 px-4 py-2 text-sm text-mist" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
