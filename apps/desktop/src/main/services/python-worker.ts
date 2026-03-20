import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  IndexFileUpdateEvent,
  IndexManifest,
  IndexProgressEvent,
  IndexedFileRecord,
  SearchResult,
  WorkerBuildResponse,
  WorkerBuildOptions,
  WorkerEnvelope
} from "@fschat/shared";

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  channelId?: string;
  method: string;
};

export class PythonWorkerBridge extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private activeBuildChannels = new Set<string>();

  async openIndex(rootPath: string): Promise<{ manifest: IndexManifest }> {
    return this.request("open_index", { rootPath });
  }

  async getIndexStatus(rootPath: string): Promise<{ exists: boolean; manifest?: IndexManifest }> {
    return this.request("get_index_status", { rootPath });
  }

  async buildIndex(channelId: string, rootPath: string, options: WorkerBuildOptions): Promise<WorkerBuildResponse> {
    return this.request("build_index", { channelId, rootPath, options });
  }

  async rebuildIndex(channelId: string, rootPath: string, options: WorkerBuildOptions): Promise<WorkerBuildResponse> {
    return this.request("rebuild_index", { channelId, rootPath, options });
  }

  async cancelBuild(channelId: string, retainPartial: boolean): Promise<void> {
    await this.request("cancel_build", { channelId, retainPartial });
  }

  hasActiveBuild(channelId: string) {
    return this.activeBuildChannels.has(channelId);
  }

  hasAnyActiveBuild() {
    return this.activeBuildChannels.size > 0;
  }

  async listFiles(rootPath: string, status: "indexed" | "failed"): Promise<{ files: IndexedFileRecord[] }> {
    return this.request("list_files", { rootPath, status });
  }

  async search(rootPath: string, query: string, topK: number, options: WorkerBuildOptions): Promise<{ results: SearchResult[] }> {
    return this.request("search", { rootPath, query, topK, options });
  }

  private async request<TResponse>(method: string, payload: unknown): Promise<TResponse> {
    this.ensureProcess();
    const id = randomUUID();
    const envelope: WorkerEnvelope = {
      id,
      type: "request",
      method,
      payload
    };

    const process = this.process;
    if (!process) {
      throw new Error("Python worker failed to start.");
    }

    return new Promise<TResponse>((resolve, reject) => {
      const channelId =
        (method === "build_index" || method === "rebuild_index") &&
        payload &&
        typeof payload === "object" &&
        "channelId" in payload &&
        typeof (payload as { channelId?: unknown }).channelId === "string"
          ? ((payload as { channelId: string }).channelId)
          : null;

      if (channelId) {
        this.activeBuildChannels.add(channelId);
      }

      this.pending.set(id, { resolve, reject, channelId: channelId ?? undefined, method });
      process.stdin.write(`${JSON.stringify(envelope)}\n`);
    });
  }

  private ensureProcess() {
    if (this.process) {
      return;
    }

    const workerPath = resolve(
      fileURLToPath(new URL(".", import.meta.url)),
      "../../../../services/indexer/fschat_indexer/worker.py"
    );

    const child = spawn("python", ["-u", workerPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process = child;

    let workerFailed = false;

    const rejectAll = (reason: Error) => {
      this.activeBuildChannels.clear();
      for (const [id, pending] of this.pending.entries()) {
        pending.reject(reason);
        this.pending.delete(id);
      }
    };

    const failWorker = (reason: Error, terminate: boolean) => {
      if (workerFailed) {
        return;
      }
      workerFailed = true;
      this.process = null;
      rejectAll(reason);
      this.emit("error", reason);
      if (terminate && !child.killed) {
        child.kill();
      }
    };

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      try {
        const envelope = JSON.parse(line) as WorkerEnvelope;
        if (envelope.type === "response" && envelope.id) {
          const pending = this.pending.get(envelope.id);
          if (!pending) {
            return;
          }

          this.pending.delete(envelope.id);
          if (envelope.ok) {
            pending.resolve(envelope.payload);
          } else {
            pending.reject(new Error(envelope.error ?? "Python worker request failed."));
          }

          if (
            pending.channelId &&
            (pending.method === "build_index" || pending.method === "rebuild_index")
          ) {
            this.activeBuildChannels.delete(pending.channelId);
          }
          return;
        }

        if (envelope.type === "event" && envelope.method === "progress") {
          const progress = envelope.payload as IndexProgressEvent;
          if (
            progress.phase === "completed" ||
            progress.phase === "cancelled" ||
            progress.phase === "error"
          ) {
            this.activeBuildChannels.delete(progress.channelId);
          }
          this.emit("progress", progress);
          return;
        }

        if (envelope.type === "event" && envelope.method === "file_update") {
          this.emit("file_update", envelope.payload as IndexFileUpdateEvent);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failWorker(new Error(`Python worker protocol error: ${message}`), true);
      }
    });

    child.stderr.on("data", (chunk) => {
      this.emit("stderr", chunk.toString());
    });

    child.on("exit", (code) => {
      failWorker(new Error(`Python worker exited with code ${code}.`), false);
    });

    child.on("error", (error) => {
      failWorker(error, false);
    });
  }
}
