import type {
  ConnectProviderInput,
  DataPolicy,
  RegisterChannelInput,
  UpdateChannelModelsInput,
  UpdateChannelSettingsInput
} from "@fschat/shared";
import { toErrorMessage } from "../lib/format";
import type { ActionDeps, CoreActions } from "./core-actions";

/** Knowledge-base configuration, indexing and provider management. Mutations throw so forms can show inline errors. */
export function createAdminActions({ get, patch, toast }: ActionDeps, core: CoreActions) {
  function setCancelling(channelId: string, value: boolean) {
    patch((state) => {
      const next = { ...state.cancellingByChannel };
      if (value) next[channelId] = true;
      else delete next[channelId];
      return { cancellingByChannel: next };
    });
  }

  /** Runs an index job. The promise resolves when indexing ends, so we don't await it in the UI. */
  function runIndexJob(channelId: string, rebuild: boolean) {
    const job = rebuild ? window.fsChat.regenerateIndex(channelId) : window.fsChat.startIndex(channelId);
    void job
      .then((snapshot) => {
        core.applySnapshot(snapshot);
        const files = snapshot.indexedFiles.length;
        if (snapshot.channel.status === "ready") {
          toast.success(`${snapshot.channel.displayName} is ready`, `${files.toLocaleString()} files searchable.`);
        }
      })
      .catch((caught) => {
        const message = toErrorMessage(caught);
        if (/cancel/i.test(message)) return;
        const name = get().channels.find((channel) => channel.id === channelId)?.displayName ?? "Knowledge base";
        toast.error(`Indexing failed for ${name}`, message, `index-error-${channelId}`);
      });
  }

  function startSync(channelId: string) {
    patch({ tab: "files" });
    runIndexJob(channelId, false);
  }

  function rebuildIndex(channelId: string) {
    patch({ tab: "files" });
    runIndexJob(channelId, true);
  }

  async function cancelIndex(channelId: string, retainPartial: boolean) {
    setCancelling(channelId, true);
    try {
      await window.fsChat.cancelIndex({ channelId, retainPartial });
    } catch (caught) {
      setCancelling(channelId, false);
      toast.error("Couldn't cancel indexing", toErrorMessage(caught));
    }
  }

  async function updateChannelModels(input: UpdateChannelModelsInput) {
    const snapshot = await window.fsChat.updateChannelModels(input);
    core.applySnapshot(snapshot);
    toast.success("AI model settings saved");
    return snapshot;
  }

  async function updateSystemPrompt(channelId: string, systemPrompt: string) {
    const snapshot = await window.fsChat.updateChannelSystemPrompt({ channelId, systemPrompt });
    core.applySnapshot(snapshot);
    toast.success("Assistant instructions saved");
  }

  async function updateChannelSettings(input: UpdateChannelSettingsInput) {
    const snapshot = await window.fsChat.updateChannelSettings(input);
    core.applySnapshot(snapshot);
    toast.success("Settings saved");
  }

  async function deleteChannel(channelId: string) {
    const name = get().channels.find((channel) => channel.id === channelId)?.displayName ?? "Knowledge base";
    await window.fsChat.deleteChannel({ channelId, removeIndex: true });
    if (get().selectedChannelId === channelId) {
      patch({ selectedChannelId: null, snapshot: null, selectedThreadId: null, messages: [], tab: "chat" });
    }
    patch((state) => {
      const progress = { ...state.progressByChannel };
      delete progress[channelId];
      return { progressByChannel: progress };
    });
    await core.refreshBootstrap();
    toast.success(`Deleted ${name}`, "Your original files were not touched.");
  }

  /** Creates a knowledge base, selects it, and starts indexing (landing on the Files tab). */
  async function createKnowledgeBase(input: RegisterChannelInput) {
    const snapshot = await window.fsChat.registerChannel(input);
    patch({ newKbOpen: false });
    await core.refreshBootstrap({ selectChannelId: snapshot.channel.id });
    patch({ tab: "files" });
    if (snapshot.channel.status !== "ready") {
      runIndexJob(snapshot.channel.id, false);
    }
  }

  async function connectProvider(input: ConnectProviderInput) {
    const result = await window.fsChat.connectProvider(input);
    await core.refreshBootstrap();
    toast.success(`Connected ${result.connection.name}`, `${result.models.length} models found.`);
    return result;
  }

  async function refreshProviderModels(connectionId: string) {
    try {
      const result = await window.fsChat.refreshProviderModels(connectionId);
      await core.refreshBootstrap();
      toast.success("Model list refreshed", `${result.models.length} models available.`);
      return result.warnings;
    } catch (caught) {
      toast.error("Couldn't refresh models", toErrorMessage(caught));
      return [];
    }
  }

  async function saveProviderDefaults(connectionId: string, chatModelId: string | null, embeddingModelId: string | null) {
    const defaults = await window.fsChat.saveProviderDefaults(connectionId, chatModelId, embeddingModelId);
    patch((state) => ({
      providerDefaults: [...state.providerDefaults.filter((item) => item.connectionId !== connectionId), defaults]
    }));
    toast.success("Default models saved");
  }

  async function deleteProviderConnection(connectionId: string) {
    await window.fsChat.deleteProviderConnection(connectionId);
    await core.refreshBootstrap();
    toast.success("Provider removed", "Its stored API key was deleted from this computer.");
  }

  async function setDataPolicy(dataPolicy: DataPolicy) {
    try {
      const settings = await window.fsChat.updateAppSettings({ ...get().settings, dataPolicy });
      patch({ settings });
      await core.refreshBootstrap();
      toast.info(dataPolicy === "local-only" ? "Local-only mode is on" : "Cloud providers are allowed");
    } catch (caught) {
      toast.error("Couldn't change the privacy setting", toErrorMessage(caught));
    }
  }

  async function resetAppData() {
    await window.fsChat.resetAppData();
    core.resetLocalState();
    await core.refreshBootstrap();
    toast.success("All app data was reset", "Your original files were not touched.");
  }

  return {
    startSync,
    rebuildIndex,
    cancelIndex,
    setCancelling,
    updateChannelModels,
    updateSystemPrompt,
    updateChannelSettings,
    deleteChannel,
    createKnowledgeBase,
    connectProvider,
    refreshProviderModels,
    saveProviderDefaults,
    deleteProviderConnection,
    setDataPolicy,
    resetAppData
  };
}

export type AdminActions = ReturnType<typeof createAdminActions>;
