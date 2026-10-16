import type { ChannelSnapshot } from "@fschat/shared";
import { toErrorMessage } from "../lib/format";
import { mergeChannels, orderThreads } from "../lib/snapshot";
import type { useToasts } from "./toasts";
import { initialAppState, type AppState, type KbTab, type Patch } from "./types";

export interface ActionDeps {
  get: () => AppState;
  patch: Patch;
  toast: ReturnType<typeof useToasts>;
}

/** Bootstrap, channel/thread selection and chat. */
export function createCoreActions({ get, patch, toast }: ActionDeps) {
  async function refreshBootstrap(options?: { selectChannelId?: string | null }) {
    try {
      const data = await window.fsChat.bootstrap();
      const current = get().selectedChannelId;
      const wanted = options?.selectChannelId ?? current;
      const nextChannelId =
        wanted && data.channels.some((channel) => channel.id === wanted) ? wanted : data.channels[0]?.id ?? null;
      patch({
        channels: data.channels,
        connections: data.providerConnections,
        providerDefaults: data.providerDefaults,
        models: data.providerModels,
        settings: data.settings ?? { dataPolicy: "any" },
        features: data.features ?? { codexEnabled: false },
        indexStorageDir: data.indexStorageDir ?? "",
        threads: data.threads ?? [],
        defaultSystemPrompt: data.defaults?.systemPrompt ?? ""
      });
      if (nextChannelId) {
        await refreshChannel(nextChannelId);
      } else {
        patch({ selectedChannelId: null, snapshot: null, selectedThreadId: null, messages: [] });
      }
    } catch (caught) {
      toast.error("Couldn't load your knowledge bases", toErrorMessage(caught), "bootstrap");
    } finally {
      if (!get().ready) patch({ ready: true });
    }
  }

  /** Reloads a channel snapshot, makes it the selected channel, and loads the chosen thread's messages. */
  async function refreshChannel(channelId: string, options?: { preferredThreadId?: string | null }) {
    try {
      const snapshot = await window.fsChat.loadChannel(channelId);
      const state = get();
      const keepCurrent = state.selectedChannelId === channelId ? state.selectedThreadId : null;
      patch({ selectedChannelId: channelId });
      applySnapshot(snapshot);
      const threads = orderThreads(snapshot.threads);
      const preferred = options?.preferredThreadId;
      const threadId =
        preferred && threads.some((thread) => thread.id === preferred)
          ? preferred
          : keepCurrent && threads.some((thread) => thread.id === keepCurrent)
            ? keepCurrent
            : threads[0]?.id ?? null;
      patch({ selectedChannelId: channelId, selectedThreadId: threadId });
      const messages = threadId ? await window.fsChat.getThreadMessages(threadId) : [];
      if (get().selectedThreadId === threadId) patch({ messages });
    } catch (caught) {
      const message = toErrorMessage(caught);
      if (message.includes("Channel not found")) {
        patch({ selectedChannelId: null, snapshot: null, selectedThreadId: null, messages: [] });
        await refreshBootstrap();
        return;
      }
      toast.error("Couldn't load this knowledge base", message, `load-${channelId}`);
    }
  }

  /** Stores a snapshot returned by the backend (channel list + selected snapshot). */
  function applySnapshot(snapshot: ChannelSnapshot) {
    patch((state) => ({
      channels: mergeChannels(state.channels, snapshot.channel),
      snapshot: state.selectedChannelId === snapshot.channel.id ? snapshot : state.snapshot,
      threads: [...state.threads.filter((thread) => thread.channelId !== snapshot.channel.id), ...snapshot.threads]
    }));
  }

  /** Reloads a channel without changing the selection (used by background events). */
  async function reloadChannel(channelId: string) {
    try {
      applySnapshot(await window.fsChat.loadChannel(channelId));
    } catch {
      // The channel may have been deleted meanwhile; the next bootstrap will reconcile.
    }
  }

  async function selectChannel(channelId: string, tab?: KbTab) {
    if (get().selectedChannelId !== channelId) {
      patch({ selectedChannelId: channelId, snapshot: null, selectedThreadId: null, messages: [], tab: tab ?? "chat" });
    } else if (tab) {
      patch({ tab });
    }
    await refreshChannel(channelId);
  }

  async function selectThread(threadId: string) {
    patch({ selectedThreadId: threadId, tab: "chat" });
    try {
      const messages = await window.fsChat.getThreadMessages(threadId);
      if (get().selectedThreadId === threadId) patch({ messages });
    } catch (caught) {
      toast.error("Couldn't open this chat", toErrorMessage(caught));
    }
  }

  /** Opens a chat from the sidebar, switching knowledge base first if needed. */
  async function openThread(channelId: string, threadId: string) {
    if (get().selectedChannelId === channelId) {
      await selectThread(threadId);
      return;
    }
    patch({ selectedChannelId: channelId, snapshot: null, selectedThreadId: threadId, messages: [], tab: "chat", failedTurn: null });
    await refreshChannel(channelId, { preferredThreadId: threadId });
  }

  async function createThread(channelIdOverride?: string) {
    const channelId = channelIdOverride ?? get().selectedChannelId;
    if (!channelId) return;
    try {
      const thread = await window.fsChat.createThread({ channelId });
      patch({ tab: "chat", failedTurn: null });
      await refreshChannel(channelId, { preferredThreadId: thread.id });
    } catch (caught) {
      toast.error("Couldn't start a new chat", toErrorMessage(caught));
    }
  }

  async function renameThread(threadId: string, title: string) {
    const channelId = get().selectedChannelId;
    if (!channelId || !title.trim()) return;
    try {
      await window.fsChat.updateThreadTitle({ threadId, title: title.trim() });
      await refreshChannel(channelId, { preferredThreadId: get().selectedThreadId });
    } catch (caught) {
      toast.error("Couldn't rename this chat", toErrorMessage(caught));
    }
  }

  async function deleteThread(threadId: string) {
    try {
      const snapshot = await window.fsChat.deleteThread(threadId);
      applySnapshot(snapshot);
      const state = get();
      const nextThreadId =
        state.selectedThreadId === threadId ? orderThreads(snapshot.threads)[0]?.id ?? null : state.selectedThreadId;
      patch({ selectedThreadId: nextThreadId, failedTurn: null });
      patch({ messages: nextThreadId ? await window.fsChat.getThreadMessages(nextThreadId) : [] });
    } catch (caught) {
      toast.error("Couldn't delete this chat", toErrorMessage(caught));
    }
  }

  async function sendMessage(text: string) {
    const state = get();
    const channelId = state.selectedChannelId;
    const message = text.trim();
    if (!channelId || !message || state.pendingTurn) return false;
    const threadId = state.selectedThreadId;
    patch({ pendingTurn: { channelId, threadId, text: message, createdAt: new Date().toISOString() }, failedTurn: null });
    try {
      const result = await window.fsChat.sendMessage({ channelId, threadId, message });
      patch((current) => ({
        pendingTurn: null,
        // Only append if the user is still looking at the same chat.
        ...(current.selectedChannelId === channelId && current.selectedThreadId === threadId
          ? { selectedThreadId: result.thread.id, messages: [...current.messages, result.userMessage, result.assistantMessage] }
          : {})
      }));
      if (result.notice) {
        toast.warning("Answered with keyword search", result.notice);
      }
      if (get().selectedChannelId === channelId) {
        await refreshChannel(channelId, { preferredThreadId: get().selectedThreadId });
      }
      return true;
    } catch (caught) {
      // The backend saves nothing on failure, so keep the text for Retry / Edit.
      patch({ pendingTurn: null, failedTurn: { channelId, threadId, text: message, error: toErrorMessage(caught) } });
      return false;
    }
  }

  async function retryFailedTurn() {
    const failed = get().failedTurn;
    if (!failed) return;
    await sendMessage(failed.text);
  }

  function editFailedTurn() {
    const failed = get().failedTurn;
    if (!failed) return;
    patch({ failedTurn: null, composerSeed: { text: failed.text, nonce: Date.now() } });
  }

  function seedComposer(text: string) {
    patch({ composerSeed: { text, nonce: Date.now() } });
  }

  function consumeComposerSeed() {
    patch({ composerSeed: null });
  }

  function discardFailedTurn() {
    patch({ failedTurn: null });
  }

  async function openFile(channelId: string, relativePath: string) {
    try {
      await window.fsChat.openChannelFile({ channelId, relativePath });
    } catch (caught) {
      toast.error("Couldn't open the file", toErrorMessage(caught));
    }
  }

  async function revealFile(channelId: string, relativePath: string) {
    try {
      await window.fsChat.revealChannelFile({ channelId, relativePath });
    } catch (caught) {
      toast.error("Couldn't show the file in its folder", toErrorMessage(caught));
    }
  }

  async function openFolder(channelId: string) {
    try {
      await window.fsChat.openChannelFolder(channelId);
    } catch (caught) {
      toast.error("Couldn't open the folder", toErrorMessage(caught));
    }
  }

  async function openExternalUrl(url: string) {
    try {
      await window.fsChat.openExternalUrl(url);
    } catch (caught) {
      toast.error("Couldn't open the link", toErrorMessage(caught));
    }
  }

  function setTab(tab: KbTab) {
    patch({ tab });
  }

  function openNewKb() {
    patch({ newKbOpen: true });
  }

  function closeNewKb() {
    patch({ newKbOpen: false });
  }

  function openAppSettings(section: AppState["appSettingsSection"] = "providers") {
    patch({ appSettingsSection: section, newKbOpen: false });
  }

  function closeAppSettings() {
    patch({ appSettingsSection: null });
  }

  function resetLocalState() {
    patch({ ...initialAppState, ready: true });
  }

  return {
    refreshBootstrap,
    refreshChannel,
    applySnapshot,
    reloadChannel,
    selectChannel,
    selectThread,
    openThread,
    createThread,
    renameThread,
    deleteThread,
    sendMessage,
    retryFailedTurn,
    editFailedTurn,
    discardFailedTurn,
    seedComposer,
    consumeComposerSeed,
    openFile,
    revealFile,
    openFolder,
    openExternalUrl,
    setTab,
    openNewKb,
    closeNewKb,
    openAppSettings,
    closeAppSettings,
    resetLocalState
  };
}

export type CoreActions = ReturnType<typeof createCoreActions>;
