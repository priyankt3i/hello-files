import type { Channel, ChannelSnapshot, IndexFileUpdateEvent, IndexedFileRecord, Thread } from "@fschat/shared";

export function mergeChannels(current: Channel[], channel: Channel) {
  const others = current.filter((item) => item.id !== channel.id);
  return [...others, channel].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

/** Most recently active chats first. */
export function orderThreads(threads: Thread[]) {
  return [...threads].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

const byPath = (left: IndexedFileRecord, right: IndexedFileRecord) => left.relativePath.localeCompare(right.relativePath);

/** Applies a live per-file update from the indexer to the selected channel's snapshot. */
export function mergeSnapshotFileUpdate(current: ChannelSnapshot | null, event: IndexFileUpdateEvent) {
  if (!current || current.channel.id !== event.channelId) {
    return current;
  }
  const path = event.file.relativePath;
  const indexedFiles = current.indexedFiles.filter((file) => file.relativePath !== path);
  const failedFiles = current.failedFiles.filter((file) => file.relativePath !== path);
  const skippedFiles = (current.skippedFiles ?? []).filter((file) => file.relativePath !== path);

  const target = event.file.status === "indexed" ? indexedFiles : event.file.status === "skipped" ? skippedFiles : failedFiles;
  target.push(event.file);
  target.sort(byPath);

  return { ...current, indexedFiles, failedFiles, skippedFiles };
}
