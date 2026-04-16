import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type {
  Citation,
  Channel,
  ChannelSnapshot,
  IndexFileUpdateEvent,
  IndexProgressEvent,
  IndexedFileRecord,
  Message,
  ProviderConnection,
  ProviderDefaults,
  ProviderModel,
  RetrievalMode,
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

type PendingTurn = {
  channelId: string;
  threadId: string | null;
  userMessage: Message;
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
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressByChannel, setProgressByChannel] = useState<Record<string, IndexProgressEvent>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspection, setInspection] = useState<RootInspection | null>(null);
  const [channelName, setChannelName] = useState("");
  const [pendingPreferredConnectionId, setPendingPreferredConnectionId] = useState<string | null>(null);
  const [pendingRetrievalMode, setPendingRetrievalMode] = useState<RetrievalMode>("vector");
  const [pendingChatModelId, setPendingChatModelId] = useState<string | null>(null);
  const [pendingEmbeddingModelId, setPendingEmbeddingModelId] = useState<string | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [cancelPrompt, setCancelPrompt] = useState<{ channelId: string; channelName: string } | null>(null);
  const [channelModelsOpen, setChannelModelsOpen] = useState(false);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState<{ channelId: string; channelName: string; indexPath: string } | null>(null);
  const [deleteThreadPrompt, setDeleteThreadPrompt] = useState<{ threadId: string; title: string } | null>(null);
  const [citationPreview, setCitationPreview] = useState<{ channelId: string; citation: Citation } | null>(null);
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
  const hasChatProviders = chatModels.length > 0;
  const hasVectorProviders = chatModels.length > 0 && embeddingModels.length > 0;
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
  const pendingPreferredConnection = pendingPreferredConnectionId ? connectionById[pendingPreferredConnectionId] ?? null : null;
  const pendingConnectionRequiresVectorless = requiresVectorless(pendingPreferredConnection);

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

  async function refreshChannel(channelId: string, options?: { preferredThreadId?: string | null }) {
    try {
      const nextSnapshot = await window.fsChat.loadChannel(channelId);
      const orderedThreads = orderThreads(nextSnapshot.threads);
      setChannels((current) => mergeChannels(current, nextSnapshot.channel));
      setSnapshot(nextSnapshot);
      setSelectedChannelId(channelId);
      const preferredThreadId = options?.preferredThreadId;
      const threadId =
        preferredThreadId && orderedThreads.some((thread) => thread.id === preferredThreadId)
          ? preferredThreadId
          : selectedThreadId && orderedThreads.some((thread) => thread.id === selectedThreadId)
            ? selectedThreadId
            : orderedThreads[0]?.id ?? null;
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
      const preferredConnection = preferredConnectionId ? connectionById[preferredConnectionId] ?? null : null;
      const nextRetrievalMode = requiresVectorless(preferredConnection)
        ? "vectorless"
        : result.existingChannel?.retrievalMode ?? "vector";
      setPendingRetrievalMode(nextRetrievalMode);
      setPendingChatModelId(result.existingChannel?.chatModelId ?? nextDefaults?.defaultChatModelId ?? null);
      setPendingEmbeddingModelId(
        nextRetrievalMode === "vector"
          ? result.existingChannel?.embeddingModelId ?? nextDefaults?.defaultEmbeddingModelId ?? null
          : null
      );
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
        embeddingModelId: pendingRetrievalMode === "vector" ? pendingEmbeddingModelId : null,
        retrievalMode: pendingRetrievalMode
      });
      setCreateOpen(false);
      setInspection(null);
      setChannelName("");
      setPendingPreferredConnectionId(null);
      setPendingRetrievalMode("vector");
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
      setCitationPreview(null);
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
    const messageText = composer.trim();
    const optimisticUserMessage: Message = {
      id: `pending-user-${Date.now()}`,
      threadId: selectedThreadId ?? "pending-thread",
      role: "user",
      content: messageText,
      citations: [],
      createdAt: new Date().toISOString()
    };

    setBusy(true);
    setError(null);
    setComposer("");
    setPendingTurn({
      channelId: selectedChannel.id,
      threadId: selectedThreadId,
      userMessage: optimisticUserMessage
    });
    try {
      const result = await window.fsChat.sendMessage({
        channelId: selectedChannel.id,
        threadId: selectedThreadId,
        message: messageText
      });
      setSelectedThreadId(result.thread.id);
      setMessages((current) => [...current, result.userMessage, result.assistantMessage]);
      setPendingTurn(null);
      await refreshChannel(selectedChannel.id, { preferredThreadId: result.thread.id });
    } catch (caught) {
      setComposer(messageText);
      setPendingTurn(null);
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
    embeddingModelId: string | null,
    retrievalMode: RetrievalMode
  ) {
    if (!selectedChannel) return;
    setBusy(true);
    try {
      const nextSnapshot = await window.fsChat.updateChannelModels({
        channelId: selectedChannel.id,
        preferredConnectionId,
        chatModelId,
        embeddingModelId,
        retrievalMode
      });
      const orderedThreads = orderThreads(nextSnapshot.threads);
      setChannels((current) => mergeChannels(current, nextSnapshot.channel));
      setSnapshot(nextSnapshot);
      setChannelModelsOpen(false);
      if (selectedThreadId && !orderedThreads.some((thread) => thread.id === selectedThreadId)) {
        setSelectedThreadId(orderedThreads[0]?.id ?? null);
      }
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveChannelSystemPrompt(systemPrompt: string) {
    if (!selectedChannel) return;
    setBusy(true);
    try {
      const nextSnapshot = await window.fsChat.updateChannelSystemPrompt({
        channelId: selectedChannel.id,
        systemPrompt
      });
      setChannels((current) => mergeChannels(current, nextSnapshot.channel));
      setSnapshot(nextSnapshot);
      setSystemPromptOpen(false);
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateThread() {
    if (!selectedChannel) return;
    setBusy(true);
    try {
      const createThread = requireFsChatMethod("createThread");
      const thread = await createThread({ channelId: selectedChannel.id });
      setComposer("");
      await refreshChannel(selectedChannel.id, { preferredThreadId: thread.id });
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRenameThread(threadId: string, title: string) {
    if (!selectedChannel) return;
    setBusy(true);
    try {
      const updateThreadTitle = requireFsChatMethod("updateThreadTitle");
      await updateThreadTitle({ threadId, title });
      await refreshChannel(selectedChannel.id, { preferredThreadId: threadId });
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteThread(threadId: string) {
    if (!selectedChannel) return;
    setBusy(true);
    try {
      const deleteThread = requireFsChatMethod("deleteThread");
      const nextSnapshot = await deleteThread(threadId);
      const orderedThreads = orderThreads(nextSnapshot.threads);
      const nextThreadId =
        selectedThreadId === threadId ? orderedThreads[0]?.id ?? null : selectedThreadId;
      setChannels((current) => mergeChannels(current, nextSnapshot.channel));
      setSnapshot(nextSnapshot);
      setSelectedThreadId(nextThreadId);
      setMessages(nextThreadId ? await window.fsChat.getThreadMessages(nextThreadId) : []);
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function handleRequestDeleteThread(threadId: string) {
    const thread = snapshot?.threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      return;
    }

    const isSelectedThread = selectedThreadId === threadId;
    const hasMessages = !isSelectedThread || messages.length > 0;
    if (hasMessages) {
      setDeleteThreadPrompt({ threadId, title: thread.title });
      return;
    }

    void handleDeleteThread(threadId);
  }

  async function handleDeleteChannel(removeIndex: boolean) {
    if (!deletePrompt) return;
    setBusy(true);
    try {
      await window.fsChat.deleteChannel({ channelId: deletePrompt.channelId, removeIndex });
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
      setPendingTurn(null);
      setComposer("");
      setInspection(null);
      setChannelName("");
      setPendingPreferredConnectionId(null);
      setPendingRetrievalMode("vector");
      setPendingChatModelId(null);
      setPendingEmbeddingModelId(null);
      setProgressByChannel({});
      setCancellingByChannel({});
      setDeletePrompt(null);
      setDeleteThreadPrompt(null);
      setCancelPrompt(null);
      setChannelModelsOpen(false);
      setSystemPromptOpen(false);
      setCreateOpen(false);
      setSettingsOpen(false);
      setError(null);
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenExternalUrl(url: string) {
    try {
      await window.fsChat.openExternalUrl(url);
    } catch (caught) {
      setError(toErrorMessage(caught));
    }
  }

  function handleSelectCitation(citation: Citation) {
    if (!selectedChannel) {
      return;
    }
    setCitationPreview({
      channelId: selectedChannel.id,
      citation
    });
  }

async function handleOpenCitationFile() {
  if (!citationPreview) {
    return;
  }
  try {
      const openChannelFile = requireFsChatMethod("openChannelFile");
      await openChannelFile({
      channelId: citationPreview.channelId,
      relativePath: citationPreview.citation.relativePath
    });
    setCitationPreview(null);
  } catch (caught) {
    setError(toErrorMessage(caught));
  }
}

async function handleRevealCitationFile() {
  if (!citationPreview) {
    return;
  }
  try {
      const revealChannelFile = requireFsChatMethod("revealChannelFile");
      await revealChannelFile({
      channelId: citationPreview.channelId,
      relativePath: citationPreview.citation.relativePath
    });
    setCitationPreview(null);
  } catch (caught) {
    setError(toErrorMessage(caught));
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
          onOpenSystemPrompt={() => setSystemPromptOpen(true)}
          onDelete={() => {
            if (selectedChannel) {
              setDeletePrompt({
                channelId: selectedChannel.id,
                channelName: selectedChannel.displayName,
                indexPath: selectedChannel.indexPath
              });
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
          pendingTurn={pendingTurn}
          composer={composer}
          onComposer={setComposer}
          onSelectThread={handleSelectThread}
          onCreateThread={handleCreateThread}
          onRenameThread={handleRenameThread}
          onDeleteThread={handleRequestDeleteThread}
          onSelectCitation={handleSelectCitation}
          onOpenExternalUrl={handleOpenExternalUrl}
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

      {systemPromptOpen && selectedChannel ? (
        <SystemPromptModal
          channel={selectedChannel}
          busy={busy}
          onClose={() => setSystemPromptOpen(false)}
          onSave={handleSaveChannelSystemPrompt}
        />
      ) : null}

      {deletePrompt ? (
        <DeleteChannelToast
          channelName={deletePrompt.channelName}
          indexPath={deletePrompt.indexPath}
          busy={busy}
          offsetForError={Boolean(error)}
          onClose={() => setDeletePrompt(null)}
          onDeleteChannel={() => void handleDeleteChannel(false)}
          onDeleteChannelAndIndex={() => void handleDeleteChannel(true)}
        />
      ) : null}

      {deleteThreadPrompt ? (
        <DeleteThreadToast
          title={deleteThreadPrompt.title}
          busy={busy}
          offsetForError={Boolean(error)}
          onClose={() => setDeleteThreadPrompt(null)}
          onDelete={() => void handleDeleteThread(deleteThreadPrompt.threadId).finally(() => setDeleteThreadPrompt(null))}
        />
      ) : null}

      {citationPreview ? (
        <CitationPreviewModal
          citation={citationPreview.citation}
          onClose={() => setCitationPreview(null)}
          onOpenFile={() => void handleOpenCitationFile()}
          onRevealFile={() => void handleRevealCitationFile()}
        />
      ) : null}

      {createOpen ? (
        <Modal title="Create Channel" onClose={() => setCreateOpen(false)}>
          <div className="space-y-4">
            {!hasChatProviders ? (
              <div className="rounded-3xl border border-amber-300/20 bg-amber-400/10 p-4 text-sm text-amber-100">
                <div className="font-medium">Connected models are required before you can create a channel.</div>
                <div className="mt-1 text-xs text-amber-100/80">
                  Connect at least one provider with a chat-capable model in Settings. Vector channels also need an
                  embedding-capable model.
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
                      const nextConnection = nextConnectionId ? connectionById[nextConnectionId] ?? null : null;
                      setPendingChatModelId(nextDefaults?.defaultChatModelId ?? null);
                      if (requiresVectorless(nextConnection)) {
                        setPendingRetrievalMode("vectorless");
                        setPendingEmbeddingModelId(null);
                      } else {
                        setPendingEmbeddingModelId(nextDefaults?.defaultEmbeddingModelId ?? null);
                      }
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
                <Field label="Retrieval mode">
                  <select
                    value={pendingRetrievalMode}
                    onChange={(event) => {
                      const nextMode = event.target.value as RetrievalMode;
                      if (pendingConnectionRequiresVectorless) {
                        setPendingRetrievalMode("vectorless");
                        setPendingEmbeddingModelId(null);
                        return;
                      }
                      setPendingRetrievalMode(nextMode);
                      if (nextMode !== "vector") {
                        setPendingEmbeddingModelId(null);
                      }
                    }}
                    className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none"
                  >
                    <option value="vector" disabled={pendingConnectionRequiresVectorless}>Vector</option>
                    <option value="vectorless">Vectorless</option>
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
                {pendingRetrievalMode === "vector" ? (
                  <Field label="Embedding model">
                    <select value={pendingEmbeddingModelId ?? ""} onChange={(event) => setPendingEmbeddingModelId(event.target.value || null)} className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none" disabled={pendingConnectionEmbeddingModels.length === 0}>
                      <option value="">Select embedding model</option>
                      {pendingConnectionEmbeddingModels.map((model) => (
                        <option key={model.id} value={model.id}>{formatProviderModelLabel(model, connectionById[model.connectionId])}</option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <div className="rounded-3xl border border-white/10 bg-white/5 p-4 text-sm text-mist/75">
                    {pendingConnectionRequiresVectorless
                      ? "OpenAI Codex is chat-only in this app, so Codex channels use vectorless retrieval. The model picker mirrors Cline's ChatGPT Subscription catalog, and the selected Codex model is sent directly before grounding answers in matching file excerpts."
                      : "Vectorless channels do not need an embedding model. The app will use a manifest-first document pass before grounding answers in matching file excerpts."}
                  </div>
                )}
                {pendingRetrievalMode === "vector" && pendingPreferredConnectionId && pendingConnectionEmbeddingModels.length === 0 ? (
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
                  retrievalMode={pendingRetrievalMode}
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
                  <button className="rounded-full bg-ember px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40" onClick={() => void handleCreateChannel()} disabled={!inspection || !channelName.trim() || !pendingPreferredConnectionId || !pendingChatModelId || pendingConnectionChatModels.length === 0 || !hasChatProviders || (pendingRetrievalMode === "vector" && (!pendingEmbeddingModelId || pendingConnectionEmbeddingModels.length === 0 || !hasVectorProviders))}>Create Channel</button>
                </div>
              </>
            ) : (
              <div className="rounded-3xl border border-dashed border-white/10 p-5 text-sm text-mist/75">
                {hasChatProviders
                  ? "Pick a root folder to inspect existing index data and assign chat and retrieval settings."
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
  onOpenSystemPrompt,
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
  onOpenSystemPrompt: () => void | Promise<void>;
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
          <div className="break-anywhere">Retrieval: {formatRetrievalModeLabel(selectedChannel.retrievalMode)}</div>
          <div className="break-anywhere">
            Chat: {selectedChatModel ? formatProviderModelLabel(selectedChatModel, connectionById[selectedChatModel.connectionId]) : "Not set"}
          </div>
          <div className="break-anywhere">
            Embedding: {selectedChannel.retrievalMode === "vectorless" ? "Not used" : selectedEmbeddingModel ? formatProviderModelLabel(selectedEmbeddingModel, connectionById[selectedEmbeddingModel.connectionId]) : "Not set"}
          </div>
          <div className="break-anywhere">
            Assistant prompt: {selectedChannel.systemPrompt.trim() ? summarizeInlineText(selectedChannel.systemPrompt, 96) : "Default"}
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
          className="rounded-full border border-white/10 px-4 py-2 text-sm text-mist disabled:cursor-not-allowed disabled:opacity-35"
          onClick={() => void onOpenSystemPrompt()}
          disabled={isIndexing || isCancelling}
        >
          Assistant Prompt
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
          Choose whether to keep the files that already finished indexing, or discard this in-progress run and leave the last committed index untouched.
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
    embeddingModelId: string | null,
    retrievalMode: RetrievalMode
  ) => void | Promise<void>;
}) {
  const [preferredConnectionId, setPreferredConnectionId] = useState(channel.preferredConnectionId ?? "");
  const [retrievalMode, setRetrievalMode] = useState<RetrievalMode>(channel.retrievalMode ?? "vector");
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
  const embeddingChanged = retrievalMode === "vector" && (channel.embeddingModelId ?? "") !== embeddingModelId;
  const preferredConnection = preferredConnectionId ? connectionById[preferredConnectionId] ?? null : null;
  const connectionRequiresVectorless = requiresVectorless(preferredConnection);
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
              const nextConnection = nextConnectionId ? connectionById[nextConnectionId] ?? null : null;
              setChatModelId(nextDefaults?.defaultChatModelId ?? "");
              if (requiresVectorless(nextConnection)) {
                setRetrievalMode("vectorless");
                setEmbeddingModelId("");
              } else {
                setEmbeddingModelId(nextDefaults?.defaultEmbeddingModelId ?? "");
              }
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
        <Field label="Retrieval mode">
          <select
            value={retrievalMode}
            onChange={(event) => {
              const nextMode = event.target.value as RetrievalMode;
              if (connectionRequiresVectorless) {
                setRetrievalMode("vectorless");
                setEmbeddingModelId("");
                return;
              }
              setRetrievalMode(nextMode);
              if (nextMode !== "vector") {
                setEmbeddingModelId("");
              }
            }}
            className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none"
          >
            <option value="vector" disabled={connectionRequiresVectorless}>Vector</option>
            <option value="vectorless">Vectorless</option>
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
        {retrievalMode === "vector" ? (
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
        ) : (
          <div className="rounded-3xl border border-white/10 bg-white/5 p-4 text-sm text-mist/75">
            {connectionRequiresVectorless
              ? "OpenAI Codex is chat-only in this app, so Codex channels use vectorless retrieval and do not require an embedding model. The visible Codex model catalog mirrors Cline, and the selected Codex model is sent directly."
              : "Vectorless channels use manifest-first document selection and do not require an embedding model."}
          </div>
        )}
        <ModelSelectionHint
          retrievalMode={retrievalMode}
          preferredConnection={preferredConnection}
          selectedChatModel={selectedChatModel}
          selectedEmbeddingModel={selectedEmbeddingModel}
          connectionById={connectionById}
        />
        {retrievalMode === "vector" && preferredConnectionId && embeddingModels.length === 0 ? (
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
            disabled={!preferredConnectionId || !chatModelId || chatModels.length === 0 || (retrievalMode === "vector" && (!embeddingModelId || embeddingModels.length === 0))}
            onClick={() => void onSave(preferredConnectionId || null, chatModelId || null, retrievalMode === "vector" ? embeddingModelId || null : null, retrievalMode)}
          >
            Save Models
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SystemPromptModal({
  channel,
  busy,
  onClose,
  onSave
}: {
  channel: Channel;
  busy: boolean;
  onClose: () => void;
  onSave: (systemPrompt: string) => void | Promise<void>;
}) {
  const [systemPrompt, setSystemPrompt] = useState(channel.systemPrompt);

  return (
    <Modal title="Assistant Prompt" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-3xl bg-white/5 p-4 text-sm text-mist">
          <div className="font-medium text-paper">{channel.displayName}</div>
          <div className="mt-1 text-xs leading-6 text-mist/75">
            This system prompt is stored per channel and applied to every session in this workspace.
          </div>
        </div>
        <Field label="System prompt">
          <textarea
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows={10}
            className="w-full resize-y rounded-[24px] border border-white/10 bg-black/10 px-4 py-3 text-sm leading-7 text-paper outline-none"
          />
        </Field>
        <div className="rounded-3xl border border-white/10 bg-white/5 p-4 text-sm text-mist/75">
          Keep this focused on response behavior, tone, citation expectations, and channel-specific rules. Retrieval still comes from the indexed files for this channel.
        </div>
        <div className="flex justify-end gap-2">
          <button className="rounded-full border border-white/10 px-4 py-2 text-sm text-mist" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button
            className="rounded-full bg-ember px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40"
            onClick={() => void onSave(systemPrompt)}
            disabled={busy || !systemPrompt.trim()}
          >
            Save Prompt
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteChannelToast({
  channelName,
  indexPath,
  busy,
  offsetForError,
  onClose,
  onDeleteChannel,
  onDeleteChannelAndIndex
}: {
  channelName: string;
  indexPath: string;
  busy: boolean;
  offsetForError: boolean;
  onClose: () => void;
  onDeleteChannel: () => void;
  onDeleteChannelAndIndex: () => void;
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
          This removes the channel from the app along with its threads and file status history. You can keep or remove the on-disk index for this folder.
        </div>
        <div className="mt-3 break-anywhere rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-xs text-mist/75">
          Index path: {indexPath}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="rounded-full border border-coral/50 bg-coral/10 px-4 py-2 text-sm font-medium text-[#ffd1ca] disabled:opacity-40"
            onClick={onDeleteChannel}
            disabled={busy}
          >
            {busy ? "Deleting..." : "Delete Channel Only"}
          </button>
          <button
            className="rounded-full bg-ember px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40"
            onClick={onDeleteChannelAndIndex}
            disabled={busy}
          >
            {busy ? "Deleting..." : "Delete Channel + Index"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteThreadToast({
  title,
  busy,
  offsetForError,
  onClose,
  onDelete
}: {
  title: string;
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
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#ffb9ab]">Delete session?</div>
            <div className="mt-2 break-anywhere text-base font-medium text-paper">{title}</div>
          </div>
          <button
            className="shrink-0 rounded-full border border-white/10 px-3 py-1 text-xs text-[#ffd1ca]/80 disabled:opacity-40"
            onClick={onClose}
            disabled={busy}
          >
            Keep session
          </button>
        </div>
        <div className="break-anywhere text-sm leading-6 text-[#ffd1ca]/85">
          This session already contains messages. Deleting it will remove the conversation history for this tab.
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="rounded-full border border-coral/50 bg-coral/10 px-4 py-2 text-sm font-medium text-[#ffd1ca] disabled:opacity-40"
            onClick={onDelete}
            disabled={busy}
          >
            {busy ? "Deleting..." : "Delete Session"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CitationPreviewModal({
  citation,
  onClose,
  onOpenFile,
  onRevealFile
}: {
  citation: Citation;
  onClose: () => void;
  onOpenFile: () => void;
  onRevealFile: () => void;
}) {
  return (
    <Modal title="Source Preview" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-3xl bg-white/5 p-4 text-sm text-mist">
          <div className="break-anywhere font-medium text-paper">{citation.relativePath}</div>
          <div className="mt-2 text-xs uppercase tracking-[0.18em] text-mist/50">
            Citation score {citation.score.toFixed(3)}
          </div>
        </div>
        <div className="rounded-[24px] border border-white/10 bg-black/10 p-4">
          <div className="mb-3 text-xs uppercase tracking-[0.18em] text-mist/50">Grounding snippet</div>
          <div className="break-anywhere whitespace-pre-wrap text-sm leading-7 text-paper">{citation.snippet}</div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button className="rounded-full border border-white/10 px-4 py-2 text-sm text-mist" onClick={onRevealFile}>
            Reveal In Folder
          </button>
          <button className="rounded-full bg-ember px-4 py-2 text-sm font-semibold text-ink" onClick={onOpenFile}>
            Open File
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ModelSelectionHint({
  retrievalMode,
  preferredConnection,
  selectedChatModel,
  selectedEmbeddingModel,
  connectionById
}: {
  retrievalMode: RetrievalMode;
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
        {retrievalMode === "vector"
          ? "Chat and embedding models are validated independently, and both must come from the same provider connection. The chat model must support chat, and the embedding model must support embeddings."
          : preferredConnection.provider === "openai-codex"
            ? "OpenAI Codex is integrated here as a chat-only provider. Codex channels therefore use vectorless retrieval, and embedding models are not used. The visible Codex model list mirrors Cline's ChatGPT Subscription catalog, and this app sends the selected Codex model directly."
            : "Vectorless channels require a chat-capable model. Embedding models are optional because retrieval happens through manifest-first document selection and lexical grounding."}
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
        {retrievalMode === "vectorless" ? "Not used" : selectedEmbeddingModel ? connectionById[selectedEmbeddingModel.connectionId]?.name ?? "Unknown" : "Not set"}
      </div>
    </div>
  );
}

function ChatPanel({
  selectedChannel,
  snapshot,
  selectedThread,
  messages,
  pendingTurn,
  composer,
  onComposer,
  onSelectThread,
  onCreateThread,
  onRenameThread,
  onDeleteThread,
  onSelectCitation,
  onOpenExternalUrl,
  onSend,
  busy
}: {
  selectedChannel: Channel | null;
  snapshot: ChannelSnapshot | null;
  selectedThread: Thread | null;
  messages: Message[];
  pendingTurn: PendingTurn | null;
  composer: string;
  onComposer: (value: string) => void;
  onSelectThread: (threadId: string) => void | Promise<void>;
  onCreateThread: () => void | Promise<void>;
  onRenameThread: (threadId: string, title: string) => void | Promise<void>;
  onDeleteThread: (threadId: string) => void | Promise<void>;
  onSelectCitation: (citation: Citation) => void | Promise<void>;
  onOpenExternalUrl: (url: string) => void | Promise<void>;
  onSend: () => void | Promise<void>;
  busy: boolean;
}) {
  const orderedThreads = useMemo(() => orderThreads(snapshot?.threads ?? []), [snapshot?.threads]);
  const pinnedThreadId = orderedThreads[0]?.id ?? null;
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [threadTitleDraft, setThreadTitleDraft] = useState("");
  const messagesViewportRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const activePendingTurn =
    pendingTurn &&
    pendingTurn.channelId === selectedChannel?.id &&
    (pendingTurn.threadId ? pendingTurn.threadId === selectedThread?.id : !selectedThread)
      ? pendingTurn
      : null;
  const shouldShowPendingTurn = Boolean(activePendingTurn);
  const visibleMessages = activePendingTurn ? [...messages, activePendingTurn.userMessage] : messages;

  useEffect(() => {
    const updateOverflow = () => {
      const element = tabListRef.current;
      if (!element) {
        setCanScrollLeft(false);
        setCanScrollRight(false);
        return;
      }
      setCanScrollLeft(element.scrollLeft > 8);
      setCanScrollRight(element.scrollLeft + element.clientWidth < element.scrollWidth - 8);
    };

    updateOverflow();
    const element = tabListRef.current;
    if (!element) {
      return;
    }

    element.addEventListener("scroll", updateOverflow);
    window.addEventListener("resize", updateOverflow);
    return () => {
      element.removeEventListener("scroll", updateOverflow);
      window.removeEventListener("resize", updateOverflow);
    };
  }, [orderedThreads.length]);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [selectedThread?.id]);

  useEffect(() => {
    if (renamingThreadId && !orderedThreads.some((thread) => thread.id === renamingThreadId)) {
      setRenamingThreadId(null);
      setThreadTitleDraft("");
    }
  }, [orderedThreads, renamingThreadId]);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }

    const scrollToLatest = () => {
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: "smooth"
      });
      messagesEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    };

    window.requestAnimationFrame(scrollToLatest);
  }, [visibleMessages.length, shouldShowPendingTurn, selectedThread?.id]);

  if (!selectedChannel) {
    return (
      <main className="glass-panel shell-border min-h-0 min-w-0 flex flex-col items-center justify-center rounded-[28px] p-5 text-center shadow-panel">
        <div className="font-display text-5xl text-paper">Chat with your filesystem</div>
        <div className="mt-4 max-w-2xl text-sm leading-7 text-mist/75">Create a channel from a root folder, index its subdirectories, track gaps in knowledge, and chat against the stored index.</div>
      </main>
    );
  }

  function startRenaming(thread: Thread) {
    setRenamingThreadId(thread.id);
    setThreadTitleDraft(thread.title);
  }

  function cancelRenaming() {
    setRenamingThreadId(null);
    setThreadTitleDraft("");
  }

  async function commitRename(thread: Thread) {
    const nextTitle = threadTitleDraft.trim();
    if (!nextTitle || nextTitle === thread.title) {
      cancelRenaming();
      return;
    }
    await onRenameThread(thread.id, nextTitle);
    cancelRenaming();
  }

  function scrollTabs(direction: "left" | "right") {
    tabListRef.current?.scrollBy({
      left: direction === "left" ? -260 : 260,
      behavior: "smooth"
    });
  }

  return (
    <main className="glass-panel shell-border min-h-0 min-w-0 flex flex-col rounded-[28px] p-5 shadow-panel">
      <div className="mb-4 min-w-0">
        <div className="min-w-0">
          <div className="break-anywhere font-display text-[clamp(2rem,2vw+1rem,3rem)] leading-tight text-paper">Chat With {selectedChannel.displayName}</div>
          <div className="break-anywhere mt-2 text-sm text-mist/70">
            {selectedChannel.status === "ready"
              ? selectedChannel.retrievalMode === "vectorless"
                ? "Ask questions across the selected folder. Vectorless chat first selects relevant documents from the local manifest, then grounds the answer in matching file excerpts."
                : "Ask questions across the selected folder and its indexed subdirectories."
              : selectedChannel.status === "stale"
                ? "This channel remains searchable, but the latest rebuild was cancelled and the retained index is partial."
                : "Finish indexing before starting retrieval-backed chat."}
          </div>
        </div>
        <div className="mt-4 rounded-[24px] border border-white/10 bg-black/10 p-3">
          <div className="mb-2 flex items-center justify-between gap-1">
          </div>
          <div className="flex items-center gap-2 overflow-hidden">
            <button
              className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-paper disabled:opacity-40"
              onClick={() => void onCreateThread()}
              disabled={busy}
              title="Add a new chat tab"
            >
              +
            </button>
          <button
            className="shrink-0 rounded-full border border-white/10 px-3 py-2 text-xs text-mist disabled:opacity-25"
            onClick={() => scrollTabs("left")}
            disabled={!canScrollLeft}
            title="Scroll sessions left"
          >
            &lt;
          </button>
          <div ref={tabListRef} className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex min-w-max gap-2 pr-1">
              {orderedThreads.map((thread) => {
                const isPinned = thread.id === pinnedThreadId;
                const isSelected = selectedThread?.id === thread.id;
                const isRenaming = renamingThreadId === thread.id;

                return (
                  <div
                    key={thread.id}
                    ref={isSelected ? activeTabRef : null}
                    className={`group flex shrink-0 items-center gap-2 rounded-[18px] border px-3 py-2 transition ${
                      isSelected
                        ? "border-ember/60 bg-ember text-ink shadow-[0_0_0_1px_rgba(255,140,37,0.2)]"
                        : isPinned
                          ? "border-moss/35 bg-moss/10 text-paper"
                          : "border-white/10 bg-white/7 text-mist hover:bg-white/10"
                    }`}
                  >
                    {isPinned ? (
                      <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${isSelected ? "bg-black/15 text-ink" : "bg-moss/20 text-moss"}`}>
                        Default
                      </span>
                    ) : null}
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={threadTitleDraft}
                        onChange={(event) => setThreadTitleDraft(event.target.value)}
                        onBlur={() => void commitRename(thread)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void commitRename(thread);
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            cancelRenaming();
                          }
                        }}
                        className={`w-[12rem] min-w-0 rounded-full border px-3 py-1.5 text-sm outline-none ${isSelected ? "border-black/15 bg-white/85 text-ink" : "border-white/10 bg-black/10 text-paper"}`}
                      />
                    ) : (
                      <button
                        className={`min-w-0 text-left text-sm ${isSelected ? "text-ink" : "text-inherit"}`}
                        onClick={() => void onSelectThread(thread.id)}
                        onDoubleClick={() => startRenaming(thread)}
                        title={thread.title}
                      >
                        <span className="block max-w-[14rem] truncate">{thread.title}</span>
                      </button>
                    )}
                    {!isPinned && !isRenaming && isSelected ? (
                      <button
                        className={`shrink-0 rounded-full border px-2 py-1 text-[11px] transition ${
                          isSelected ? "border-black/15 bg-black/10 text-ink" : "border-white/10 bg-black/10 text-mist/80 hover:text-paper"
                        }`}
                        onClick={() => void onDeleteThread(thread.id)}
                        disabled={busy}
                        title="Close tab"
                      >
                        x
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          <button
            className="shrink-0 rounded-full border border-white/10 px-3 py-2 text-xs text-mist disabled:opacity-25"
            onClick={() => scrollTabs("right")}
            disabled={!canScrollRight}
            title="Scroll sessions right"
          >
            &gt;
          </button>
          </div>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 overflow-hidden grid-cols-[minmax(0,1fr)_260px] gap-4">
        <div className="flex min-h-0 min-w-0 flex-col rounded-[26px] bg-black/10 p-4">
          <div ref={messagesViewportRef} className="flex-1 space-y-4 overflow-y-auto pr-2">
            {visibleMessages.length === 0 && !shouldShowPendingTurn ? (
              <div className="rounded-[22px] border border-dashed border-white/10 p-6 text-sm text-mist/70">Start a thread to query the indexed content in this channel.</div>
            ) : (
              visibleMessages.map((message) => (
                <div key={message.id} className={`min-w-0 rounded-[24px] p-4 ${message.role === "assistant" ? "bg-white/7" : "bg-gradient-to-r from-pine/80 to-pine/40"}`}>
                  <div className="mb-2 text-xs uppercase tracking-[0.2em] text-mist/55">{message.role}</div>
                  {message.role === "assistant" ? (
                    <div
                      className="markdown-body break-anywhere text-sm leading-7 text-paper"
                      onClick={(event) => void handleAssistantContentClick(event, onOpenExternalUrl)}
                      dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(message.content) }}
                    />
                  ) : (
                    <div className="break-anywhere whitespace-pre-wrap text-sm leading-7 text-paper">{message.content}</div>
                  )}
                </div>
              ))
            )}
            {shouldShowPendingTurn ? <ThinkingBubble /> : null}
            <div ref={messagesEndRef} />
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
          <CitationsPanel messages={messages} onSelectCitation={onSelectCitation} />
        </div>
      </div>
    </main>
  );
}

function mergeChannels(current: Channel[], channel: Channel) {
  const others = current.filter((item) => item.id !== channel.id);
  return [...others, channel].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function orderThreads(threads: Thread[]) {
  if (threads.length <= 1) {
    return threads;
  }

  const defaultThread = [...threads].sort((left, right) => {
    const createdComparison = left.createdAt.localeCompare(right.createdAt);
    if (createdComparison !== 0) {
      return createdComparison;
    }
    return left.title.localeCompare(right.title);
  })[0];

  const rest = threads
    .filter((thread) => thread.id !== defaultThread.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return [defaultThread, ...rest];
}

function ThinkingBubble() {
  return (
    <div className="min-w-0 rounded-[24px] bg-white/7 p-4">
      <div className="mb-2 text-xs uppercase tracking-[0.2em] text-mist/55">assistant</div>
      <div className="flex items-center gap-2 text-sm text-paper">
        <span>Thinking</span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 animate-pulse rounded-full bg-ember [animation-delay:0ms]" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-ember/80 [animation-delay:150ms]" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-ember/60 [animation-delay:300ms]" />
        </span>
      </div>
    </div>
  );
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

function formatRetrievalModeLabel(retrievalMode: RetrievalMode) {
  return retrievalMode === "vectorless" ? "Vectorless manifest-first" : "Vector";
}

function summarizeInlineText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error.";
}

function requireFsChatMethod<T extends keyof Window["fsChat"]>(methodName: T): Window["fsChat"][T] {
  const candidate = window.fsChat?.[methodName];
  if (typeof candidate !== "function") {
    throw new Error(
      `The desktop app is running an older bridge that does not support "${String(methodName)}". Restart the Electron app and try again.`
    );
  }
  return candidate;
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
  const withChatDefault = connections.find((connection) => {
    const defaults = providerDefaultsByConnectionId[connection.id];
    return Boolean(defaults?.defaultChatModelId);
  });
  return withBothDefaults?.id ?? withChatDefault?.id ?? connections[0]?.id ?? null;
}

function requiresVectorless(connection: ProviderConnection | null | undefined) {
  return connection?.provider === "openai-codex";
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
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" data-external-link="true" rel="noopener noreferrer nofollow">$1</a>'
  );
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

async function handleAssistantContentClick(
  event: ReactMouseEvent<HTMLDivElement>,
  onOpenExternalUrl: (url: string) => void | Promise<void>
) {
  const anchor = findExternalLink(event.target);
  if (!anchor) {
    return;
  }

  event.preventDefault();
  const href = anchor.getAttribute("href");
  if (!href) {
    return;
  }

  await onOpenExternalUrl(href);
}

function findExternalLink(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  return target.closest("a[data-external-link='true']") as HTMLAnchorElement | null;
}
