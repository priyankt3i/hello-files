import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  IndexedDocumentRecord,
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

type PythonCommand = {
  command: string;
  args: string[];
};

export class PythonWorkerBridge extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private activeBuildChannels = new Set<string>();
  private pythonCommand: PythonCommand | null = null;

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

  async listDocuments(rootPath: string): Promise<{ documents: IndexedDocumentRecord[] }> {
    return this.request("list_documents", { rootPath });
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

    const pythonCommand = this.getPythonCommand();
    const child = spawn(pythonCommand.command, [...pythonCommand.args, "-u", workerPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process = child;

    let workerFailed = false;
    let stderrBuffer = "";

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

      const envelopes = parseWorkerEnvelopes(line);
      if (!envelopes.length) {
        this.emit("stderr", `[python-worker stdout] ${line}`);
        return;
      }

      try {
        for (const envelope of envelopes) {
        if (envelope.type === "response" && envelope.id) {
          const pending = this.pending.get(envelope.id);
          if (!pending) {
            continue;
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
          continue;
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
          continue;
        }

        if (envelope.type === "event" && envelope.method === "file_update") {
          this.emit("file_update", envelope.payload as IndexFileUpdateEvent);
        }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failWorker(new Error(`Python worker protocol error: ${message}`), true);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuffer = `${stderrBuffer}${text}`.slice(-6000);
      this.emit("stderr", text);
    });

    child.on("exit", (code) => {
      const stderrDetail = stderrBuffer.trim();
      const suffix = stderrDetail ? `\n${stderrDetail}` : "";
      failWorker(new Error(`Python worker exited with code ${code}.${suffix}`), false);
    });

    child.on("error", (error) => {
      failWorker(error, false);
    });
  }

  private getPythonCommand(): PythonCommand {
    if (this.pythonCommand) {
      return this.pythonCommand;
    }

    const customPython = process.env.FSCHAT_PYTHON_BIN?.trim();
    const candidates: PythonCommand[] = [];
    if (customPython) {
      candidates.push({ command: customPython, args: [] });
    }
    if (process.platform === "win32") {
      candidates.push({ command: "python", args: [] }, { command: "py", args: ["-3"] });
    } else {
      candidates.push({ command: "python", args: [] }, { command: "python3", args: [] });
    }

    for (const candidate of candidates) {
      const probe = spawnSync(candidate.command, [...candidate.args, "--version"], {
        stdio: "ignore"
      });
      if (!probe.error && probe.status === 0) {
        this.pythonCommand = candidate;
        return candidate;
      }
    }

    const attempted = candidates.map((candidate) => [candidate.command, ...candidate.args].join(" ")).join(", ");
    throw new Error(
      `Python executable not found. Install Python and ensure one of these commands works: ${attempted}. ` +
      "You can also set FSCHAT_PYTHON_BIN to an explicit executable path."
    );
  }
}

function parseWorkerEnvelopes(line: string): WorkerEnvelope[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }

  try {
    return [JSON.parse(trimmed) as WorkerEnvelope];
  } catch {
    const parsed = parseConcatenatedJsonObjects(trimmed);
    return parsed.map((item) => item as WorkerEnvelope);
  }
}

function parseConcatenatedJsonObjects(text: string): unknown[] {
  const objects: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}") {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const slice = text.slice(start, index + 1);
        objects.push(JSON.parse(slice));
        start = -1;
      }
    }
  }

  return objects;
}
