import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import type { WebContents } from "electron";
import { INDEX_DIR_NAME } from "@fschat/shared";
import type {
  BootstrapResponse,
  CancelIndexInput,
  Channel,
  ChannelStatus,
  ChannelSnapshot,
  CreateThreadInput,
  ConnectProviderInput,
  ConnectProviderResult,
  DeleteChannelInput,
  IndexedDocumentRecord,
  IndexFileUpdateEvent,
  IndexProgressEvent,
  IndexedFileRecord,
  Message,
  OpenChannelFileInput,
  ProviderConnection,
  ProviderDefaults,
  ProviderModel,
  RetrievalMode,
  RefreshProviderModelsResult,
  RegisterChannelInput,
  SearchResult,
  SendMessageInput,
  SendMessageResult,
  Thread,
  UpdateChannelSystemPromptInput,
  UpdateThreadTitleInput,
  UpdateChannelModelsInput,
  WorkerBuildResponse,
  WorkerBuildOptions
} from "@fschat/shared";
import { AppDatabase } from "../db/database";
import {
  defaultBaseUrl,
  discoverProviderModels,
  generateAssistantReply,
  pickDefaultChatModel,
  pickDefaultEmbeddingModel,
  selectRelevantDocuments
} from "../providers/client";
import { clearCodexCredentials, ensureCodexAuthorized } from "../providers/codex-client";
import { PythonWorkerBridge } from "./python-worker";

const SECRET_SERVICE = "filesystem-rag-chat";
const INDEX_TEMP_DIR_NAME = ".fschat-index.tmp";
const require = createRequire(import.meta.url);
const { app, dialog, shell } = require("electron") as typeof import("electron");
const keytar = require("keytar") as typeof import("keytar");
const IGNORED_STDERR_PATTERNS = [
  "Conditional Formatting extension is not supported and will be removed",
  "openpyxl\\worksheet\\_reader.py:329: UserWarning"
];
const DEFAULT_CHANNEL_SYSTEM_PROMPT = [
  "You are Filesystem RAG Chat.",
  "Answer using the indexed filesystem context when possible.",
  "If the indexed context is insufficient, say what is missing.",
  "Mention the source file paths inline when making claims."
].join(" ");

export class DesktopAppService {
  private db: AppDatabase;
  private worker: PythonWorkerBridge;
  private webContents: WebContents | null = null;

  constructor() {
    const dbPath = join(app.getPath("userData"), "fschat.sqlite");
    this.db = new AppDatabase(dbPath);
    this.worker = new PythonWorkerBridge();
    this.worker.on("progress", (event: IndexProgressEvent) => {
      this.webContents?.send("fschat:index-progress", event);
    });
    this.worker.on("file_update", (event: IndexFileUpdateEvent) => {
      this.webContents?.send("fschat:index-file-update", event);
    });
    this.worker.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : "Python worker failed.";
      this.webContents?.send("fschat:index-progress", {
        channelId: "global",
        phase: "error",
        totalFiles: 0,
        processedFiles: 0,
        successCount: 0,
        failureCount: 0,
        message
      } as IndexProgressEvent);
    });
    this.worker.on("stderr", (line: string) => {
      if (IGNORED_STDERR_PATTERNS.some((pattern) => line.includes(pattern))) {
        return;
      }
      this.webContents?.send("fschat:index-progress", {
        channelId: "global",
        phase: "error",
        totalFiles: 0,
        processedFiles: 0,
        successCount: 0,
        failureCount: 0,
        message: line
      } as IndexProgressEvent);
    });
  }

  attachWebContents(webContents: WebContents) {
    this.webContents = webContents;
  }

  async bootstrap(): Promise<BootstrapResponse> {
    for (const channel of this.db.listChannels()) {
      await this.ensureChannelSystemPrompt(channel);
      if (channel.status === "indexing" && !this.worker.hasActiveBuild(channel.id)) {
        this.db.updateChannel(channel.id, {
          status: "idle",
          updatedAt: new Date().toISOString()
        });
      }
      try {
        await this.reconcileChannelIndexState(this.db.getChannel(channel.id) ?? channel);
      } catch (error) {
        if (isMissingProviderConfigurationError(error)) {
          await this.invalidateMissingChannelModels(this.db.getChannel(channel.id) ?? channel);
          continue;
        }
        throw error;
      }
    }

    return {
      channels: this.db.listChannels(),
      providerConnections: this.db.listProviderConnections(),
      providerDefaults: this.db.listProviderDefaults(),
      providerModels: this.db.listProviderModels(),
    };
  }

  async selectRootFolder() {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"]
    });

    return result.canceled ? null : result.filePaths[0];
  }

  async inspectRootFolder(rootPath: string) {
    const defaultDisplayName = basename(rootPath);
    const indexPath = join(rootPath, INDEX_DIR_NAME);
    const status = await this.worker.getIndexStatus(rootPath);
    const existingChannel = this.db.getChannelByRoot(rootPath);

    return {
      rootPath,
      indexPath,
      defaultDisplayName,
      hasExistingIndex: status.exists,
      existingChannel
    };
  }

  async saveProviderDefaults(connectionId: string, defaultChatModelId: string | null, defaultEmbeddingModelId: string | null) {
    const connection = this.db.getProviderConnection(connectionId);
    if (!connection) {
      throw new Error("Provider connection not found.");
    }

    this.assertProviderDefaultModel(connectionId, defaultChatModelId, "chat");
    this.assertProviderDefaultModel(connectionId, defaultEmbeddingModelId, "embedding");

    const defaults: ProviderDefaults = {
      connectionId,
      defaultChatModelId,
      defaultEmbeddingModelId,
      updatedAt: new Date().toISOString()
    };
    this.db.saveProviderDefaults(defaults);
    return defaults;
  }

  async resetAppData() {
    if (this.db.listChannels().some((channel) => channel.status === "indexing" && this.worker.hasActiveBuild(channel.id))) {
      throw new Error("Cancel active indexing before resetting app data.");
    }

    const credentials = await keytar.findCredentials(SECRET_SERVICE);
    await Promise.all(credentials.map((credential) => keytar.deletePassword(SECRET_SERVICE, credential.account)));
    clearCodexCredentials();
    this.db.resetAllAppData();
  }

  async connectProvider(input: ConnectProviderInput): Promise<ConnectProviderResult> {
    if (!input.apiKey && !["ollama", "openai-codex"].includes(input.provider)) {
      throw new Error("API key is required for this provider.");
    }

    if (input.provider === "openai-codex") {
      await ensureCodexAuthorized();
    }

    const discovery = await discoverProviderModels(input);
    const now = new Date().toISOString();
    const existingConnection =
      input.provider === "ollama" || input.provider === "openai-codex"
        ? this.db
            .listProviderConnections()
            .find(
              (connection) =>
                connection.provider === input.provider &&
                (connection.baseUrl || defaultBaseUrl(input.provider)) === defaultBaseUrl(input.provider)
            ) ?? null
        : null;
    const connectionId = existingConnection?.id ?? randomUUID();
    const secretRef = existingConnection?.secretRef ?? `provider-connection:${connectionId}`;

    if (!["ollama", "openai-codex"].includes(input.provider) && input.apiKey) {
      await keytar.setPassword(SECRET_SERVICE, secretRef, input.apiKey);
    }

    const apiKeyHint =
      ["ollama", "openai-codex"].includes(input.provider) || !input.apiKey
        ? undefined
        : `${input.apiKey.slice(0, 4)}...${input.apiKey.slice(-4)}`;

    const baseName =
      input.connectionName?.trim() ||
      (input.provider === "ollama"
        ? "Ollama Local"
        : input.provider === "openai-codex"
          ? "OpenAI Codex"
          : `${labelForProvider(input.provider)}${apiKeyHint ? ` ${apiKeyHint}` : ""}`);

    const connection: ProviderConnection = {
      id: connectionId,
      name: existingConnection?.name ?? this.db.getUniqueConnectionName(baseName),
      provider: input.provider,
      baseUrl: defaultBaseUrl(input.provider),
      apiVersion: input.provider === "azure-openai" ? "2024-10-21" : undefined,
      apiKeyHint,
      secretRef,
      createdAt: existingConnection?.createdAt ?? now,
      updatedAt: now
    };

    this.db.saveProviderConnection(connection);

    const models: ProviderModel[] = discovery.models.map((model) => ({
      ...model,
      id: `${connection.id}:${model.modelId}`,
      connectionId: connection.id,
      createdAt: now,
      updatedAt: now
    }));
    this.db.replaceProviderModels(connection.id, models);

    const defaultChat = pickDefaultChatModel(discovery.models);
    const defaultEmbedding = pickDefaultEmbeddingModel(discovery.models);
    this.db.saveProviderDefaults({
      connectionId: connection.id,
      defaultChatModelId: defaultChat ? `${connection.id}:${defaultChat.modelId}` : null,
      defaultEmbeddingModelId: defaultEmbedding ? `${connection.id}:${defaultEmbedding.modelId}` : null,
      updatedAt: now
    });

    return {
      connection,
      models,
      warnings: discovery.warnings
    };
  }

  async refreshProviderModels(connectionId: string): Promise<RefreshProviderModelsResult> {
    const connection = this.db.getProviderConnection(connectionId);
    if (!connection) {
      throw new Error("Provider connection not found.");
    }

    const secret = await this.getProviderSecret(connection);
    const discovery = await discoverProviderModels({
      provider: connection.provider,
      apiKey: connection.provider === "ollama" ? undefined : secret.apiKey,
      connectionName: connection.name
    });
    const now = new Date().toISOString();
    const models: ProviderModel[] = discovery.models.map((model) => ({
      ...model,
      id: `${connection.id}:${model.modelId}`,
      connectionId: connection.id,
      createdAt: now,
      updatedAt: now
    }));
    this.db.replaceProviderModels(connection.id, models);

    const defaults = this.db.getProviderDefaults(connection.id);
    const preferredChat = pickDefaultChatModel(discovery.models);
    const preferredEmbedding = pickDefaultEmbeddingModel(discovery.models);
    const nextChatDefault =
      defaults?.defaultChatModelId && models.some((model) => model.id === defaults.defaultChatModelId)
        ? defaults.defaultChatModelId
        : preferredChat
          ? `${connection.id}:${preferredChat.modelId}`
          : null;
    const nextEmbeddingDefault =
      defaults?.defaultEmbeddingModelId && models.some((model) => model.id === defaults.defaultEmbeddingModelId)
        ? defaults.defaultEmbeddingModelId
        : preferredEmbedding
          ? `${connection.id}:${preferredEmbedding.modelId}`
          : null;

    this.db.saveProviderDefaults({
      connectionId: connection.id,
      defaultChatModelId: nextChatDefault,
      defaultEmbeddingModelId: nextEmbeddingDefault,
      updatedAt: now
    });

    return {
      connection: {
        ...connection,
        updatedAt: now
      },
      models,
      warnings: discovery.warnings
    };
  }

  async registerChannel(input: RegisterChannelInput): Promise<ChannelSnapshot> {
    const existing = this.db.getChannelByRoot(input.rootPath);
    const retrievalMode = this.resolveRetrievalMode(input.retrievalMode ?? existing?.retrievalMode ?? "vector");
    const resolvedModels = this.resolveChannelModelSelection(
      input.preferredConnectionId,
      input.chatModelId,
      input.embeddingModelId
    );

    if (existing) {
      const nextModels = this.enforceProviderRetrievalConstraints(
        retrievalMode,
        resolvedModels.preferredConnectionId ?? existing.preferredConnectionId,
        resolvedModels.chatModelId ?? existing.chatModelId,
        resolvedModels.embeddingModelId ?? existing.embeddingModelId
      );
      this.assertValidChannelModelSelection(nextModels.chatModelId, nextModels.embeddingModelId);
      this.db.updateChannel(existing.id, {
        displayName: input.displayName || existing.displayName,
        preferredConnectionId: nextModels.preferredConnectionId,
        chatModelId: nextModels.chatModelId,
        embeddingModelId: nextModels.embeddingModelId,
        retrievalMode: nextModels.retrievalMode,
        systemPrompt: normalizeChannelSystemPrompt(input.systemPrompt, existing.systemPrompt),
        updatedAt: new Date().toISOString()
      });
      return this.loadChannel(existing.id);
    }

    const now = new Date().toISOString();
    const uniqueName = this.db.getUniqueChannelName(input.displayName || basename(input.rootPath));
    const nextModels = this.enforceProviderRetrievalConstraints(
      retrievalMode,
      resolvedModels.preferredConnectionId,
      resolvedModels.chatModelId,
      resolvedModels.embeddingModelId
    );
    const channel: Channel = {
      id: randomUUID(),
      displayName: uniqueName,
      rootPath: input.rootPath,
      indexPath: join(input.rootPath, INDEX_DIR_NAME),
      preferredConnectionId: nextModels.preferredConnectionId,
      chatModelId: nextModels.chatModelId,
      embeddingModelId: nextModels.embeddingModelId,
      retrievalMode: nextModels.retrievalMode,
      systemPrompt: normalizeChannelSystemPrompt(input.systemPrompt),
      lastIndexedAt: null,
      status: "idle",
      createdAt: now,
      updatedAt: now
    };

    this.assertValidChannelModelSelection(channel.chatModelId, channel.embeddingModelId);
    this.db.createChannel(channel);

    const status = await this.worker.getIndexStatus(channel.rootPath);
    if (status.exists && status.manifest) {
      this.db.replaceIndexedFiles(channel.id, status.manifest.files);
      this.db.updateChannel(channel.id, {
        lastIndexedAt: status.manifest.updatedAt,
        status: deriveChannelStatusFromFiles(status.manifest.files),
        updatedAt: new Date().toISOString()
      });
    }

    return this.loadChannel(channel.id);
  }

  async updateChannelModels(input: UpdateChannelModelsInput): Promise<ChannelSnapshot> {
    const channel = this.db.getChannel(input.channelId);
    if (!channel) {
      throw new Error("Channel not found.");
    }
    if (channel.status === "indexing") {
      throw new Error("Cannot change channel models while indexing is in progress.");
    }

    let nextStatus = channel.status;
    let nextLastIndexedAt = channel.lastIndexedAt;
    const retrievalMode = this.resolveRetrievalMode(input.retrievalMode ?? channel.retrievalMode);
    const resolvedModels = this.resolveChannelModelSelection(
      input.preferredConnectionId,
      input.chatModelId,
      input.embeddingModelId
    );
    const nextModels = this.enforceProviderRetrievalConstraints(
      retrievalMode,
      resolvedModels.preferredConnectionId,
      resolvedModels.chatModelId,
      resolvedModels.embeddingModelId
    );
    this.assertValidChannelModelSelection(nextModels.chatModelId, nextModels.embeddingModelId);

    if (nextModels.retrievalMode !== channel.retrievalMode) {
      this.db.replaceIndexedFiles(channel.id, []);
      nextStatus = "idle";
      nextLastIndexedAt = null;
    } else if (
      nextModels.retrievalMode === "vector" &&
      nextModels.embeddingModelId &&
      nextModels.embeddingModelId !== channel.embeddingModelId
    ) {
      const embeddingSelection = await this.resolveModelSelection(nextModels.embeddingModelId);
      const status = await this.worker.getIndexStatus(channel.rootPath);
      const expectedKey = buildEmbeddingModelKey(embeddingSelection.connection, embeddingSelection.model);
      const matchesExistingIndex = status.exists && status.manifest?.embeddingModelKey === expectedKey;

      if (!matchesExistingIndex) {
        this.db.replaceIndexedFiles(channel.id, []);
        nextStatus = "idle";
        nextLastIndexedAt = null;
      } else {
        this.db.replaceIndexedFiles(channel.id, status.manifest?.files ?? []);
        nextStatus = deriveChannelStatusFromFiles(status.manifest?.files ?? []);
        nextLastIndexedAt = status.manifest?.updatedAt ?? channel.lastIndexedAt;
      }
    }

    this.db.updateChannel(channel.id, {
      preferredConnectionId: nextModels.preferredConnectionId,
      chatModelId: nextModels.chatModelId,
      embeddingModelId: nextModels.embeddingModelId,
      retrievalMode: nextModels.retrievalMode,
      status: nextStatus,
      lastIndexedAt: nextLastIndexedAt,
      updatedAt: new Date().toISOString()
    });

    return this.loadChannel(channel.id);
  }

  async updateChannelSystemPrompt(input: UpdateChannelSystemPromptInput): Promise<ChannelSnapshot> {
    const channel = this.db.getChannel(input.channelId);
    if (!channel) {
      throw new Error("Channel not found.");
    }

    this.db.updateChannel(channel.id, {
      systemPrompt: normalizeChannelSystemPrompt(input.systemPrompt, channel.systemPrompt),
      updatedAt: new Date().toISOString()
    });

    return this.loadChannel(channel.id);
  }

  async deleteChannel(input: string | DeleteChannelInput) {
    const channelId = typeof input === "string" ? input : input.channelId;
    const removeIndex = typeof input === "string" ? false : Boolean(input.removeIndex);
    const channel = this.db.getChannel(channelId);
    if (!channel) {
      return;
    }
    if (channel.status === "indexing" && this.worker.hasActiveBuild(channel.id)) {
      throw new Error("Cancel indexing before deleting this channel.");
    }
    if (removeIndex) {
      this.deleteChannelIndexArtifacts(channel.rootPath);
    }
    this.db.deleteChannel(channelId);
  }

  async loadChannel(channelId: string): Promise<ChannelSnapshot> {
    const channel = this.db.getChannel(channelId);
    if (!channel) {
      throw new Error("Channel not found.");
    }
    await this.ensureChannelSystemPrompt(channel);
    if (channel.status === "indexing" && !this.worker.hasActiveBuild(channel.id)) {
      this.db.updateChannel(channel.id, {
        status: "idle",
        updatedAt: new Date().toISOString()
      });
    }
    const currentChannel = this.db.getChannel(channel.id) ?? channel;
    try {
      await this.reconcileChannelIndexState(currentChannel);
    } catch (error) {
      if (isMissingProviderConfigurationError(error)) {
        await this.invalidateMissingChannelModels(currentChannel);
      } else {
        throw error;
      }
    }
    return this.db.getChannelSnapshot(channelId);
  }

  async startIndex(channelId: string) {
    return this.runIndex(channelId, false);
  }

  async regenerateIndex(channelId: string) {
    return this.runIndex(channelId, true);
  }

  async cancelIndex(input: CancelIndexInput) {
    const channel = this.db.getChannel(input.channelId);
    if (!channel) {
      return;
    }
    if (!this.worker.hasActiveBuild(input.channelId)) {
      this.db.updateChannel(input.channelId, {
        status: "idle",
        updatedAt: new Date().toISOString()
      });
      return;
    }
    await this.worker.cancelBuild(input.channelId, input.retainPartial);
  }

  async listChannelFiles(channelId: string, status: "indexed" | "failed") {
    return this.db.listChannelFiles(channelId, status);
  }

  async getThreadMessages(threadId: string) {
    return this.db.listMessages(threadId);
  }

  async createThread(input: CreateThreadInput): Promise<Thread> {
    const channel = this.db.getChannel(input.channelId);
    if (!channel) {
      throw new Error("Channel not found.");
    }

    const now = new Date().toISOString();
    return this.db.createThread({
      id: randomUUID(),
      channelId: channel.id,
      title: resolveThreadTitle(input.title, this.db.listThreads(channel.id).length + 1),
      createdAt: now,
      updatedAt: now
    });
  }

  async openChannelFile(input: OpenChannelFileInput): Promise<void> {
    const filePath = this.resolveChannelFilePath(input);
    const error = await shell.openPath(filePath);
    if (error) {
      throw new Error(error);
    }
  }

  async revealChannelFile(input: OpenChannelFileInput): Promise<void> {
    const filePath = this.resolveChannelFilePath(input);
    shell.showItemInFolder(filePath);
  }

  async updateThreadTitle(input: UpdateThreadTitleInput): Promise<Thread> {
    const thread = this.db.getThread(input.threadId);
    if (!thread) {
      throw new Error("Thread not found.");
    }

    const title = input.title.trim();
    if (!title) {
      throw new Error("Thread title is required.");
    }

    this.db.updateThreadTitle(thread.id, title);
    return this.db.getThread(thread.id) ?? { ...thread, title };
  }

  async deleteThread(threadId: string): Promise<ChannelSnapshot> {
    const thread = this.db.getThread(threadId);
    if (!thread) {
      throw new Error("Thread not found.");
    }

    this.db.deleteThread(threadId);
    return this.loadChannel(thread.channelId);
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const existingChannel = this.db.getChannel(input.channelId);
    let channel: Channel | null = null;
    if (existingChannel) {
      try {
        channel = await this.reconcileChannelIndexState(existingChannel);
      } catch (error) {
        if (isMissingProviderConfigurationError(error)) {
          await this.invalidateMissingChannelModels(existingChannel);
          throw new Error("This channel's saved models were removed. Pick models again before chatting.");
        }
        throw error;
      }
    }
    if (!channel) {
      throw new Error("Channel not found.");
    }

    if (!["ready", "stale"].includes(channel.status)) {
      throw new Error("Channel is not indexed yet.");
    }

    if (!channel.chatModelId) {
      throw new Error("A chat model is required.");
    }

    const chatSelection = await this.resolveModelSelection(channel.chatModelId);
    if (!chatSelection.model.supportsChat) {
      throw new Error("Selected chat model does not support chat.");
    }
    let searchResponse;
    let contextNotes: string[] = [];
    let deterministicAssistantText: string | null = null;

    if (channel.retrievalMode === "vector") {
      if (!channel.embeddingModelId) {
        throw new Error("An embedding model is required for vector channels.");
      }
      const embeddingSelection = await this.resolveModelSelection(channel.embeddingModelId);
      if (!embeddingSelection.model.supportsEmbedding) {
        throw new Error("Selected embedding model does not support embeddings.");
      }
      const queryOptions = this.toWorkerBuildOptions({
        retrievalMode: "vector",
        connection: embeddingSelection.connection,
        model: embeddingSelection.model,
        secret: embeddingSelection.secret
      });
      try {
        searchResponse = await this.worker.search(channel.rootPath, input.message, 6, queryOptions);
      } catch (error) {
        if (isInvalidIndexError(error)) {
          await this.invalidateChannelIndex(channel, "This channel's index is outdated or missing. Regenerate the index before chatting.");
        }
        throw error;
      }
    } else {
      const documentManifest = await this.worker.listDocuments(channel.rootPath);
      const candidateDocuments = preselectManifestDocuments(documentManifest.documents, input.message, 24);
      const queryProfile = analyzeSpreadsheetQuery(input.message);
      let selectedDocumentIds = candidateDocuments.slice(0, 3).map((document) => document.documentId);

      if (candidateDocuments.length > 0) {
        try {
          const selection = await selectRelevantDocuments({
            connection: chatSelection.connection,
            model: chatSelection.model,
            secret: chatSelection.secret,
            documents: candidateDocuments,
            userMessage: input.message,
            maxDocuments: 3
          });
          selectedDocumentIds = resolveSelectedDocumentIds(selection.documentIds, candidateDocuments);
          if (selectedDocumentIds.length === 0) {
            selectedDocumentIds = candidateDocuments.slice(0, 3).map((document) => document.documentId);
          }
        } catch {
          selectedDocumentIds = candidateDocuments.slice(0, 3).map((document) => document.documentId);
        }
      }

      const queryOptions = this.toWorkerBuildOptions({
        retrievalMode: "vectorless",
        documentIds: selectedDocumentIds
      });
      try {
        searchResponse = await this.worker.search(channel.rootPath, input.message, 8, queryOptions);
        if (searchResponse.results.length === 0 && selectedDocumentIds.length > 0) {
          searchResponse = await this.worker.search(
            channel.rootPath,
            input.message,
            8,
            this.toWorkerBuildOptions({ retrievalMode: "vectorless" })
          );
        }
        const selectedDocuments = candidateDocuments.filter((document) => selectedDocumentIds.includes(document.documentId));
        const spreadsheetDocuments = selectedDocuments.filter(isSpreadsheetDocument);
        if (queryProfile.exhaustive && spreadsheetDocuments.length > 0) {
          const spreadsheetStructureSummary = summarizeSpreadsheetStructureQuery(spreadsheetDocuments, input.message, queryProfile);
          if (spreadsheetStructureSummary) {
            contextNotes = [...contextNotes, ...spreadsheetStructureSummary.notes];
            if (queryProfile.wantsCount) {
              deterministicAssistantText = buildSpreadsheetCountAnswer(spreadsheetStructureSummary);
            }
          }
          const spreadsheetDocumentIds = spreadsheetDocuments.map((document) => document.documentId);
          const exhaustiveLimit = spreadsheetDocuments.reduce((sum, document) => sum + Math.max(document.chunks, 0), 0);
          if (exhaustiveLimit > 0) {
            const exhaustiveSearch = await this.worker.search(
              channel.rootPath,
              input.message,
              exhaustiveLimit,
              this.toWorkerBuildOptions({ retrievalMode: "vectorless", documentIds: spreadsheetDocumentIds })
            );
            const spreadsheetSummary = summarizeSpreadsheetSearch(exhaustiveSearch.results, spreadsheetDocuments, queryProfile);
            if (spreadsheetSummary) {
              contextNotes = [...contextNotes, ...spreadsheetSummary.notes];
              searchResponse = {
                results: spreadsheetSummary.sampleResults
              };
            }
          }
        }
      } catch (error) {
        if (isInvalidIndexError(error)) {
          await this.invalidateChannelIndex(channel, "This channel's index is outdated or missing. Regenerate the index before chatting.");
        }
        throw error;
      }
    }

    const now = new Date().toISOString();
    const existingThread = input.threadId ? this.db.listThreads(channel.id).find((candidate) => candidate.id === input.threadId) : null;
    const thread: Thread =
      existingThread ??
      this.db.createThread({
        id: randomUUID(),
        channelId: channel.id,
        title: resolveThreadTitle(input.message.slice(0, 50), this.db.listThreads(channel.id).length + 1),
        createdAt: now,
        updatedAt: now
      });
    const history = this.db.listMessages(thread.id);

    const userMessage: Message = {
      id: randomUUID(),
      threadId: thread.id,
      role: "user",
      content: input.message,
      citations: [],
      createdAt: now
    };
    this.db.createMessage(userMessage);
    if (history.length === 0) {
      this.db.updateThreadTitle(thread.id, input.message.slice(0, 50) || thread.title);
    }

    const assistantText =
      deterministicAssistantText ??
      (await generateAssistantReply({
        connection: chatSelection.connection,
        model: chatSelection.model,
        secret: chatSelection.secret,
        searchResults: searchResponse.results,
        contextNotes,
        history,
        userMessage: input.message,
        systemPrompt: channel.systemPrompt
      }));

    const assistantMessage: Message = {
      id: randomUUID(),
      threadId: thread.id,
      role: "assistant",
      content: assistantText,
      citations: searchResponse.results.map((item) => ({
        relativePath: item.relativePath,
        chunkId: item.chunkId,
        score: item.score,
        snippet: item.snippet
      })),
      createdAt: new Date().toISOString()
    };

    this.db.createMessage(assistantMessage);
    this.db.touchThread(thread.id, assistantMessage.createdAt);

    return {
      thread: {
        ...thread,
        title: history.length === 0 ? input.message.slice(0, 50) || thread.title : thread.title,
        updatedAt: assistantMessage.createdAt
      },
      userMessage,
      assistantMessage
    };
  }

  private async runIndex(channelId: string, rebuild: boolean) {
    const channel = this.db.getChannel(channelId);
    if (!channel) {
      throw new Error("Channel not found.");
    }

    const options =
      channel.retrievalMode === "vector"
        ? await this.buildVectorIndexOptions(channel)
        : this.toWorkerBuildOptions({ retrievalMode: "vectorless" });
    this.db.updateChannel(channel.id, {
      status: "indexing",
      updatedAt: new Date().toISOString()
    });
    this.webContents?.send("fschat:channel-refreshed", this.db.getChannelSnapshot(channel.id));

    try {
      const response = rebuild
        ? await this.worker.rebuildIndex(channel.id, channel.rootPath, options)
        : await this.worker.buildIndex(channel.id, channel.rootPath, options);

      await this.applyIndexResult(channel, response);

      const snapshot = await this.loadChannel(channel.id);
      this.webContents?.send("fschat:channel-refreshed", snapshot);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Indexing failed.";
      this.db.updateChannel(channel.id, {
        status: message.includes("cancelled") ? "idle" : "error",
        updatedAt: new Date().toISOString()
      });
      const snapshot = await this.loadChannel(channel.id);
      this.webContents?.send("fschat:channel-refreshed", snapshot);
      throw error;
    }
  }

  private async applyIndexResult(channel: Channel, response: WorkerBuildResponse) {
    if (response.cancelled) {
      if (response.retainedPartial && response.manifest) {
        this.db.replaceIndexedFiles(channel.id, response.files);
        this.db.updateChannel(channel.id, {
          lastIndexedAt: response.manifest.updatedAt,
          status: deriveCancelledChannelStatus(response.files),
          updatedAt: new Date().toISOString()
        });
        return;
      }

      const existing = await this.worker.getIndexStatus(channel.rootPath);
      if (existing.exists && existing.manifest) {
        this.db.replaceIndexedFiles(channel.id, existing.manifest.files);
        this.db.updateChannel(channel.id, {
          lastIndexedAt: existing.manifest.updatedAt,
          status: deriveChannelStatusFromFiles(existing.manifest.files),
          updatedAt: new Date().toISOString()
        });
        return;
      }

      this.db.replaceIndexedFiles(channel.id, []);
      this.db.updateChannel(channel.id, {
        lastIndexedAt: null,
        status: "idle",
        updatedAt: new Date().toISOString()
      });
      return;
    }

    if (!response.manifest) {
      throw new Error("Index completed without a manifest.");
    }

    this.db.replaceIndexedFiles(channel.id, response.files);
    this.db.updateChannel(channel.id, {
      lastIndexedAt: response.manifest.updatedAt,
      status: deriveChannelStatusFromFiles(response.files),
      updatedAt: new Date().toISOString()
    });
  }

  private async resolveModelSelection(modelId: string) {
    const model = this.db.getProviderModel(modelId);
    if (!model) {
      throw new Error("Provider model not found.");
    }
    const connection = this.db.getProviderConnection(model.connectionId);
    if (!connection) {
      throw new Error("Provider connection not found.");
    }
    const secret = await this.getProviderSecret(connection);
    return { model, connection, secret };
  }

  private async getProviderSecret(connection: ProviderConnection) {
    if (connection.provider === "ollama" || connection.provider === "openai-codex") {
      return { apiKey: "" };
    }

    const apiKey = await keytar.getPassword(SECRET_SERVICE, connection.secretRef);
    if (!apiKey) {
      throw new Error(`Credentials missing for provider connection "${connection.name}".`);
    }
    return { apiKey };
  }

  private toWorkerBuildOptions(args: {
    retrievalMode: RetrievalMode;
    connection?: ProviderConnection;
    model?: ProviderModel;
    secret?: { apiKey: string };
    documentIds?: string[];
  }): WorkerBuildOptions {
    const retrieval = {
      mode: args.retrievalMode,
      engine: args.retrievalMode === "vector" ? "numpy-cosine" : "manifest-first-lexical",
      documentIds: args.documentIds
    };
    if (args.retrievalMode !== "vector") {
      return { retrieval };
    }
    if (!args.connection || !args.model || !args.secret) {
      throw new Error("Vector retrieval requires provider connection, model, and secret.");
    }
    return {
      retrieval,
      embeddingProvider: {
        provider: args.connection.provider,
        baseUrl: args.connection.baseUrl,
        apiVersion: args.connection.apiVersion,
        apiKey: args.secret.apiKey,
        model: args.model.modelId,
        deployment: args.model.deployment
      }
    };
  }

  private async reconcileChannelIndexState(channel: Channel) {
    if (channel.status === "indexing") {
      return channel;
    }

    const status = await this.worker.getIndexStatus(channel.rootPath);
    if (!status.exists || !status.manifest || status.manifest.retrievalMode !== channel.retrievalMode) {
      if (channel.lastIndexedAt || channel.status === "ready" || channel.status === "stale") {
        this.db.replaceIndexedFiles(channel.id, []);
        this.db.updateChannel(channel.id, {
          lastIndexedAt: null,
          status: "idle",
          updatedAt: new Date().toISOString()
        });
      }
      return this.db.getChannel(channel.id);
    }

    if (channel.retrievalMode === "vector") {
      if (!channel.embeddingModelId) {
        return channel;
      }

      const embeddingSelection = await this.resolveModelSelection(channel.embeddingModelId);
      const expectedEmbeddingKey = buildEmbeddingModelKey(embeddingSelection.connection, embeddingSelection.model);
      if (status.manifest.embeddingModelKey !== expectedEmbeddingKey) {
        if (channel.lastIndexedAt || channel.status === "ready" || channel.status === "stale") {
          this.db.replaceIndexedFiles(channel.id, []);
          this.db.updateChannel(channel.id, {
            lastIndexedAt: null,
            status: "idle",
            updatedAt: new Date().toISOString()
          });
        }
        return this.db.getChannel(channel.id);
      }
    }

    if (
      status.exists &&
      status.manifest &&
      status.manifest.retrievalMode === channel.retrievalMode
    ) {
      this.db.replaceIndexedFiles(channel.id, status.manifest.files);
      if (channel.lastIndexedAt !== status.manifest.updatedAt || channel.status === "idle" || channel.status === "error") {
        this.db.updateChannel(channel.id, {
          lastIndexedAt: status.manifest.updatedAt,
          status: deriveChannelStatusFromFiles(status.manifest.files),
          updatedAt: new Date().toISOString()
        });
      }
      return this.db.getChannel(channel.id);
    }

    return this.db.getChannel(channel.id);
  }

  private async invalidateChannelIndex(channel: Channel, message: string) {
    this.db.replaceIndexedFiles(channel.id, []);
    this.db.updateChannel(channel.id, {
      lastIndexedAt: null,
      status: "idle",
      updatedAt: new Date().toISOString()
    });
    const snapshot = await this.loadChannel(channel.id);
    this.webContents?.send("fschat:channel-refreshed", snapshot);
    throw new Error(message);
  }

  private async invalidateMissingChannelModels(channel: Channel) {
    this.db.replaceIndexedFiles(channel.id, []);
    this.db.updateChannel(channel.id, {
      preferredConnectionId: null,
      chatModelId: null,
      embeddingModelId: null,
      lastIndexedAt: null,
      status: "idle",
      updatedAt: new Date().toISOString()
    });
    const refreshed = this.db.getChannel(channel.id);
    if (refreshed) {
      const snapshot = this.db.getChannelSnapshot(channel.id);
      this.webContents?.send("fschat:channel-refreshed", snapshot);
    }
  }

  private deleteChannelIndexArtifacts(rootPath: string) {
    const targets = [join(rootPath, INDEX_DIR_NAME), join(rootPath, INDEX_TEMP_DIR_NAME)];
    for (const target of targets) {
      if (!existsSync(target)) {
        continue;
      }
      rmSync(target, { recursive: true, force: true });
    }
  }

  private resolveChannelModelSelection(
    preferredConnectionId: string | null,
    chatModelId: string | null,
    embeddingModelId: string | null
  ) {
    const defaults = preferredConnectionId ? this.db.getProviderDefaults(preferredConnectionId) : null;
    return {
      preferredConnectionId,
      chatModelId: chatModelId ?? defaults?.defaultChatModelId ?? null,
      embeddingModelId: embeddingModelId ?? defaults?.defaultEmbeddingModelId ?? null
    };
  }

  private resolveRetrievalMode(mode: RetrievalMode): RetrievalMode {
    if (!["vector", "vectorless"].includes(mode)) {
      throw new Error(`Retrieval mode "${mode}" is not supported.`);
    }
    return mode;
  }

  private enforceProviderRetrievalConstraints(
    retrievalMode: RetrievalMode,
    preferredConnectionId: string | null,
    chatModelId: string | null,
    embeddingModelId: string | null
  ) {
    const preferredConnection = preferredConnectionId ? this.db.getProviderConnection(preferredConnectionId) : null;
    const chatModel = chatModelId ? this.db.getProviderModel(chatModelId) : null;
    const chatConnection = chatModel ? this.db.getProviderConnection(chatModel.connectionId) : null;
    const effectiveProvider = preferredConnection?.provider ?? chatConnection?.provider ?? null;

    if (effectiveProvider === "openai-codex") {
      return {
        preferredConnectionId: preferredConnectionId ?? chatConnection?.id ?? null,
        chatModelId,
        embeddingModelId: null,
        retrievalMode: "vectorless" as const
      };
    }

    return {
      preferredConnectionId,
      chatModelId,
      embeddingModelId,
      retrievalMode
    };
  }

  private async buildVectorIndexOptions(channel: Channel) {
    if (!channel.embeddingModelId) {
      throw new Error("An embedding model is required before indexing vector channels.");
    }
    const embeddingSelection = await this.resolveModelSelection(channel.embeddingModelId);
    if (!embeddingSelection.model.supportsEmbedding) {
      throw new Error("Selected model does not support embeddings.");
    }
    return this.toWorkerBuildOptions({
      retrievalMode: "vector",
      connection: embeddingSelection.connection,
      model: embeddingSelection.model,
      secret: embeddingSelection.secret
    });
  }

  private async ensureChannelSystemPrompt(channel: Channel) {
    if (channel.systemPrompt.trim()) {
      return;
    }

    this.db.updateChannel(channel.id, {
      systemPrompt: DEFAULT_CHANNEL_SYSTEM_PROMPT,
      updatedAt: new Date().toISOString()
    });
  }

  private resolveChannelFilePath(input: OpenChannelFileInput) {
    const channel = this.db.getChannel(input.channelId);
    if (!channel) {
      throw new Error("Channel not found.");
    }
    if (typeof input.relativePath !== "string" || !input.relativePath.trim()) {
      throw new Error("A valid relative file path is required.");
    }

    const rootPath = resolve(channel.rootPath);
    const candidatePath = resolve(channel.rootPath, input.relativePath);
    const normalizedRoot = rootPath.toLowerCase();
    const normalizedCandidate = candidatePath.toLowerCase();
    const withinRoot =
      normalizedCandidate === normalizedRoot ||
      normalizedCandidate.startsWith(`${normalizedRoot}\\`) ||
      normalizedCandidate.startsWith(`${normalizedRoot}/`);

    if (!withinRoot) {
      throw new Error("File path must stay within the selected channel root.");
    }
    if (!existsSync(candidatePath)) {
      throw new Error("The cited file no longer exists on disk.");
    }

    return candidatePath;
  }

  private assertProviderDefaultModel(connectionId: string, modelId: string | null, expectedCapability: "chat" | "embedding") {
    if (!modelId) {
      return;
    }
    const model = this.db.getProviderModel(modelId);
    if (!model || model.connectionId !== connectionId) {
      throw new Error(`Selected ${expectedCapability} default must belong to the provider connection being configured.`);
    }
    if (expectedCapability === "chat" && !model.supportsChat) {
      throw new Error("Selected default chat model does not support chat.");
    }
    if (expectedCapability === "embedding" && !model.supportsEmbedding) {
      throw new Error("Selected default embedding model does not support embeddings.");
    }
  }

  private assertValidChannelModelSelection(chatModelId: string | null, embeddingModelId: string | null) {
    let chatModel: ProviderModel | null = null;
    let embeddingModel: ProviderModel | null = null;

    if (chatModelId) {
      chatModel = this.db.getProviderModel(chatModelId);
      if (!chatModel) {
        throw new Error("Selected chat model was not found.");
      }
      if (!chatModel.supportsChat) {
        throw new Error("Selected chat model does not support chat.");
      }
    }

    if (embeddingModelId) {
      embeddingModel = this.db.getProviderModel(embeddingModelId);
      if (!embeddingModel) {
        throw new Error("Selected embedding model was not found.");
      }
      if (!embeddingModel.supportsEmbedding) {
        throw new Error("Selected embedding model does not support embeddings.");
      }
    }

    if (chatModel && embeddingModel && chatModel.connectionId !== embeddingModel.connectionId) {
      throw new Error("Selected chat and embedding models must come from the same provider connection.");
    }
  }
}

function labelForProvider(provider: ConnectProviderInput["provider"]) {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "openai-codex":
      return "OpenAI Codex";
    case "azure-openai":
      return "Azure OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google Gemini";
    case "ollama":
      return "Ollama";
    default:
      return provider;
  }
}

function isInvalidIndexError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("Unsupported index version") || error.message.includes("Index manifest not found");
}

function isMissingProviderConfigurationError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("Provider model not found") ||
    error.message.includes("Provider connection not found") ||
    error.message.includes("Credentials missing for provider connection")
  );
}

function buildEmbeddingModelKey(connection: ProviderConnection, model: ProviderModel) {
  return [connection.provider, connection.baseUrl || "", connection.apiVersion || "", model.deployment || "", model.modelId].join("|");
}

function normalizeChannelSystemPrompt(value?: string | null, fallback = DEFAULT_CHANNEL_SYSTEM_PROMPT) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function resolveThreadTitle(value: string | null | undefined, sessionNumber: number) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : `Session ${sessionNumber}`;
}

function deriveChannelStatusFromFiles(files: IndexedFileRecord[]): Exclude<ChannelStatus, "indexing"> {
  if (files.some((file) => file.status === "indexed")) {
    return "ready";
  }
  if (files.some((file) => file.status === "failed")) {
    return "error";
  }
  return "idle";
}

function deriveCancelledChannelStatus(files: IndexedFileRecord[]): Exclude<ChannelStatus, "indexing"> {
  if (files.some((file) => file.status === "indexed")) {
    return "stale";
  }
  if (files.some((file) => file.status === "failed")) {
    return "error";
  }
  return "idle";
}

function preselectManifestDocuments(documents: IndexedDocumentRecord[], query: string, limit: number) {
  const queryTokens = tokenizeManifestQuery(query);
  return [...documents]
    .sort((left, right) => {
      const leftScore = scoreManifestDocument(left, query, queryTokens);
      const rightScore = scoreManifestDocument(right, query, queryTokens);
      return rightScore - leftScore;
    })
    .slice(0, limit);
}

function resolveSelectedDocumentIds(documentIds: string[], documents: IndexedDocumentRecord[]) {
  const validIds = new Set(documents.map((document) => document.documentId));
  return documentIds.filter((documentId) => validIds.has(documentId));
}

function scoreManifestDocument(document: IndexedDocumentRecord, query: string, queryTokens: string[]) {
  const structureHints =
    document.structure?.kind === "spreadsheet"
      ? [...document.structure.sheetNames, ...document.structure.columnHints]
      : [];
  const haystack = [document.relativePath, document.summary, ...document.sectionHints, ...structureHints].join(" ").toLowerCase();
  const lowerQuery = query.toLowerCase().trim();
  let score = 0;
  if (lowerQuery && haystack.includes(lowerQuery)) {
    score += 5;
  }
  for (const token of new Set(queryTokens)) {
    const count = haystack.split(token).length - 1;
    if (count > 0) {
      score += Math.min(count, 6);
    }
    if (document.relativePath.toLowerCase().includes(token)) {
      score += 1.5;
    }
  }
  return score;
}

function tokenizeManifestQuery(query: string) {
  return query.toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 1) ?? [];
}

function isSpreadsheetDocument(document: IndexedDocumentRecord) {
  return document.structure?.kind === "spreadsheet" || document.parser === "spreadsheet" || document.parser === "spreadsheet-xls";
}

function analyzeSpreadsheetQuery(query: string) {
  const normalized = query.toLowerCase();
  const wantsCount = /\b(count|how many|number of|total)\b/.test(normalized);
  const wantsList = /\b(list|show all|find all|which rows|which entries)\b/.test(normalized);
  const wantsFilter = /\b(rows where|entries where|matching rows|matching entries|filter|filtered)\b/.test(normalized);
  const exhaustive = wantsCount || wantsList;
  return { wantsCount, wantsList, wantsFilter, exhaustive };
}

function summarizeSpreadsheetSearch(
  results: SearchResult[],
  documents: IndexedDocumentRecord[],
  queryProfile: ReturnType<typeof analyzeSpreadsheetQuery>
) {
  const rowResults = results.filter((item) => item.chunkType === "spreadsheet-row");
  if (rowResults.length === 0) {
    return null;
  }

  const sheetNames = [...new Set(rowResults.map((item) => item.sheetName).filter((item): item is string => Boolean(item)))];
  const notes: string[] = [];
  if (queryProfile.wantsCount) {
    notes.push(
      `Exact lexical row scan across ${documents.length} selected spreadsheet document(s) found ${rowResults.length} matching rows.` +
        (sheetNames.length > 0 ? ` Matching sheets: ${sheetNames.slice(0, 6).join(", ")}.` : "")
    );
  } else if (queryProfile.wantsList || queryProfile.wantsFilter) {
    notes.push(
      `Lexical row scan found ${rowResults.length} matching rows across ${documents.length} selected spreadsheet document(s). Showing the most relevant matches below.` +
        (sheetNames.length > 0 ? ` Matching sheets: ${sheetNames.slice(0, 6).join(", ")}.` : "")
    );
  }

  return {
    notes,
    sampleResults: rowResults.slice(0, 24)
  };
}

function summarizeSpreadsheetStructureQuery(
  documents: IndexedDocumentRecord[],
  query: string,
  queryProfile: ReturnType<typeof analyzeSpreadsheetQuery>
) {
  const notes: string[] = [];
  const queryTokens = tokenizeManifestQuery(query);
  const matchedSheets: Array<{ document: IndexedDocumentRecord; name: string; rowCount: number; score: number }> = [];
  const fallbackSheets: Array<{ document: IndexedDocumentRecord; name: string; rowCount: number }> = [];

  for (const document of documents) {
    if (document.structure?.kind !== "spreadsheet") {
      continue;
    }
    for (const sheet of document.structure.sheets ?? []) {
      fallbackSheets.push({ document, name: sheet.name, rowCount: sheet.rowCount });
      const score = scoreSpreadsheetSheet(sheet.name, sheet.headerHints ?? [], queryTokens);
      if (score > 0) {
        matchedSheets.push({ document, name: sheet.name, rowCount: sheet.rowCount, score });
      }
    }
  }

  if (queryProfile.wantsCount) {
    if (matchedSheets.length > 0) {
      matchedSheets.sort((left, right) => right.score - left.score);
      const totalRows = matchedSheets.reduce((sum, sheet) => sum + Math.max(sheet.rowCount, 0), 0);
      const details = matchedSheets.slice(0, 6).map((sheet) => `${sheet.name} (${sheet.rowCount})`).join(", ");
      notes.push(`Spreadsheet structure indicates ${totalRows} indexed data rows in sheets matching the question. ${details}`.trim());
      return {
        notes,
        totalRows,
        matchedByQuestion: true,
        sheetDetails: matchedSheets.map((sheet) => ({
          documentPath: sheet.document.relativePath,
          sheetName: sheet.name,
          rowCount: sheet.rowCount
        }))
      };
    }

    if (fallbackSheets.length > 0) {
      const totalRows = fallbackSheets.reduce((sum, sheet) => sum + Math.max(sheet.rowCount, 0), 0);
      const details = fallbackSheets.slice(0, 6).map((sheet) => `${sheet.name} (${sheet.rowCount})`).join(", ");
      notes.push(`Spreadsheet structure indicates ${totalRows} indexed data rows across the selected spreadsheet sheets. ${details}`.trim());
      return {
        notes,
        totalRows,
        matchedByQuestion: false,
        sheetDetails: fallbackSheets.map((sheet) => ({
          documentPath: sheet.document.relativePath,
          sheetName: sheet.name,
          rowCount: sheet.rowCount
        }))
      };
    }
  }

  return notes.length > 0 ? { notes } : null;
}

function scoreSpreadsheetSheet(sheetName: string, headerHints: string[], queryTokens: string[]) {
  const haystack = [sheetName, ...headerHints].join(" ").toLowerCase();
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const count = haystack.split(token).length - 1;
    if (count > 0) {
      score += Math.min(count, 4);
    }
  }
  return score;
}

function buildSpreadsheetCountAnswer(summary: NonNullable<ReturnType<typeof summarizeSpreadsheetStructureQuery>>) {
  if (typeof summary.totalRows !== "number") {
    return null;
  }

  const leadingSheets = (summary.sheetDetails ?? [])
    .slice(0, 6)
    .map((sheet) => `${sheet.sheetName} (${sheet.rowCount})`)
    .join(", ");

  if (summary.matchedByQuestion) {
    return `Based on the indexed spreadsheet structure, there are ${summary.totalRows} data rows in sheets matching your question.${leadingSheets ? ` Matching sheets: ${leadingSheets}.` : ""}`;
  }

  return `Based on the indexed spreadsheet structure, there are ${summary.totalRows} data rows across the selected spreadsheet sheets.${leadingSheets ? ` Sheets counted: ${leadingSheets}.` : ""}`;
}
