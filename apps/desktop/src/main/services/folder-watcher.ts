import { watch, type FSWatcher } from "node:fs";

// Mirrors the Python worker's discovery rules closely enough to avoid waking up for noise.
// The worker remains the source of truth for what actually gets indexed.
const IGNORED_SEGMENTS = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vs",
  ".fschat-index",
  ".fschat-index.tmp"
]);
const IGNORED_FILE_NAMES = new Set(["thumbs.db", "desktop.ini"]);
const DEFAULT_DEBOUNCE_MS = 4000;

type WatchedFolder = {
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  excludeMatchers: RegExp[];
};

/**
 * Watches channel folders and reports (debounced) that a channel needs an incremental sync.
 */
export class FolderWatcher {
  private watched = new Map<string, WatchedFolder>();

  constructor(
    private readonly onChange: (channelId: string) => void,
    private readonly onError: (channelId: string, error: Error) => void,
    private readonly debounceMs = DEFAULT_DEBOUNCE_MS
  ) {}

  isWatching(channelId: string) {
    return this.watched.has(channelId);
  }

  watch(channelId: string, rootPath: string, excludePatterns: string[]) {
    this.unwatch(channelId);

    let watcher: FSWatcher;
    try {
      watcher = watch(rootPath, { recursive: true, persistent: false });
    } catch (error) {
      this.onError(channelId, error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const entry: WatchedFolder = {
      watcher,
      timer: null,
      excludeMatchers: excludePatterns.map(globToRegExp)
    };

    watcher.on("change", (_eventType, filename) => {
      const relativePath = typeof filename === "string" ? filename : filename?.toString("utf8");
      if (relativePath && shouldIgnore(relativePath, entry.excludeMatchers)) {
        return;
      }
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.onChange(channelId);
      }, this.debounceMs);
    });

    watcher.on("error", (error) => {
      this.unwatch(channelId);
      this.onError(channelId, error);
    });

    this.watched.set(channelId, entry);
  }

  unwatch(channelId: string) {
    const entry = this.watched.get(channelId);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.watcher.close();
    this.watched.delete(channelId);
  }

  unwatchAll() {
    for (const channelId of [...this.watched.keys()]) {
      this.unwatch(channelId);
    }
  }
}

export function shouldIgnore(relativePath: string, excludeMatchers: RegExp[] = []): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (IGNORED_SEGMENTS.has(lower) || segment.startsWith(".")) {
      return true;
    }
  }
  const fileName = segments.at(-1)?.toLowerCase() ?? "";
  if (fileName.startsWith("~$") || IGNORED_FILE_NAMES.has(fileName)) {
    return true;
  }
  return excludeMatchers.some((matcher) => matcher.test(normalized));
}

/** Converts a gitignore-style glob ("**", "*", "?") into an anchored, case-insensitive RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        const followedBySlash = normalized[index + 2] === "/";
        source += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // A bare name like "archive" or "*.tmp" should match at any depth, as in .gitignore.
  const anchored = normalized.includes("/") ? `^${source}` : `^(?:.*/)?${source}`;
  return new RegExp(`${anchored}(?:/.*)?$`, "i");
}
