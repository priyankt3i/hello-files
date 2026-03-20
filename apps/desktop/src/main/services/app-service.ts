import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import type { WebContents } from "electron";
import { INDEX_DIR_NAME } from "@fschat/shared";
import type {
  BootstrapResponse,
  CancelIndexInput,
  Channel,
  ChannelStatus,
  ChannelSnapshot,
  ConnectProviderInput,
  ConnectProviderResult,
  IndexFileUpdateEvent,
  IndexProgressEvent,
  IndexedFileRecord,
  Message,
  ProviderConnection,
  ProviderDefaults,
  ProviderModel,
  RefreshProviderModelsResult,
  RegisterChannelInput,
  SendMessageInput,
  SendMessageResult,
  Thread,
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
  pickDefaultEmbeddingModel
} from "../providers/client";
import { PythonWorkerBridge } from "./python-worker";

const SECRET_SERVICE = "filesystem-rag-chat";
const require = createRequire(import.meta.url);
const { app, dialog } = require("electron") as typeof import("electron");
const keytar = require("keytar") as typeof import("keytar");
const IGNORED_STDERR_PATTERNS = [
  "Conditional Formatting extension is not supported and will be removed",
  "openpyxl\\worksheet\\_reader.py:329: UserWarning"
];

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
    this.db.resetAllAppData();
  }

  async connectProvider(input: ConnectProviderInput): Promise<ConnectProviderResult> {
    if (!input.apiKey && input.provider !== "ollama") {
      throw new Error("API key is required for this provider.");
    }

    const discovery = await discoverProviderModels(input);
    const now = new Date().toISOString();
    const existingConnection =
      input.provider === "ollama"
        ? this.db
            .listProviderConnections()
            .find(
              (connection) =>
                connection.provider === "ollama" &&
                (connection.baseUrl || defaultBaseUrl("ollama")) === defaultBaseUrl("ollama")
            ) ?? null
        : null;
    const connectionId = existingConnection?.id ?? randomUUID();
    const secretRef = existingConnection?.secretRef ?? `provider-connection:${connectionId}`;

    if (input.provider !== "ollama" && input.apiKey) {
      await keytar.setPassword(SECRET_SERVICE, secretRef, input.apiKey);
    }

    const apiKeyHint =
      input.provider === "ollama" || !input.apiKey
        ? undefined
        : `${input.apiKey.slice(0, 4)}...${input.apiKey.slice(-4)}`;

    const baseName =
      input.connectionName?.trim() ||
      (input.provider === "ollama" ? "Ollama Local" : `${labelForProvider(input.provider)}${apiKeyHint ? ` ${apiKeyHint}` : ""}`);

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
    const resolvedModels = this.resolveChannelModelSelection(
      input.preferredConnectionId,
      input.chatModelId,
      input.embeddingModelId
    );

    const existing = this.db.getChannelByRoot(input.rootPath);
    if (existing) {
      this.assertValidChannelModelSelection(resolvedModels.chatModelId, resolvedModels.embeddingModelId);
      this.db.updateChannel(existing.id, {
        displayName: input.displayName || existing.displayName,
        preferredConnectionId: resolvedModels.preferredConnectionId ?? existing.preferredConnectionId,
        chatModelId: resolvedModels.chatModelId ?? existing.chatModelId,
        embeddingModelId: resolvedModels.embeddingModelId ?? existing.embeddingModelId,
        updatedAt: new Date().toISOString()
      });
      return this.loadChannel(existing.id);
    }

    const now = new Date().toISOString();
    const uniqueName = this.db.getUniqueChannelName(input.displayName || basename(input.rootPath));
    const channel: Channel = {
      id: randomUUID(),
      displayName: uniqueName,
      rootPath: input.rootPath,
      indexPath: join(input.rootPath, INDEX_DIR_NAME),
      preferredConnectionId: resolvedModels.preferredConnectionId,
      chatModelId: resolvedModels.chatModelId,
      embeddingModelId: resolvedModels.embeddingModelId,
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
    const resolvedModels = this.resolveChannelModelSelection(
      input.preferredConnectionId,
      input.chatModelId,
      input.embeddingModelId
    );
    this.assertValidChannelModelSelection(resolvedModels.chatModelId, resolvedModels.embeddingModelId);

    if (resolvedModels.embeddingModelId && resolvedModels.embeddingModelId !== channel.embeddingModelId) {
      const embeddingSelection = await this.resolveModelSelection(resolvedModels.embeddingModelId);
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
      preferredConnectionId: resolvedModels.preferredConnectionId,
      chatModelId: resolvedModels.chatModelId,
      embeddingModelId: resolvedModels.embeddingModelId,
      status: nextStatus,
      lastIndexedAt: nextLastIndexedAt,
      updatedAt: new Date().toISOString()
    });

    return this.loadChannel(channel.id);
  }

  async deleteChannel(channelId: string) {
    const channel = this.db.getChannel(channelId);
    if (!channel) {
      return;
    }
    if (channel.status === "indexing" && this.worker.hasActiveBuild(channel.id)) {
      throw new Error("Cancel indexing before deleting this channel.");
    }
    this.db.deleteChannel(channelId);
  }

  async loadChannel(channelId: string): Promise<ChannelSnapshot> {
    const channel = this.db.getChannel(channelId);
    if (!channel) {
      throw new Error("Channel not found.");
    }
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

    if (!channel.chatModelId || !channel.embeddingModelId) {
      throw new Error("Both chat and embedding models are required.");
    }

    const chatSelection = await this.resolveModelSelection(channel.chatModelId);
    const embeddingSelection = await this.resolveModelSelection(channel.embeddingModelId);
    if (!chatSelection.model.supportsChat) {
      throw new Error("Selected chat model does not support chat.");
    }
    if (!embeddingSelection.model.supportsEmbedding) {
      throw new Error("Selected embedding model does not support embeddings.");
    }

    const queryOptions = this.toWorkerBuildOptions(embeddingSelection.connection, embeddingSelection.model, embeddingSelection.secret);
    let searchResponse;
    try {
      searchResponse = await this.worker.search(channel.rootPath, input.message, 6, queryOptions);
    } catch (error) {
      if (isInvalidIndexError(error)) {
        await this.invalidateChannelIndex(channel, "This channel's index is outdated or missing. Regenerate the index before chatting.");
      }
      throw error;
    }

    const now = new Date().toISOString();
    const existingThread = input.threadId ? this.db.listThreads(channel.id).find((candidate) => candidate.id === input.threadId) : null;
    const thread: Thread =
      existingThread ??
      this.db.createThread({
        id: randomUUID(),
        channelId: channel.id,
        title: input.message.slice(0, 50) || "New chat",
        createdAt: now,
        updatedAt: now
      });

    const userMessage: Message = {
      id: randomUUID(),
      threadId: thread.id,
      role: "user",
      content: input.message,
      citations: [],
      createdAt: now
    };
    this.db.createMessage(userMessage);

    const history = this.db.listMessages(thread.id);
    const assistantText = await generateAssistantReply({
      connection: chatSelection.connection,
      model: chatSelection.model,
      secret: chatSelection.secret,
      searchResults: searchResponse.results,
      history,
      userMessage: input.message
    });

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

    if (!channel.embeddingModelId) {
      throw new Error("An embedding model is required before indexing.");
    }

    const embeddingSelection = await this.resolveModelSelection(channel.embeddingModelId);
    if (!embeddingSelection.model.supportsEmbedding) {
      throw new Error("Selected model does not support embeddings.");
    }

    const options = this.toWorkerBuildOptions(
      embeddingSelection.connection,
      embeddingSelection.model,
      embeddingSelection.secret
    );
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
    if (connection.provider === "ollama") {
      return { apiKey: "" };
    }

    const apiKey = await keytar.getPassword(SECRET_SERVICE, connection.secretRef);
    if (!apiKey) {
      throw new Error(`Credentials missing for provider connection "${connection.name}".`);
    }
    return { apiKey };
  }

  private toWorkerBuildOptions(
    connection: ProviderConnection,
    model: ProviderModel,
    secret: { apiKey: string }
  ): WorkerBuildOptions {
    return {
      embeddingProvider: {
        provider: connection.provider,
        baseUrl: connection.baseUrl,
        apiVersion: connection.apiVersion,
        apiKey: secret.apiKey,
        model: model.modelId,
        deployment: model.deployment
      }
    };
  }

  private async reconcileChannelIndexState(channel: Channel) {
    if (channel.status === "indexing") {
      return channel;
    }

    if (!channel.embeddingModelId) {
      return channel;
    }

    const embeddingSelection = await this.resolveModelSelection(channel.embeddingModelId);
    const expectedEmbeddingKey = buildEmbeddingModelKey(embeddingSelection.connection, embeddingSelection.model);
    const status = await this.worker.getIndexStatus(channel.rootPath);
    if (status.exists && status.manifest && status.manifest.embeddingModelKey === expectedEmbeddingKey) {
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
