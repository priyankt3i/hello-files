import { useState } from "react";
import { LoaderCircle, Square } from "lucide-react";
import type { Channel, IndexProgressEvent } from "@fschat/shared";
import { PHASE_LABEL, formatNumber } from "../../lib/format";
import { useAppStore } from "../../state/store";
import { Button } from "../ui/button";
import { ProgressBar } from "../ui/feedback";
import { Modal } from "../ui/modal";

export function IndexProgressPanel({ channel, progress }: { channel: Channel; progress: IndexProgressEvent | undefined }) {
  const { state, actions } = useAppStore();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelling = Boolean(state.cancellingByChannel[channel.id]);
  const phase = progress ? PHASE_LABEL[progress.phase] : "Starting";
  const total = progress?.totalFiles ?? 0;
  const processed = progress?.processedFiles ?? 0;

  return (
    <div className="rounded-md border border-accent/30 bg-accent/5 p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-accent" aria-hidden />
          <div className="text-sm font-medium text-text">
            {cancelling ? "Cancelling…" : `${phase}…`}
            {total > 0 ? (
              <span className="ml-2 font-normal tabular-nums text-text-muted">
                {formatNumber(processed)} of {formatNumber(total)} files
              </span>
            ) : null}
          </div>
        </div>
        <Button size="sm" icon={Square} onClick={() => setConfirmCancel(true)} disabled={cancelling}>
          {cancelling ? "Cancelling…" : "Cancel"}
        </Button>
      </div>
      <div className="mt-3">
        <ProgressBar value={processed} max={total} label="Indexing progress" />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-text-muted">
        <span className="min-w-0 flex-1 truncate" title={progress?.currentFile}>
          {progress?.currentFile ?? progress?.message ?? "Preparing…"}
        </span>
        {progress ? (
          <span className="shrink-0 tabular-nums">
            {formatNumber(progress.successCount)} done · {formatNumber(progress.failureCount)} failed
          </span>
        ) : null}
      </div>

      {confirmCancel ? (
        <Modal
          title="Stop indexing?"
          size="sm"
          onClose={() => setConfirmCancel(false)}
          footer={
            <>
              <Button onClick={() => setConfirmCancel(false)} data-autofocus>
                Keep indexing
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmCancel(false);
                  void actions.cancelIndex(channel.id, false);
                }}
              >
                Discard this run
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirmCancel(false);
                  void actions.cancelIndex(channel.id, true);
                }}
              >
                Keep what's done
              </Button>
            </>
          }
        >
          <div className="space-y-2 text-sm leading-relaxed text-text-muted">
            <p>
              <span className="font-medium text-text">Keep what's done</span> makes the files indexed so far searchable now.
              The rest will be picked up on the next sync.
            </p>
            <p>
              <span className="font-medium text-text">Discard this run</span> throws away this run's progress and keeps the
              previous index, if there was one.
            </p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
