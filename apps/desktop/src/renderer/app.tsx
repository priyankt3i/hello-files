import { useEffect, useMemo, useState } from "react";
import type {
  Channel,
  ChannelSnapshot,
  IndexFileUpdateEvent,
  IndexProgressEvent,
  IndexedFileRecord,
  Message,
  ProviderConnection,
  ProviderDefaults,
  ProviderModel,
  Thread
} from "@fschat/shared";
import { CitationsPanel, Field, FileRow, Modal, ProgressCard, StatusPill } from "./ui/common";
import { SettingsModal } from "./ui/settings-modal";

type RootInspection = {
  rootPath: string;
  indexPath: string;
  defaultDisplayName: string;
  hasExistingIndex: boolean;
  existingChannel: Channel | null;
};

export function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [providerDefaults, setProviderDefaults] = useState<ProviderDefaults[]>([]);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ChannelSnapshot | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressByChannel, setProgressByChannel] = useState<Record<string, IndexProgressEvent>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspection, setInspection] = useState<RootInspection | null>(null);
  const [channelName, setChannelName] = useState("");
  const [pendingPreferredConnectionId, setPendingPreferredConnectionId] = useState<string | null>(null);
  const [pendingChatModelId, setPendingChatModelId] = useState<string | null>(null);
  const [pendingEmbeddingModelId, setPendingEmbeddingModelId] = useState<string | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [cancelPrompt, setCancelPrompt] = useState<{ channelId: string; channelName: string } | null>(null);
  const [channelModelsOpen, setChannelModelsOpen] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState<{ channelId: string; channelName: string } | null>(null);
  const [cancellingByChannel, setCancellingByChannel] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void refreshBootstrap();
    const offProgress = window.fsChat.onIndexProgress((event) => {
      if (event.channelId === "global") {
        setError(event.message ?? "Background error.");
        return;
      }
      if (event.phase === "error") {
        setError(event.message ?? `Indexing failed for channel ${event.channelId}.`);
      }
      setProgressByChannel((current) => ({ ...current, [event.channelId]: event }));
      if (event.phase === "completed" || event.phase === "cancelled" || event.phase === "error") {
        setCancellingByChannel((current) => {
          if (!current[event.channelId]) {
            return current;
          }
          const next = { ...current };
          delete next[event.channelId];
          return next;
        });
      }
      if (event.phase === "completed" || event.phase === "cancelled") {
        void refreshChannel(event.channelId);
      }
    });
    const offFileUpdate = window.fsChat.onIndexFileUpdate((event) => {
      setSnapshot((current) => mergeSnapshotFileUpdate(current, event, selectedChannelId));
    });
    const offChannel = window.fsChat.onChannelRefreshed((nextSnapshot) => {
      setChannels((current) => mergeChannels(current, nextSnapshot.channel));
      if (nextSnapshot.channel.status !== "indexing") {
        setCancellingByChannel((current) => {
          if (!current[nextSnapshot.channel.id]) {
            return current;
          }
          const next = { ...current };
          delete next[nextSnapshot.channel.id];
          return next;
        });
      }
      if (selectedChannelId === nextSnapshot.channel.id) {
        setSnapshot(nextSnapshot);
      }
    });
    return () => {
      offProgress();
      offFileUpdate();
      offChannel();
    };
  }, [selectedChannelId]);

  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId) ?? null;
  const connectionById = useMemo(
    () => Object.fromEntries(connections.map((connection) => [connection.id, connection])),
    [connections]
  );
  const providerDefaultsByConnectionId = useMemo(
    () => Object.fromEntries(providerDefaults.map((item) => [item.connectionId, item])),
    [providerDefaults]
  );
  const chatModels = models.filter((model) => model.supportsChat);
  const embeddingModels = models.filter((model) => model.supportsEmbedding);
  const hasProviderProfiles = chatModels.length > 0 && embeddingModels.length > 0;
  const selectedThread = snapshot?.threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const selectedProgress = selectedChannelId ? progressByChannel[selectedChannelId] : undefined;
  const filteredIndexedFiles = useMemo(() => filterFiles(snapshot?.indexedFiles ?? [], fileQuery), [snapshot?.indexedFiles, fileQuery]);
  const filteredFailedFiles = useMemo(() => filterFiles(snapshot?.failedFiles ?? [], fileQuery), [snapshot?.failedFiles, fileQuery]);
  const pendingConnectionChatModels = useMemo(
    () =>
      pendingPreferredConnectionId
        ? models.filter((model) => model.connectionId === pendingPreferredConnectionId && model.supportsChat)
        : [],
    [models, pendingPreferredConnectionId]
  );
  const pendingConnectionEmbeddingModels = useMemo(
    () =>
      pendingPreferredConnectionId
        ? models.filter((model) => model.connectionId === pendingPreferredConnectionId && model.supportsEmbedding)
        : [],
    [models, pendingPreferredConnectionId]
  );

  async function refreshBootstrap() {
    setBusy(true);
    try {
      const data = await window.fsChat.bootstrap();
      setChannels(data.channels);
      setConnections(data.providerConnections);
      setProviderDefaults(data.providerDefaults);
      setModels(data.providerModels);
      const nextChannelId =
        selectedChannelId && data.channels.some((channel) => channel.id === selectedChannelId)
          ? selectedChannelId
          : data.channels[0]?.id ?? null;
      if (nextChannelId) {
        setSelectedChannelId(nextChannelId);
        await refreshChannel(nextChannelId);
      } else {
        setSelectedChannelId(null);
        setSnapshot(null);
        setSelectedThreadId(null);
        setMessages([]);
      }
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function refreshChannel(channelId: string) {
    try {
      const nextSnapshot = await window.fsChat.loadChannel(channelId);
      setChannels((current) => mergeChannels(current, nextSnapshot.channel));
      setSnapshot(nextSnapshot);
      setSelectedChannelId(channelId);
      const threadId =
        selectedThreadId && nextSnapshot.threads.some((thread) => thread.id === selectedThreadId)
          ? selectedThreadId
          : nextSnapshot.threads[0]?.id ?? null;
      setSelectedThreadId(threadId);
      setMessages(threadId ? await window.fsChat.getThreadMessages(threadId) : []);
    } catch (caught) {
      const message = toErrorMessage(caught);
      if (message.includes("Channel not found")) {
        setSelectedChannelId(null);
        setSnapshot(null);
        setSelectedThreadId(null);
        setMessages([]);
        await refreshBootstrap();
        return;
      }
      throw caught;
    }
  }

  async function handleOpenRootPicker() {
    try {
      const rootPath = await window.fsChat.selectRootFolder();
      if (!rootPath) return;
      const result = await window.fsChat.inspectRootFolder(rootPath);
      setInspection(result);
      setChannelName(result.defaultDisplayName);
      const preferredConnectionId =
        result.existingChannel?.preferredConnectionId ??
        pickInitialConnectionId(connections, providerDefaultsByConnectionId) ??
        null;
      setPendingPreferredConnectionId(preferredConnectionId);
      const nextDefaults = preferredConnectionId ? providerDefaultsByConnectionId[preferredConnectionId] : undefined;
      setPendingChatModelId(result.existingChannel?.chatModelId ?? nextDefaults?.defaultChatModelId ?? null);
      setPendingEmbeddingModelId(result.existingChannel?.embeddingModelId ?? nextDefaults?.defaultEmbeddingModelId ?? null);
    } catch (caught) {
      setError(toErrorMessage(caught));
    }
  }

  async function handleCreateChannel() {
    if (!inspection) return;
    setBusy(true);
    try {
      const nextSnapshot = await window.fsChat.registerChannel({
        rootPath: inspection.rootPath,
        displayName: channelName,
        preferredConnectionId: pendingPreferredConnectionId,
        chatModelId: pendingChatModelId,
        embeddingModelId: pendingEmbeddingModelId
      });
      setCreateOpen(false);
      setInspection(null);
      setChannelName("");
      setPendingPreferredConnectionId(null);
      setPendingChatModelId(null);
      setPendingEmbeddingModelId(null);
      await refreshBootstrap();
      await refreshChannel(nextSnapshot.channel.id);
      if (nextSnapshot.channel.status !== "ready") {
        void window.fsChat.startIndex(nextSnapshot.channel.id);
      }
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectChannel(channelId: string) {
    try {
      await refreshChannel(channelId);
    } catch (caught) {
      setError(toErrorMessage(caught));
    }
  }

  async function handleSelectThread(threadId: string) {
    setSelectedThreadId(threadId);
    try {
      setMessages(await window.fsChat.getThreadMessages(threadId));
    } catch (caught) {
      setError(toErrorMessage(caught));
    }
  }

  async function handleSendMessage() {
    if (!selectedChannel || !composer.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.fsChat.sendMessage({
        channelId: selectedChannel.id,
        threadId: selectedThreadId,
        message: composer.trim()
      });
      setComposer("");
      setSelectedThreadId(result.thread.id);
      setMessages((current) => [...current, result.userMessage, result.assistantMessage]);
      await refreshChannel(selectedChannel.id);
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRegenerateIndex() {
    if (!selectedChannel || selectedChannel.status === "indexing" || cancellingByChannel[selectedChannel.id]) return;
    try {
      await window.fsChat.regenerateIndex(selectedChannel.id);
      await refreshChannel(selectedChannel.id);
    } catch (caught) {
      setError(toErrorMessage(caught));
    }
  }

  function handleCancelIndex() {
    if (!selectedChannel || selectedChannel.status !== "indexing" || cancellingByChannel[selectedChannel.id]) return;
    setCancelPrompt({ channelId: selectedChannel.id, channelName: selectedChannel.displayName });
  }

  async function handleConfirmCancelIndex(retainPartial: boolean) {
    if (!cancelPrompt) return;
    const { channelId } = cancelPrompt;
    try {
      setCancellingByChannel((current) => ({ ...current, [channelId]: true }));
      await window.fsChat.cancelIndex({ channelId, retainPartial });
      setCancelPrompt(null);
    } catch (caught) {
      setCancellingByChannel((current) => {
        const next = { ...current };
        delete next[channelId];
        return next;
      });
      setError(toErrorMessage(caught));
    }
  }

  async function handleSaveChannelModels(
    preferredConnectionId: string | null,
    chatModelId: string | null,
    embeddingModelId: string | null
  ) {
    if (!selectedChannel) return;
    setBusy(true);
    try {
      const nextSnapshot = await window.fsChat.updateChannelModels({
        channelId: selectedChannel.id,
        preferredConnectionId,
        chatModelId,
        embeddingModelId
      });
      setChannels((current) => mergeChannels(current, nextSnapshot.channel));
      setSnapshot(nextSnapshot);
      setChannelModelsOpen(false);
      if (selectedThreadId && !nextSnapshot.threads.some((thread) => thread.id === selectedThreadId)) {
        setSelectedThreadId(nextSnapshot.threads[0]?.id ?? null);
      }
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteChannel() {
    if (!deletePrompt) return;
    setBusy(true);
    try {
      await window.fsChat.deleteChannel(deletePrompt.channelId);
      setDeletePrompt(null);
      if (selectedChannelId === deletePrompt.channelId) {
        setSelectedChannelId(null);
        setSnapshot(null);
        setSelectedThreadId(null);
        setMessages([]);
      }
      await refreshBootstrap();
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleResetAppData() {
    setBusy(true);
    try {
      await window.fsChat.resetAppData();
      setChannels([]);
      setConnections([]);
      setProviderDefaults([]);
      setModels([]);
      setSelectedChannelId(null);
      setSnapshot(null);
      setSelectedThreadId(null);
      setMessages([]);
      setComposer("");
      setInspection(null);
      setChannelName("");
      setPendingPreferredConnectionId(null);
      setPendingChatModelId(null);
      setPendingEmbeddingModelId(null);
      setProgressByChannel({});
      setCancellingByChannel({});
      setDeletePrompt(null);
      setCancelPrompt(null);
      setChannelModelsOpen(false);
      setCreateOpen(false);
      setSettingsOpen(false);
      setError(null);
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-screen overflow-hidden bg-shell-gradient text-paper">
      <div className="grid h-full grid-cols-[minmax(260px,280px)_minmax(320px,360px)_minmax(0,1fr)] gap-4 overflow-hidden p-4">
        <Sidebar channels={channels} selectedChannelId={selectedChannelId} onSelect={handleSelectChannel} onOpenCreate={() => setCreateOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
        <FilesPanel
          selectedChannel={selectedChannel}
          connectionById={connectionById}
          models={models}
          indexedFiles={filteredIndexedFiles}
          failedFiles={filteredFailedFiles}
          fileQuery={fileQuery}
          onFileQuery={setFileQuery}
          progress={selectedProgress}
          isCancelling={selectedChannel ? Boolean(cancellingByChannel[selectedChannel.id]) : false}
          onOpenModels={() => setChannelModelsOpen(true)}
          onDelete={() => {
            if (selectedChannel) {
              setDeletePrompt({ channelId: selectedChannel.id, channelName: selectedChannel.displayName });
            }
          }}
          onRegenerate={handleRegenerateIndex}
          onCancel={handleCancelIndex}
        />
        <ChatPanel
          selectedChannel={selectedChannel}
          snapshot={snapshot}
          selectedThread={selectedThread}
          messages={messages}
          composer={composer}
          onComposer={setComposer}
          onSelectThread={handleSelectThread}
          onSend={handleSendMessage}
          busy={busy}
        />
      </div>

      {cancelPrompt ? (
        <CancelToast
          channelName={cancelPrompt.channelName}
          busy={Boolean(cancellingByChannel[cancelPrompt.channelId])}
          offsetForError={Boolean(error)}
          onClose={() => setCancelPrompt(null)}
          onRetain={() => void handleConfirmCancelIndex(true)}
          onDelete={() => void handleConfirmCancelIndex(false)}
        />
      ) : null}

      {channelModelsOpen && selectedChannel ? (
        <ChannelModelsModal
          channel={selectedChannel}
          connections={connections}
          providerDefaults={providerDefaults}
          models={models}
          onClose={() => setChannelModelsOpen(false)}
          onSave={handleSaveChannelModels}
        />
      ) : null}

      {deletePrompt ? (
        <DeleteChannelToast
          channelName={deletePrompt.channelName}
          busy={busy}
          offsetForError={Boolean(error)}
          onClose={() => setDeletePrompt(null)}
          onDelete={() => void handleDeleteChannel()}
        />
      ) : null}

      {createOpen ? (
        <Modal title="Create Channel" onClose={() => setCreateOpen(false)}>
          <div className="space-y-4">
            {!hasProviderProfiles ? (
              <div className="rounded-3xl border border-amber-300/20 bg-amber-400/10 p-4 text-sm text-amber-100">
                <div className="font-medium">Connected models are required before you can create a channel.</div>
                <div className="mt-1 text-xs text-amber-100/80">
                  Connect at least one provider with a chat-capable model and an embedding-capable model in Settings, then come back here.
                </div>
                <div className="mt-3">
                  <button
                    className="rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-ink"
                    onClick={() => {
                      setCreateOpen(false);
                      setSettingsOpen(true);
                    }}
                  >
                    Open Settings
                  </button>
                </div>
              </div>
            ) : null}
            <button className="rounded-full bg-ember px-4 py-2 text-sm font-semibold text-ink" onClick={() => void handleOpenRootPicker()}>
              Select Root Folder
            </button>
            {inspection ? (
              <>
                <div className="rounded-3xl bg-white/5 p-4 text-sm text-mist">
                  <div className="font-medium text-paper">{inspection.rootPath}</div>
                  <div className="mt-1 text-xs text-mist/70">
                    {inspection.hasExistingIndex ? "Existing index found and will be loaded." : "No index found. A new index will be created."}
                  </div>
                </div>
                <Field label="Channel name">
                  <input value={channelName} onChange={(event) => setChannelName(event.target.value)} className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none" />
                </Field>
                <Field label="Provider">
                  <select
                    value={pendingPreferredConnectionId ?? ""}
                    onChange={(event) => {
                      const nextConnectionId = event.target.value || null;
                      setPendingPreferredConnectionId(nextConnectionId);
                      const nextDefaults = nextConnectionId ? providerDefaultsByConnectionId[nextConnectionId] : undefined;
                      setPendingChatModelId(nextDefaults?.defaultChatModelId ?? null);
                      setPendingEmbeddingModelId(nextDefaults?.defaultEmbeddingModelId ?? null);
                    }}
                    className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none"
                    disabled={connections.length === 0}
                  >
                    <option value="">Select provider connection</option>
                    {connections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Chat model">
                  <select value={pendingChatModelId ?? ""} onChange={(event) => setPendingChatModelId(event.target.value || null)} className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none" disabled={pendingConnectionChatModels.length === 0}>
                    <option value="">Select chat model</option>
                    {pendingConnectionChatModels.map((model) => (
                      <option key={model.id} value={model.id}>{formatProviderModelLabel(model, connectionById[model.connectionId])}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Embedding model">
                  <select value={pendingEmbeddingModelId ?? ""} onChange={(event) => setPendingEmbeddingModelId(event.target.value || null)} className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none" disabled={pendingConnectionEmbeddingModels.length === 0}>
                    <option value="">Select embedding model</option>
                    {pendingConnectionEmbeddingModels.map((model) => (
                      <option key={model.id} value={model.id}>{formatProviderModelLabel(model, connectionById[model.connectionId])}</option>
                    ))}
                  </select>
                </Field>
                {pendingPreferredConnectionId && pendingConnectionEmbeddingModels.length === 0 ? (
                  <div className="rounded-3xl border border-coral/25 bg-coral/10 p-4 text-sm text-[#ffd1ca]">
                    The selected provider connection does not currently expose any embedding-capable models. Refresh the
                    provider or choose a different provider connection.
                  </div>
                ) : null}
                {pendingPreferredConnectionId && pendingConnectionChatModels.length === 0 ? (
                  <div className="rounded-3xl border border-coral/25 bg-coral/10 p-4 text-sm text-[#ffd1ca]">
                    The selected provider connection does not currently expose any chat-capable models. Refresh the
                    provider or choose a different provider connection.
                  </div>
                ) : null}
                <ModelSelectionHint
                  preferredConnection={pendingPreferredConnectionId ? connectionById[pendingPreferredConnectionId] ?? null : null}
                  selectedChatModel={pendingChatModelId ? models.find((model) => model.id === pendingChatModelId) ?? null : null}
                  selectedEmbeddingModel={
                    pendingEmbeddingModelId ? models.find((model) => model.id === pendingEmbeddingModelId) ?? null : null
                  }
                  connectionById={connectionById}
                />
                <div className="flex justify-end gap-2">
                  <button
                    className="rounded-full border border-white/10 px-4 py-2 text-sm text-mist"
                    onClick={() => {
                      setCreateOpen(false);
                      setSettingsOpen(true);
                    }}
                  >
                    Settings
                  </button>
                  <button className="rounded-full border border-white/10 px-4 py-2 text-sm text-mist" onClick={() => setCreateOpen(false)}>Close</button>
                  <button className="rounded-full bg-ember px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40" onClick={() => void handleCreateChannel()} disabled={!inspection || !channelName.trim() || !pendingPreferredConnectionId || !pendingEmbeddingModelId || !pendingChatModelId || pendingConnectionEmbeddingModels.length === 0 || pendingConnectionChatModels.length === 0 || !hasProviderProfiles}>Create Channel</button>
                </div>
              </>
            ) : (
              <div className="rounded-3xl border border-dashed border-white/10 p-5 text-sm text-mist/75">
                {hasProviderProfiles
                  ? "Pick a root folder to inspect existing index data and assign chat and embedding models."
                  : "Connect your providers in Settings first, then pick a root folder."}
              </div>
            )}
          </div>
        </Modal>
      ) : null}

      {settingsOpen ? (
        <SettingsModal
          connections={connections}
          providerDefaults={providerDefaults}
          models={models}
          onClose={() => setSettingsOpen(false)}
          onConnect={async (input) => {
            const result = await window.fsChat.connectProvider(input);
            await refreshBootstrap();
            return result;
          }}
          onResetAppData={handleResetAppData}
          onRefreshProviderModels={async (connectionId) => {
            const result = await window.fsChat.refreshProviderModels(connectionId);
            await refreshBootstrap();
            return result;
          }}
          onSaveProviderDefaults={async (connectionId, chatModelId, embeddingModelId) => {
            const nextDefaults = await window.fsChat.saveProviderDefaults(connectionId, chatModelId, embeddingModelId);
            setProviderDefaults((current) => mergeProviderDefaults(current, nextDefaults));
          }}
        />
      ) : null}

      {error ? (
        <div className="fixed bottom-5 right-5 z-50 w-[min(28rem,calc(100vw-2rem))] rounded-3xl border border-coral/30 bg-[#2f1213] px-5 py-4 text-sm text-[#ffd1ca] shadow-panel">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#ffb6aa]">Error</div>
            <button
              className="shrink-0 rounded-full border border-white/10 px-3 py-1 text-xs text-[#ffd1ca]/80"
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
          <div className="break-anywhere max-h-40 overflow-y-auto whitespace-pre-wrap leading-6">{error}</div>
        </div>
      ) : null}
    </div>
  );
}

function Sidebar({
  channels,
  selectedChannelId,
  onSelect,
  onOpenCreate,
  onOpenSettings
}: {
  channels: Channel[];
  selectedChannelId: string | null;
  onSelect: (channelId: string) => void | Promise<void>;
  onOpenCreate: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <aside className="glass-panel shell-border min-h-0 min-w-0 flex flex-col rounded-[28px] p-5 shadow-panel">
      <div className="mb-6">
        <div className="font-display text-3xl tracking-tight text-paper">Filesystem</div>
        <div className="text-sm text-mist/80">RAG Chat Workspace</div>
      </div>
      <div className="mb-4 flex gap-2">
        <button className="rounded-full bg-ember px-4 py-2 text-sm font-semibold text-ink" onClick={onOpenCreate}>Create Channel</button>
        <button className="rounded-full border border-white/10 px-4 py-2 text-sm text-mist" onClick={onOpenSettings}>Settings</button>
      </div>
      <div className="mb-3 text-xs uppercase tracking-[0.3em] text-mist/50">Channels</div>
      <div className="flex-1 space-y-2 overflow-y-auto pr-1">
        {channels.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-white/10 p-5 text-sm text-mist/75">Add a folder-backed channel to start indexing and chatting with local knowledge.</div>
        ) : (
          channels.map((channel) => (
            <button key={channel.id} className={`w-full min-w-0 rounded-3xl p-4 text-left transition ${selectedChannelId === channel.id ? "bg-white/12" : "bg-white/5 hover:bg-white/8"}`} onClick={() => void onSelect(channel.id)}>
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="truncate font-medium text-paper">{channel.displayName}</div>
                <StatusPill status={channel.status} />
              </div>
              <div className="mt-2 truncate text-xs text-mist/75">{channel.rootPath}</div>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

function FilesPanel({
  selectedChannel,
  connectionById,
  models,
  indexedFiles,
  failedFiles,
  fileQuery,
  onFileQuery,
  progress,
  isCancelling,
  onOpenModels,
  onDelete,
  onRegenerate,
  onCancel
}: {
  selectedChannel: Channel | null;
  connectionById: Record<string, ProviderConnection>;
  models: ProviderModel[];
  indexedFiles: IndexedFileRecord[];
  failedFiles: IndexedFileRecord[];
  fileQuery: string;
  onFileQuery: (value: string) => void;
  progress?: IndexProgressEvent;
  isCancelling: boolean;
  onOpenModels: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onRegenerate: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}) {
  if (!selectedChannel) {
    return <aside className="glass-panel shell-border min-h-0 min-w-0 flex items-center justify-center rounded-[28px] p-5 shadow-panel text-sm text-mist/75">Select a channel to inspect indexed files.</aside>;
  }
  const isIndexing = selectedChannel.status === "indexing";
  const preferredConnection = selectedChannel.preferredConnectionId
    ? connectionById[selectedChannel.preferredConnectionId] ?? null
    : null;
  const selectedChatModel = models.find((model) => model.id === selectedChannel.chatModelId) ?? null;
  const selectedEmbeddingModel = models.find((model) => model.id === selectedChannel.embeddingModelId) ?? null;
  return (
    <aside className="glass-panel shell-border min-h-0 min-w-0 flex flex-col rounded-[28px] p-5 shadow-panel">
      <div className="mb-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="break-anywhere font-display text-2xl leading-tight text-paper">{selectedChannel.displayName}</div>
            <div className="break-anywhere mt-1 text-xs text-mist/70">{selectedChannel.rootPath}</div>
          </div>
          <StatusPill status={selectedChannel.status} />
        </div>
        <div className="mt-3 space-y-1 text-xs text-mist/65">
          <div className="break-anywhere">Provider: {preferredConnection ? preferredConnection.name : "Not set"}</div>
          <div className="break-anywhere">
            Chat: {selectedChatModel ? formatProviderModelLabel(selectedChatModel, connectionById[selectedChatModel.connectionId]) : "Not set"}
          </div>
          <div className="break-anywhere">
            Embedding: {selectedEmbeddingModel ? formatProviderModelLabel(selectedEmbeddingModel, connectionById[selectedEmbeddingModel.connectionId]) : "Not set"}
          </div>
        </div>
      </div>
      {progress && selectedChannel.status === "indexing" ? <ProgressCard progress={progress} /> : null}
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          className="rounded-full border border-white/10 px-4 py-2 text-sm text-mist disabled:cursor-not-allowed disabled:opacity-35"
          onClick={() => void onOpenModels()}
          disabled={isIndexing || isCancelling}
        >
          Channel Models
        </button>
        <button
          className="rounded-full bg-white/10 px-4 py-2 text-sm text-paper disabled:cursor-not-allowed disabled:opacity-35"
          onClick={() => void onRegenerate()}
          disabled={isIndexing || isCancelling}
        >
          Regenerate
        </button>
        <button
          className={`rounded-full px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${
            isCancelling
              ? "border border-coral/70 bg-coral/25 text-[#ffd1ca] shadow-[0_0_0_1px_rgba(255,122,95,0.2)]"
              : isIndexing
                ? "border border-coral/60 bg-coral/15 text-[#ffd1ca] shadow-[0_0_0_1px_rgba(255,122,95,0.14)] hover:bg-coral/20"
                : "border border-white/10 text-mist"
          }`}
          onClick={() => void onCancel()}
          disabled={!isIndexing || isCancelling}
        >
          {isCancelling ? "Cancelling..." : "Cancel Indexing"}
        </button>
        <button
          className="rounded-full border border-coral/35 px-4 py-2 text-sm text-coral disabled:cursor-not-allowed disabled:opacity-35"
          onClick={() => void onDelete()}
          disabled={isIndexing || isCancelling}
        >
          Delete Channel
        </button>
      </div>
      <input value={fileQuery} onChange={(event) => onFileQuery(event.target.value)} placeholder="Filter files" className="mb-4 rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none placeholder:text-mist/45" />
      <div className="mb-3 text-xs uppercase tracking-[0.3em] text-mist/50">Indexed Files</div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-3xl bg-white/5 p-3">
        {indexedFiles.length === 0 ? <div className="px-2 py-3 text-sm text-mist/65">No indexed files yet.</div> : indexedFiles.map((file) => <FileRow key={file.relativePath} file={file} tone="success" />)}
      </div>
      <div className="mb-3 mt-5 text-xs uppercase tracking-[0.3em] text-mist/50">Failed Files</div>
      <div className="min-h-0 max-h-[220px] overflow-y-auto rounded-3xl bg-white/5 p-3">
        {failedFiles.length === 0 ? <div className="px-2 py-3 text-sm text-mist/65">No failed files.</div> : failedFiles.map((file) => <FileRow key={file.relativePath} file={file} tone="failed" />)}
      </div>
    </aside>
  );
}

function CancelToast({
  channelName,
  busy,
  offsetForError,
  onClose,
  onRetain,
  onDelete
}: {
  channelName: string;
  busy: boolean;
  offsetForError: boolean;
  onClose: () => void;
  onRetain: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`fixed right-5 z-40 w-[min(30rem,calc(100vw-2rem))] ${offsetForError ? "bottom-52" : "bottom-5"}`}>
      <div className="rounded-[28px] border border-coral/30 bg-[#22131a] px-5 py-4 text-sm text-[#ffe4dc] shadow-panel backdrop-blur-md">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#ffb9ab]">Cancel indexing?</div>
            <div className="mt-2 break-anywhere text-base font-medium text-paper">{channelName}</div>
          </div>
          <button
            className="shrink-0 rounded-full border border-white/10 px-3 py-1 text-xs text-[#ffd1ca]/80 disabled:opacity-40"
            onClick={onClose}
            disabled={busy}
          >
            Keep running
          </button>
        </div>
        <div className="break-anywhere text-sm leading-6 text-[#ffd1ca]/85">
          Choose whether to keep the files that already finished embedding, or discard this in-progress run and leave the last committed index untouched.
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="rounded-full bg-ember px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40"
            onClick={onRetain}
            disabled={busy}
          >
            {busy ? "Cancelling..." : "Retain partial index"}
          </button>
          <button
            className="rounded-full border border-coral/50 bg-coral/10 px-4 py-2 text-sm font-medium text-[#ffd1ca] disabled:opacity-40"
            onClick={onDelete}
            disabled={busy}
          >
            Discard partial index
          </button>
        </div>
      </div>
    </div>
  );
}

function ChannelModelsModal({
  channel,
  connections,
  providerDefaults,
  models,
  onClose,
  onSave
}: {
  channel: Channel;
  connections: ProviderConnection[];
  providerDefaults: ProviderDefaults[];
  models: ProviderModel[];
  onClose: () => void;
  onSave: (
    preferredConnectionId: string | null,
    chatModelId: string | null,
    embeddingModelId: string | null
  ) => void | Promise<void>;
}) {
  const [preferredConnectionId, setPreferredConnectionId] = useState(channel.preferredConnectionId ?? "");
  const [chatModelId, setChatModelId] = useState(channel.chatModelId ?? "");
  const [embeddingModelId, setEmbeddingModelId] = useState(channel.embeddingModelId ?? "");
  const connectionById = useMemo(
    () => Object.fromEntries(connections.map((connection) => [connection.id, connection])),
    [connections]
  );
  const providerDefaultsByConnectionId = useMemo(
    () => Object.fromEntries(providerDefaults.map((item) => [item.connectionId, item])),
    [providerDefaults]
  );
  const chatModels = useMemo(
    () =>
      preferredConnectionId
        ? models.filter((model) => model.connectionId === preferredConnectionId && model.supportsChat)
        : [],
    [models, preferredConnectionId]
  );
  const embeddingModels = useMemo(
    () =>
      preferredConnectionId
        ? models.filter((model) => model.connectionId === preferredConnectionId && model.supportsEmbedding)
        : [],
    [models, preferredConnectionId]
  );
  const embeddingChanged = (channel.embeddingModelId ?? "") !== embeddingModelId;
  const preferredConnection = preferredConnectionId ? connectionById[preferredConnectionId] ?? null : null;
  const selectedChatModel = chatModelId ? models.find((model) => model.id === chatModelId) ?? null : null;
  const selectedEmbeddingModel = embeddingModelId ? models.find((model) => model.id === embeddingModelId) ?? null : null;

  return (
    <Modal title="Channel Models" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-3xl bg-white/5 p-4 text-sm text-mist">
          <div className="font-medium text-paper">{channel.displayName}</div>
          <div className="mt-1 break-anywhere text-xs text-mist/70">{channel.rootPath}</div>
        </div>
        <Field label="Provider">
          <select
            value={preferredConnectionId}
            onChange={(event) => {
              const nextConnectionId = event.target.value;
              setPreferredConnectionId(nextConnectionId);
              const nextDefaults = nextConnectionId ? providerDefaultsByConnectionId[nextConnectionId] : undefined;
              setChatModelId(nextDefaults?.defaultChatModelId ?? "");
              setEmbeddingModelId(nextDefaults?.defaultEmbeddingModelId ?? "");
            }}
            className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none"
          >
            <option value="">Select provider connection</option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Chat model">
          <select
            value={chatModelId}
            onChange={(event) => setChatModelId(event.target.value)}
            className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none"
          >
            <option value="">No chat model</option>
            {chatModels.map((model) => (
              <option key={model.id} value={model.id}>
                {formatProviderModelLabel(model, connectionById[model.connectionId])}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Embedding model">
          <select
            value={embeddingModelId}
            onChange={(event) => setEmbeddingModelId(event.target.value)}
            className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none"
          >
            <option value="">No embedding model</option>
            {embeddingModels.map((model) => (
              <option key={model.id} value={model.id}>
                {formatProviderModelLabel(model, connectionById[model.connectionId])}
              </option>
            ))}
          </select>
        </Field>
        <ModelSelectionHint
          preferredConnection={preferredConnection}
          selectedChatModel={selectedChatModel}
          selectedEmbeddingModel={selectedEmbeddingModel}
          connectionById={connectionById}
        />
        {preferredConnectionId && embeddingModels.length === 0 ? (
          <div className="rounded-3xl border border-coral/25 bg-coral/10 p-4 text-sm text-[#ffd1ca]">
            This provider connection does not currently expose any embedding-capable models.
          </div>
        ) : null}
        {preferredConnectionId && chatModels.length === 0 ? (
          <div className="rounded-3xl border border-coral/25 bg-coral/10 p-4 text-sm text-[#ffd1ca]">
            This provider connection does not currently expose any chat-capable models.
          </div>
        ) : null}
        {embeddingChanged ? (
          <div className="rounded-3xl border border-amber-300/20 bg-amber-400/10 p-4 text-sm text-amber-100">
            Changing the embedding model requires a regenerate before this channel can be searched again.
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button className="rounded-full border border-white/10 px-4 py-2 text-sm text-mist" onClick={onClose}>
            Close
          </button>
          <button
            className="rounded-full bg-ember px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40"
            disabled={!preferredConnectionId || !chatModelId || !embeddingModelId || chatModels.length === 0 || embeddingModels.length === 0}
            onClick={() => void onSave(preferredConnectionId || null, chatModelId || null, embeddingModelId || null)}
          >
            Save Models
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteChannelToast({
  channelName,
  busy,
  offsetForError,
  onClose,
  onDelete
}: {
  channelName: string;
  busy: boolean;
  offsetForError: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`fixed right-5 z-40 w-[min(30rem,calc(100vw-2rem))] ${offsetForError ? "bottom-52" : "bottom-5"}`}>
      <div className="rounded-[28px] border border-coral/30 bg-[#22131a] px-5 py-4 text-sm text-[#ffe4dc] shadow-panel backdrop-blur-md">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#ffb9ab]">Delete channel?</div>
            <div className="mt-2 break-anywhere text-base font-medium text-paper">{channelName}</div>
          </div>
          <button
            className="shrink-0 rounded-full border border-white/10 px-3 py-1 text-xs text-[#ffd1ca]/80 disabled:opacity-40"
            onClick={onClose}
            disabled={busy}
          >
            Keep channel
          </button>
        </div>
        <div className="break-anywhere text-sm leading-6 text-[#ffd1ca]/85">
          This removes the channel from the app along with its threads and file status history. It does not delete the source folder or the on-disk `.fschat-index` folder.
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="rounded-full border border-coral/50 bg-coral/10 px-4 py-2 text-sm font-medium text-[#ffd1ca] disabled:opacity-40"
            onClick={onDelete}
            disabled={busy}
          >
            {busy ? "Deleting..." : "Delete Channel"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelSelectionHint({
  preferredConnection,
  selectedChatModel,
  selectedEmbeddingModel,
  connectionById
}: {
  preferredConnection: ProviderConnection | null;
  selectedChatModel: ProviderModel | null;
  selectedEmbeddingModel: ProviderModel | null;
  connectionById: Record<string, ProviderConnection>;
}) {
  if (!preferredConnection) {
    return (
      <div className="rounded-3xl border border-white/10 bg-white/5 p-4 text-sm text-mist/75">
        Pick a provider connection to load its saved default chat and embedding models. You can still override either
        model after that.
      </div>
    );
  }

  const crossProviderOverride =
    Boolean(selectedChatModel && selectedChatModel.connectionId !== preferredConnection.id) ||
    Boolean(selectedEmbeddingModel && selectedEmbeddingModel.connectionId !== preferredConnection.id);

  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-4 text-sm text-mist/75">
      <div className="font-medium text-paper">Selection rules</div>
      <div className="mt-2 leading-6">
        Chat and embedding models are validated independently, and both must come from the same provider connection.
        The chat model must support chat, and the embedding model must support embeddings.
      </div>
      {crossProviderOverride ? (
        <div className="mt-2 leading-6 text-amber-100/85">
          These selections are incompatible because they come from different provider connections. Choose both models
          from {preferredConnection.name}.
        </div>
      ) : null}
      <div className="mt-2 text-xs leading-6 text-mist/65">
        Chat source: {selectedChatModel ? connectionById[selectedChatModel.connectionId]?.name ?? "Unknown" : "Not set"}
      </div>
      <div className="text-xs leading-6 text-mist/65">
        Embedding source:{" "}
        {selectedEmbeddingModel ? connectionById[selectedEmbeddingModel.connectionId]?.name ?? "Unknown" : "Not set"}
      </div>
    </div>
  );
}

function ChatPanel({
  selectedChannel,
  snapshot,
  selectedThread,
  messages,
  composer,
  onComposer,
  onSelectThread,
  onSend,
  busy
}: {
  selectedChannel: Channel | null;
  snapshot: ChannelSnapshot | null;
  selectedThread: Thread | null;
  messages: Message[];
  composer: string;
  onComposer: (value: string) => void;
  onSelectThread: (threadId: string) => void | Promise<void>;
  onSend: () => void | Promise<void>;
  busy: boolean;
}) {
  if (!selectedChannel) {
    return (
      <main className="glass-panel shell-border min-h-0 min-w-0 flex flex-col items-center justify-center rounded-[28px] p-5 text-center shadow-panel">
        <div className="font-display text-5xl text-paper">Teams-style chat for your filesystem</div>
        <div className="mt-4 max-w-2xl text-sm leading-7 text-mist/75">Create a channel from a root folder, index its subdirectories, track gaps in knowledge, and chat against the stored index.</div>
      </main>
    );
  }
  return (
    <main className="glass-panel shell-border min-h-0 min-w-0 flex flex-col rounded-[28px] p-5 shadow-panel">
      <div className="mb-4 flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="break-anywhere font-display text-[clamp(2rem,2vw+1rem,3rem)] leading-tight text-paper">Chat With {selectedChannel.displayName}</div>
          <div className="break-anywhere mt-2 text-sm text-mist/70">
            {selectedChannel.status === "ready"
              ? "Ask questions across the selected folder and its indexed subdirectories."
              : selectedChannel.status === "stale"
                ? "This channel remains searchable, but the latest rebuild was cancelled and the retained index is partial."
                : "Finish indexing before starting retrieval-backed chat."}
          </div>
        </div>
        <div className="flex max-w-full flex-wrap gap-2">
          {snapshot?.threads.map((thread) => (
            <button key={thread.id} className={`rounded-full px-4 py-2 text-sm ${selectedThread?.id === thread.id ? "bg-ember text-ink" : "bg-white/7 text-mist"}`} onClick={() => void onSelectThread(thread.id)}>
              {thread.title}
            </button>
          ))}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 overflow-hidden grid-cols-[minmax(0,1fr)_260px] gap-4">
        <div className="flex min-h-0 min-w-0 flex-col rounded-[26px] bg-black/10 p-4">
          <div className="flex-1 space-y-4 overflow-y-auto pr-2">
            {messages.length === 0 ? (
              <div className="rounded-[22px] border border-dashed border-white/10 p-6 text-sm text-mist/70">Start a thread to query the indexed content in this channel.</div>
            ) : (
              messages.map((message) => (
                <div key={message.id} className={`min-w-0 rounded-[24px] p-4 ${message.role === "assistant" ? "bg-white/7" : "bg-gradient-to-r from-pine/80 to-pine/40"}`}>
                  <div className="mb-2 text-xs uppercase tracking-[0.2em] text-mist/55">{message.role}</div>
                  {message.role === "assistant" ? (
                    <div
                      className="markdown-body break-anywhere text-sm leading-7 text-paper"
                      dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(message.content) }}
                    />
                  ) : (
                    <div className="break-anywhere whitespace-pre-wrap text-sm leading-7 text-paper">{message.content}</div>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="mt-4 rounded-[24px] border border-white/10 bg-white/5 p-3">
            <textarea value={composer} onChange={(event) => onComposer(event.target.value)} placeholder="Ask about any indexed file in this channel..." rows={4} className="w-full resize-none bg-transparent text-sm text-paper outline-none placeholder:text-mist/45" />
            <div className="mt-3 flex justify-end">
              <button className="rounded-full bg-ember px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40" onClick={() => void onSend()} disabled={!isChatReady(selectedChannel.status) || busy}>Send</button>
            </div>
          </div>
        </div>
        <div className="min-h-0 min-w-0 overflow-y-auto rounded-[26px] bg-white/5 p-4">
          <div className="mb-4 text-xs uppercase tracking-[0.3em] text-mist/50">Citations</div>
          <CitationsPanel messages={messages} />
        </div>
      </div>
    </main>
  );
}

function mergeChannels(current: Channel[], channel: Channel) {
  const others = current.filter((item) => item.id !== channel.id);
  return [...others, channel].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function mergeProviderDefaults(current: ProviderDefaults[], nextItem: ProviderDefaults) {
  const others = current.filter((item) => item.connectionId !== nextItem.connectionId);
  return [...others, nextItem].sort((left, right) => left.connectionId.localeCompare(right.connectionId));
}

function mergeSnapshotFileUpdate(
  current: ChannelSnapshot | null,
  event: IndexFileUpdateEvent,
  selectedChannelId: string | null
) {
  if (!current || !selectedChannelId || event.channelId !== selectedChannelId || current.channel.id !== event.channelId) {
    return current;
  }

  const indexedFiles = current.indexedFiles.filter((file) => file.relativePath !== event.file.relativePath);
  const failedFiles = current.failedFiles.filter((file) => file.relativePath !== event.file.relativePath);

  if (event.file.status === "indexed") {
    indexedFiles.push(event.file);
    indexedFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  } else {
    failedFiles.push(event.file);
    failedFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  return {
    ...current,
    indexedFiles,
    failedFiles
  };
}

function filterFiles(files: IndexedFileRecord[], query: string) {
  if (!query.trim()) return files;
  const lower = query.toLowerCase();
  return files.filter((file) => file.relativePath.toLowerCase().includes(lower));
}

function formatModelLabel(model: ProviderModel, connection: ProviderConnection | undefined) {
  return connection ? `${connection.name} · ${model.displayName}` : model.displayName;
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error.";
}

function isChatReady(status: Channel["status"]) {
  return status === "ready" || status === "stale";
}

function formatProviderModelLabel(model: ProviderModel, connection: ProviderConnection | undefined) {
  return connection ? `${connection.name} · ${model.displayName}` : model.displayName;
}

function pickInitialConnectionId(
  connections: ProviderConnection[],
  providerDefaultsByConnectionId: Record<string, ProviderDefaults>
) {
  const withBothDefaults = connections.find((connection) => {
    const defaults = providerDefaultsByConnectionId[connection.id];
    return Boolean(defaults?.defaultChatModelId && defaults?.defaultEmbeddingModelId);
  });
  return withBothDefaults?.id ?? connections[0]?.id ?? null;
}

function renderMarkdownToHtml(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let orderedItems: string[] = [];
  let codeFence: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushUnorderedList = () => {
    if (listItems.length === 0) {
      return;
    }
    blocks.push(`<ul>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
    listItems = [];
  };

  const flushOrderedList = () => {
    if (orderedItems.length === 0) {
      return;
    }
    blocks.push(`<ol>${orderedItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ol>`);
    orderedItems = [];
  };

  const flushLists = () => {
    flushUnorderedList();
    flushOrderedList();
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      flushParagraph();
      flushLists();
      if (codeFence) {
        blocks.push(`<pre><code>${escapeHtml(codeFence.join("\n"))}</code></pre>`);
        codeFence = null;
      } else {
        codeFence = [];
      }
      continue;
    }

    if (codeFence) {
      codeFence.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushLists();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushLists();
      const level = Math.min(6, heading[1].length);
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.*)$/);
    if (unordered) {
      flushParagraph();
      flushOrderedList();
      listItems.push(unordered[1]);
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      flushUnorderedList();
      orderedItems.push(ordered[1]);
      continue;
    }

    const blockquote = trimmed.match(/^>\s?(.*)$/);
    if (blockquote) {
      flushParagraph();
      flushLists();
      blocks.push(`<blockquote>${renderInlineMarkdown(blockquote[1])}</blockquote>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushLists();
  if (codeFence) {
    blocks.push(`<pre><code>${escapeHtml(codeFence.join("\n"))}</code></pre>`);
  }

  return blocks.join("");
}

function renderInlineMarkdown(text: string) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*]+)\*(?=$|[\s).,!?:;])/g, "$1<em>$2</em>");
  return html;
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
