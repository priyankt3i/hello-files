import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import type { WebContents } from "electron";
import { DEFAULT_MAX_FILE_SIZE_MB, INDEX_DIR_NAME } from "@fschat/shared";
import type {
  AppSettings,
  BootstrapResponse,
  CancelIndexInput,
  Channel,
  Citation,
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
  MessageCalculation,
  OpenChannelFileInput,
  ProviderConnection,
  ProviderDefaults,
  ProviderModel,
  ResolvedVisualAsset,
  RetrievalMode,
  RefreshProviderModelsResult,
  RegisterChannelInput,
  SearchResult,
  SendMessageInput,
  SendMessageResult,
  Thread,
  UpdateChannelSettingsInput,
  UpdateChannelSystemPromptInput,
  UpdateThreadTitleInput,
  UpdateChannelModelsInput,
  VisualAssetReference,
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
  requestSpreadsheetSql,
  selectRelevantDocuments
} from "../providers/client";
import { clearCodexCredentials, ensureCodexAuthorized } from "../providers/codex-client";
import { FolderWatcher } from "./folder-watcher";
import { PythonWorkerBridge, type IndexTarget } from "./python-worker";
import {
  DEFAULT_CHANNEL_SYSTEM_PROMPT,
  buildEmbeddingModelKey,
  deriveCancelledChannelStatus,
  deriveChannelStatusFromFiles,
  isInvalidIndexError,
  isMissingProviderConfigurationError,
  labelForProvider,
  normalizeChannelSystemPrompt,
  providerSupportsMultimodalInput,
  resolveThreadTitle
} from "./channel-helpers";
import {
  preselectManifestDocuments,
  resolveSelectedDocumentIds,
  summarizeVisualInventoryNotes,
  isVisualInventoryQuery
} from "./retrieval-helpers";
import {
  analyzeSpreadsheetQuery,
  buildSpreadsheetCountAnswer,
  isSpreadsheetDocument,
  isTabularDocument,
  summarizeSpreadsheetSearch,
  summarizeSpreadsheetStructureQuery
} from "./spreadsheet-helpers";
import {
  buildCalculation,
  buildCalculationCitations,
  buildCalculationNote,
  buildSqlGenerationPrompt,
  parseSqlReply
} from "./spreadsheet-sql";

/** The exact-calculation outcome that sendMessage folds into the answer call and the stored message. */
type ExactCalculation = {
  contextNote: string;
  citations: Citation[];
  calculation: MessageCalculation;
};

/** At most this many spreadsheets are loaded for one calculation. */
const MAX_CALCULATION_DOCUMENTS = 4;

const SECRET_SERVICE = "hello-files";
const LEGACY_SECRET_SERVICES = ["filesystem-rag-chat"];
const SECRET_SERVICES = [SECRET_SERVICE, ...LEGACY_SECRET_SERVICES];
const DB_FILE_NAME = "fschat.sqlite";
const LEGACY_USER_DATA_DIRS = ["Filesystem RAG Chat", "filesystem-rag-chat"];
const INDEX_TEMP_DIR_NAME = ".fschat-index.tmp";
const INDEX_STORAGE_DIR_NAME = "indexes";
const CODEX_ENABLED = process.env.HELLO_FILES_ENABLE_CODEX === "1";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const require = createRequire(import.meta.url);
const { app, dialog, shell } = require("electron") as typeof import("electron");
const keytar = require("keytar") as typeof import("keytar");
const IGNORED_STDERR_PATTERNS = [
  "Conditional Formatting extension is not supported and will be removed",
  "openpyxl\\worksheet\\_reader.py:329: UserWarning"
];

const INDEX_OUTDATED_MESSAGE = "This channel's index is outdated or missing. Regenerate the index before chatting.";

export class DesktopAppService {
  private db: AppDatabase;
  private worker: PythonWorkerBridge;
  private webContents: WebContents | null = null;
  private watcher: FolderWatcher;
  private pendingResync = new Set<string>();
  private startupSyncDone = false;

  constructor() {
    const dbPath = resolveDatabasePath();
    this.db = new AppDatabase(dbPath);
    this.worker = new PythonWorkerBridge();
    this.watcher = new FolderWatcher(
      (channelId) => void this.syncChannel(channelId),
      (channelId, error) => {
        console.warn(`[hello-files] Stopped watching channel ${channelId}: ${error.message}`);
      }
    );
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
    // Worker stderr carries library warnings and tracebacks for diagnostics. Request failures
    // already reach the UI through rejected requests, so stderr is logged rather than shown.
    this.worker.on("stderr", (line: string) => {
      if (IGNORED_STDERR_PATTERNS.some((pattern) => line.includes(pattern))) {
        return;
      }
      console.warn(`[python-worker] ${line.trimEnd()}`);
    });
  }

  attachWebContents(webContents: WebContents) {
    this.webContents = webContents;
  }

  async bootstrap(): Promise<BootstrapResponse> {
    this.migrateLegacyIndexLocations();
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

    this.refreshWatchers();
    if (!this.startupSyncDone) {
      this.startupSyncDone = true;
      // Pick up changes made while the app was closed.
      for (const channel of this.db.listChannels()) {
        if (this.canAutoSync(channel)) {
          void this.syncChannel(channel.id);
        }
      }
    }

    return {
      channels: this.db.listChannels(),
      providerConnections: this.db.listProviderConnections(),
      providerDefaults: this.db.listProviderDefaults(),
      providerModels: this.db.listProviderModels(),
      threads: this.db.listAllThreads(),
      settings: this.db.getAppSettings(),
      features: { codexEnabled: CODEX_ENABLED },
      defaults: { systemPrompt: DEFAULT_CHANNEL_SYSTEM_PROMPT },
      indexStorageDir: indexStorageDir()
    };
  }

  async updateAppSettings(settings: AppSettings): Promise<AppSettings> {
    const next: AppSettings = { dataPolicy: settings.dataPolicy === "local-only" ? "local-only" : "any" };
    this.db.saveAppSettings(next);
    this.refreshWatchers();
    return next;
  }

  async deleteProviderConnection(connectionId: string) {
    const connection = this.db.getProviderConnection(connectionId);
    if (!connection) {
      return;
    }
    const affected = this.db.listChannels().filter((channel) => this.channelUsesConnection(channel, connectionId));
    if (affected.some((channel) => this.worker.hasActiveBuild(channel.id))) {
      throw new Error("Cancel indexing on channels that use this connection before removing it.");
    }
    if (connection.provider === "openai-codex") {
      clearCodexCredentials();
    } else if (connection.provider !== "ollama") {
      await Promise.all(SECRET_SERVICES.map((service) => keytar.deletePassword(service, connection.secretRef)));
    }
    this.db.deleteProviderConnection(connectionId);
    this.refreshWatchers();
  }

  async updateChannelSettings(input: UpdateChannelSettingsInput): Promise<ChannelSnapshot> {
    const channel = this.db.getChannel(input.channelId);
    if (!channel) {
      throw new Error("Channel not found.");
    }
    const displayName = input.displayName?.trim();
    const excludePatterns = input.excludePatterns ? normalizeExcludePatterns(input.excludePatterns) : channel.excludePatterns;
    this.db.updateChannel(channel.id, {
      displayName: displayName && displayName !== channel.displayName ? this.db.getUniqueChannelName(displayName) : channel.displayName,
      autoSync: input.autoSync ?? channel.autoSync,
      excludePatterns,
      updatedAt: new Date().toISOString()
    });
    this.refreshWatchers();
    const excludesChanged = JSON.stringify(excludePatterns) !== JSON.stringify(channel.excludePatterns);
    if (excludesChanged && channel.lastIndexedAt && !this.worker.hasActiveBuild(channel.id)) {
      void this.syncChannel(channel.id, { force: true });
    }
    return this.loadChannel(channel.id);
  }

  async selectRootFolder() {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"]
    });

    return result.canceled ? null : result.filePaths[0];
  }

  async inspectRootFolder(rootPath: string) {
    const defaultDisplayName = basename(rootPath);
    const existingChannel = this.db.getChannelByRoot(rootPath);
    const target: IndexTarget = existingChannel ? channelIndexTarget(existingChannel) : legacyIndexTarget(rootPath);
    const status = await this.worker.getIndexStatus(target);

    return {
      rootPath,
      indexPath: existingChannel?.indexPath ?? indexStorageDir(),
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

    const credentialsByService = await Promise.all(
      SECRET_SERVICES.map(async (service) => ({
        service,
        credentials: await keytar.findCredentials(service)
      }))
    );
    await Promise.all(
      credentialsByService.flatMap(({ service, credentials }) =>
        credentials.map((credential) => keytar.deletePassword(service, credential.account))
      )
    );
    clearCodexCredentials();
    this.watcher.unwatchAll();
    this.pendingResync.clear();
    rmSync(indexStorageDir(), { recursive: true, force: true });
    this.db.resetAllAppData();
  }

  async connectProvider(input: ConnectProviderInput): Promise<ConnectProviderResult> {
    if (input.provider === "openai-codex" && !CODEX_ENABLED) {
      throw new Error("OpenAI Codex sign-in is disabled in this build.");
    }
    if (input.provider === "ollama") {
      input = { ...input, baseUrl: normalizeOllamaUrl(input.baseUrl) };
    }
    if (
      this.db.getAppSettings().dataPolicy === "local-only" &&
      (input.provider !== "ollama" || !isLocalUrl(input.baseUrl ?? ""))
    ) {
      throw new Error(
        "Local-only mode is on. Only Ollama running on this computer can be added. Turn off local-only mode in Settings to add cloud providers or a remote Ollama server."
      );
    }
    if (!input.apiKey && !["ollama", "openai-codex"].includes(input.provider)) {
      throw new Error("API key is required for this provider.");
    }
    if (input.provider === "azure-openai") {
      input = { ...input, baseUrl: normalizeAzureEndpoint(input.baseUrl) };
      if (!input.azureChatDeployment?.trim() && !input.azureEmbeddingDeployment?.trim()) {
        throw new Error("Enter at least one Azure OpenAI deployment name (chat or embedding).");
      }
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
                (connection.baseUrl || defaultBaseUrl(input.provider)) === (input.baseUrl || defaultBaseUrl(input.provider))
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
        ? isLocalUrl(input.baseUrl ?? "")
          ? "Ollama Local"
          : `Ollama ${new URL(input.baseUrl ?? "").host}`
        : input.provider === "openai-codex"
          ? "OpenAI Codex"
          : `${labelForProvider(input.provider)}${apiKeyHint ? ` ${apiKeyHint}` : ""}`);

    const connection: ProviderConnection = {
      id: connectionId,
      name: existingConnection?.name ?? this.db.getUniqueConnectionName(baseName),
      provider: input.provider,
      baseUrl: input.provider === "azure-openai" || input.provider === "ollama" ? input.baseUrl : defaultBaseUrl(input.provider),
      apiVersion: input.provider === "azure-openai" ? input.apiVersion?.trim() || "2024-10-21" : undefined,
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

    if (connection.provider === "azure-openai") {
      return {
        connection,
        models: this.db.listProviderModels(connection.id),
        warnings: ["Azure OpenAI deployments are configured manually. Reconnect Azure to change deployment names."]
      };
    }

    const secret = await this.getProviderSecret(connection);
    const discovery = await discoverProviderModels({
      provider: connection.provider,
      apiKey: connection.provider === "ollama" ? undefined : secret.apiKey,
      connectionName: connection.name,
      baseUrl: connection.provider === "ollama" ? connection.baseUrl : undefined
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
      if (input.autoSync !== undefined || input.excludePatterns) {
        this.db.updateChannel(existing.id, {
          autoSync: input.autoSync ?? existing.autoSync,
          excludePatterns: input.excludePatterns ? normalizeExcludePatterns(input.excludePatterns) : existing.excludePatterns
        });
      }
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
    const channelId = randomUUID();
    const channel: Channel = {
      id: channelId,
      displayName: uniqueName,
      rootPath: input.rootPath,
      indexPath: channelIndexPath(channelId),
      preferredConnectionId: nextModels.preferredConnectionId,
      chatModelId: nextModels.chatModelId,
      embeddingModelId: nextModels.embeddingModelId,
      retrievalMode: nextModels.retrievalMode,
      systemPrompt: normalizeChannelSystemPrompt(input.systemPrompt),
      autoSync: input.autoSync ?? true,
      excludePatterns: normalizeExcludePatterns(input.excludePatterns ?? []),
      lastIndexedAt: null,
      lastIndexStats: null,
      lastError: null,
      status: "idle",
      createdAt: now,
      updatedAt: now
    };

    this.assertValidChannelModelSelection(channel.chatModelId, channel.embeddingModelId);
    this.db.createChannel(channel);
    // An index left inside the folder by an older version is adopted rather than rebuilt.
    moveLegacyIndex(channel.rootPath, channel.indexPath);

    const status = await this.worker.getIndexStatus(channelIndexTarget(channel));
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
    if (channel.status === "indexing" || this.worker.hasActiveBuild(channel.id)) {
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

    // The index (chunks, keyword index and any stored vectors) is never thrown away by a switch between
    // keyword and semantic search or by choosing another embedding model. Chat keeps working through keyword
    // search; moving to semantic search starts a sync that only embeds what has no vector for this model yet.
    const needsSemanticSync =
      nextModels.retrievalMode === "vector" &&
      Boolean(channel.lastIndexedAt) &&
      (channel.retrievalMode !== "vector" || nextModels.embeddingModelId !== channel.embeddingModelId);

    this.db.updateChannel(channel.id, {
      preferredConnectionId: nextModels.preferredConnectionId,
      chatModelId: nextModels.chatModelId,
      embeddingModelId: nextModels.embeddingModelId,
      retrievalMode: nextModels.retrievalMode,
      status: nextStatus,
      lastIndexedAt: nextLastIndexedAt,
      updatedAt: new Date().toISOString()
    });
    this.refreshWatchers();
    if (needsSemanticSync && !this.worker.hasActiveBuild(channel.id)) {
      void this.syncChannel(channel.id, { force: true });
    }

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
    const channel = this.db.getChannel(channelId);
    if (!channel) {
      return;
    }
    if (channel.status === "indexing" && this.worker.hasActiveBuild(channel.id)) {
      throw new Error("Cancel indexing before deleting this channel.");
    }
    this.watcher.unwatch(channel.id);
    this.pendingResync.delete(channel.id);
    // Source files are never touched; only the app's own index copy is removed.
    this.deleteChannelIndexArtifacts(channel);
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

  async listChannelFiles(channelId: string, status: "indexed" | "failed" | "skipped") {
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

  async openChannelFolder(channelId: string): Promise<void> {
    const channel = this.db.getChannel(channelId);
    if (!channel) {
      throw new Error("Channel not found.");
    }
    if (!existsSync(channel.rootPath)) {
      throw new Error("This knowledge base's folder is not available. It may have been moved, renamed or be on a disconnected drive.");
    }
    const error = await shell.openPath(channel.rootPath);
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
    let searchResponse: { results: SearchResult[] } = { results: [] };
    let contextNotes: string[] = [];
    let deterministicAssistantText: string | null = null;
    let exactCalculation: ExactCalculation | null = null;
    let visualAssets: ResolvedVisualAsset[] = [];
    let documentManifestDocuments: IndexedDocumentRecord[] = [];
    const queryProfile = analyzeSpreadsheetQuery(input.message);
    const existingThread = input.threadId ? this.db.listThreads(channel.id).find((candidate) => candidate.id === input.threadId) : null;
    const history = existingThread ? this.db.listMessages(existingThread.id) : [];

    // Semantic search needs the embedding provider. If anything on that path fails (no credits, offline,
    // rate limited, index not embedded yet, ...) the question is answered with keyword search instead.
    let useKeywordRetrieval = channel.retrievalMode !== "vector";
    let semanticFallbackReason: string | null = null;
    if (!useKeywordRetrieval) {
      try {
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
          searchResponse = await this.worker.search(channelIndexTarget(channel), input.message, 6, queryOptions);
        } catch (error) {
          if (isInvalidIndexError(error)) {
            await this.invalidateChannelIndex(channel, INDEX_OUTDATED_MESSAGE);
          }
          throw error;
        }
        if (queryProfile.analytical) {
          // Semantic retrieval returns excerpts, not documents: pick the spreadsheets to calculate over.
          try {
            documentManifestDocuments = (await this.worker.listDocuments(channelIndexTarget(channel))).documents;
          } catch {
            documentManifestDocuments = [];
          }
          const retrievedPaths = new Set(searchResponse.results.map((item) => item.relativePath));
          const spreadsheets = documentManifestDocuments.filter(isTabularDocument);
          const retrieved = spreadsheets.filter((document) => retrievedPaths.has(document.relativePath));
          const others = preselectManifestDocuments(
            spreadsheets.filter((document) => !retrievedPaths.has(document.relativePath)),
            input.message,
            MAX_CALCULATION_DOCUMENTS
          );
          exactCalculation = await this.tryExactSpreadsheetCalculation({
            channel,
            chatSelection,
            documents: [...retrieved, ...others].slice(0, MAX_CALCULATION_DOCUMENTS),
            question: input.message,
            history
          });
        }
      } catch (error) {
        if (error instanceof Error && error.message === INDEX_OUTDATED_MESSAGE) {
          throw error;
        }
        semanticFallbackReason = error instanceof Error ? error.message : "semantic search failed";
        console.warn(`[hello-files] Semantic search failed for ${channel.displayName}; using keyword search:`, error);
        useKeywordRetrieval = true;
        searchResponse = { results: [] };
        exactCalculation = null;
        documentManifestDocuments = [];
      }
    }
    if (useKeywordRetrieval) {
      const documentManifest = await this.worker.listDocuments(channelIndexTarget(channel));
      documentManifestDocuments = documentManifest.documents;
      const candidateDocuments = preselectManifestDocuments(documentManifest.documents, input.message, 24);
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
        searchResponse = await this.worker.search(channelIndexTarget(channel), input.message, 8, queryOptions);
        if (searchResponse.results.length === 0 && selectedDocumentIds.length > 0) {
          searchResponse = await this.worker.search(
            channelIndexTarget(channel),
            input.message,
            8,
            this.toWorkerBuildOptions({ retrievalMode: "vectorless" })
          );
        }
        const selectedDocuments = candidateDocuments.filter((document) => selectedDocumentIds.includes(document.documentId));
        const spreadsheetDocuments = selectedDocuments.filter(isSpreadsheetDocument);
        // Exact calculation: prefer the spreadsheets the model picked, else the best-matching candidates.
        const selectedTabular = selectedDocuments.filter(isTabularDocument);
        const calculationDocuments = (selectedTabular.length > 0 ? selectedTabular : candidateDocuments.filter(isTabularDocument)).slice(
          0,
          MAX_CALCULATION_DOCUMENTS
        );
        const calculate = () =>
          this.tryExactSpreadsheetCalculation({
            channel,
            chatSelection,
            documents: calculationDocuments,
            question: input.message,
            history
          });
        // Unfiltered "how many rows" questions keep the zero-LLM structure answer below.
        if (queryProfile.analytical && !queryProfile.plainRowCount && calculationDocuments.length > 0) {
          exactCalculation = await calculate();
        }
        if (!exactCalculation && queryProfile.exhaustive && spreadsheetDocuments.length > 0) {
          const spreadsheetStructureSummary = summarizeSpreadsheetStructureQuery(spreadsheetDocuments, input.message, queryProfile);
          if (spreadsheetStructureSummary) {
            contextNotes = [...contextNotes, ...spreadsheetStructureSummary.notes];
            if (queryProfile.plainRowCount) {
              deterministicAssistantText = buildSpreadsheetCountAnswer(spreadsheetStructureSummary);
            }
          }
          const spreadsheetDocumentIds = spreadsheetDocuments.map((document) => document.documentId);
          const exhaustiveLimit = spreadsheetDocuments.reduce((sum, document) => sum + Math.max(document.chunks, 0), 0);
          if (exhaustiveLimit > 0) {
            const exhaustiveSearch = await this.worker.search(
              channelIndexTarget(channel),
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
        // A plain row count the structure could not answer (e.g. a CSV) still gets an exact count.
        if (!exactCalculation && !deterministicAssistantText && queryProfile.analytical && queryProfile.plainRowCount && calculationDocuments.length > 0) {
          exactCalculation = await calculate();
        }
      } catch (error) {
        if (isInvalidIndexError(error)) {
          await this.invalidateChannelIndex(channel, INDEX_OUTDATED_MESSAGE);
        }
        throw error;
      }
    }

    if (isVisualInventoryQuery(input.message)) {
      if (documentManifestDocuments.length === 0) {
        try {
          documentManifestDocuments = (await this.worker.listDocuments(channelIndexTarget(channel))).documents;
        } catch {
          documentManifestDocuments = [];
        }
      }
      contextNotes = [...contextNotes, ...summarizeVisualInventoryNotes(documentManifestDocuments)];
    }

    visualAssets = await this.resolveVisualContext(
      channelIndexTarget(channel),
      chatSelection.connection,
      chatSelection.model,
      searchResponse.results,
      documentManifestDocuments,
      input.message
    );

    const askedAt = new Date().toISOString();

    // Ask the model before writing anything, so a failed call does not leave an unanswered question behind.
    const assistantText =
      deterministicAssistantText ??
      (await generateAssistantReply({
        connection: chatSelection.connection,
        model: chatSelection.model,
        secret: chatSelection.secret,
        searchResults: searchResponse.results,
        // The exact result goes first so it outranks the lexical row-scan notes.
        contextNotes: exactCalculation ? [exactCalculation.contextNote, ...contextNotes] : contextNotes,
        visualAssets,
        history,
        userMessage: input.message,
        systemPrompt: channel.systemPrompt
      }));

    const thread: Thread =
      existingThread ??
      this.db.createThread({
        id: randomUUID(),
        channelId: channel.id,
        title: resolveThreadTitle(input.message.slice(0, 50), this.db.listThreads(channel.id).length + 1),
        createdAt: askedAt,
        updatedAt: askedAt
      });
    const userMessage: Message = {
      id: randomUUID(),
      threadId: thread.id,
      role: "user",
      content: input.message,
      citations: [],
      createdAt: askedAt
    };
    this.db.createMessage(userMessage);
    if (history.length === 0) {
      this.db.updateThreadTitle(thread.id, input.message.slice(0, 50) || thread.title);
    }

    const assistantMessage: Message = {
      id: randomUUID(),
      threadId: thread.id,
      role: "assistant",
      content: assistantText,
      citations: [
        ...(exactCalculation?.citations ?? []),
        ...searchResponse.results.map((item) => ({
          relativePath: item.relativePath,
          chunkId: item.chunkId,
          score: item.score,
          snippet: item.snippet
        }))
      ],
      ...(exactCalculation ? { calculation: exactCalculation.calculation } : {}),
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
      assistantMessage,
      ...(semanticFallbackReason
        ? { notice: `Semantic search wasn't available (${summarizeSearchFailure(semanticFallbackReason)}), so this answer used keyword search.` }
        : {})
    };
  }

  /**
   * Exact spreadsheet calculation for analytical questions ("total premium by state"):
   *   1. the worker reports each sheet's tables, columns, types and sample rows (read from the original files);
   *   2. ONE chat-model call turns the question plus that schema into a SELECT;
   *   3. the worker runs it under a SQLite authorizer (read-only, whitelisted functions, 5 s limit, row cap);
   *   4. on a SQL error, ONE repair call receives the error; after that we give up.
   * Returns null whenever the question is not answerable this way or anything fails; the caller then falls back
   * to the row-excerpt behaviour. This method never throws, and neither model-generated SQL nor errors
   * are shown to the user except the sanitised `calculation` detail of a successful result.
   *
   * Data policy: the SQL-generation call sends table/column names, the values of low-cardinality text columns
   * and 3 sample rows per sheet to the chat provider. It goes through the channel's chat model, which
   * resolveModelSelection() already checked against the data policy, so it is the same trust boundary
   * as the chat call (local-only channels keep this on the local Ollama endpoint).
   */
  private async tryExactSpreadsheetCalculation(args: {
    channel: Channel;
    chatSelection: { connection: ProviderConnection; model: ProviderModel; secret: { apiKey?: string } };
    documents: IndexedDocumentRecord[];
    question: string;
    history: Message[];
  }): Promise<ExactCalculation | null> {
    const { channel, chatSelection, documents, question, history } = args;
    const documentIds = documents.slice(0, MAX_CALCULATION_DOCUMENTS).map((document) => document.documentId);
    if (documentIds.length === 0) {
      return null;
    }
    const target = channelIndexTarget(channel);
    try {
      const schema = await this.worker.spreadsheetSchema(target, documentIds);
      if (!schema.documents.some((document) => document.sheets.length > 0)) {
        return null;
      }
      const recentQuestions = history.filter((message) => message.role === "user").map((message) => message.content);
      const ask = async (repair?: { sql: string; error: string }) => {
        const { systemPrompt, prompt } = buildSqlGenerationPrompt({ question, schema, recentQuestions, repair });
        return parseSqlReply(
          await requestSpreadsheetSql({
            connection: chatSelection.connection,
            model: chatSelection.model,
            secret: chatSelection.secret,
            systemPrompt,
            prompt
          })
        );
      };

      let reply = await ask();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (reply.kind === "none") {
          return null;
        }
        let failure: { sql: string; error: string };
        if (reply.kind === "sql") {
          try {
            const result = await this.worker.spreadsheetQuery(target, documentIds, reply.sql);
            if (result.tablesUsed.length === 0) {
              return null;
            }
            return {
              contextNote: buildCalculationNote({ sql: reply.sql, result, schema }),
              citations: buildCalculationCitations({ result, schema }),
              calculation: buildCalculation({ sql: reply.sql, result })
            };
          } catch (error) {
            failure = { sql: reply.sql, error: error instanceof Error ? error.message : String(error) };
          }
        } else {
          failure = { sql: "(no valid query)", error: reply.reason };
        }
        if (attempt === 1) {
          console.warn(`[hello-files] Exact calculation gave up after a repair attempt: ${failure.error}`);
          return null;
        }
        reply = await ask(failure);
      }
      return null;
    } catch (error) {
      console.warn("[hello-files] Exact spreadsheet calculation unavailable:", error);
      return null;
    }
  }

  /**
   * Incremental sync triggered by the folder watcher or app start. Runs in the background:
   * the channel stays chat-ready on its previous index while the sync is in progress.
   */
  private async syncChannel(channelId: string, options: { force?: boolean } = {}) {
    const channel = this.db.getChannel(channelId);
    if (!channel || (!options.force && !this.canAutoSync(channel))) {
      return;
    }
    if (this.worker.hasActiveBuild(channel.id)) {
      this.pendingResync.add(channel.id);
      return;
    }
    try {
      await this.runIndex(channel.id, false, { background: true });
    } catch (error) {
      console.warn(`[hello-files] Background sync failed for ${channel.displayName}:`, error);
    }
  }

  private async runIndex(channelId: string, rebuild: boolean, runOptions: { background?: boolean } = {}) {
    const channel = this.db.getChannel(channelId);
    if (!channel) {
      throw new Error("Channel not found.");
    }
    if (this.worker.hasActiveBuild(channel.id)) {
      throw new Error("Indexing is already running for this channel.");
    }

    const options = await this.buildIndexOptions(channel);
    const background = Boolean(runOptions.background) && channel.lastIndexedAt !== null && ["ready", "stale"].includes(channel.status);
    if (!background) {
      this.db.updateChannel(channel.id, {
        status: "indexing",
        lastError: null,
        updatedAt: new Date().toISOString()
      });
      this.webContents?.send("fschat:channel-refreshed", this.db.getChannelSnapshot(channel.id));
    }

    try {
      const response = rebuild
        ? await this.worker.rebuildIndex(channel.id, channelIndexTarget(channel), options)
        : await this.worker.buildIndex(channel.id, channelIndexTarget(channel), options);

      await this.applyIndexResult(channel, response);

      const snapshot = await this.loadChannel(channel.id);
      this.webContents?.send("fschat:channel-refreshed", snapshot);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Indexing failed.";
      const cancelled = message.toLowerCase().includes("cancelled");
      // A failed background sync leaves the previous index in place, so the channel stays usable.
      this.db.updateChannel(channel.id, {
        status: background ? channel.status : cancelled ? "idle" : "error",
        lastError: cancelled ? null : message,
        updatedAt: new Date().toISOString()
      });
      const snapshot = await this.loadChannel(channel.id);
      this.webContents?.send("fschat:channel-refreshed", snapshot);
      throw error;
    } finally {
      if (this.pendingResync.delete(channel.id)) {
        void this.syncChannel(channel.id);
      }
    }
  }

  private async applyIndexResult(channel: Channel, response: WorkerBuildResponse) {
    if (response.cancelled) {
      if (response.retainedPartial && response.manifest) {
        this.db.replaceIndexedFiles(channel.id, response.files);
        this.db.updateChannel(channel.id, {
          lastIndexedAt: response.manifest.updatedAt,
          lastIndexStats: response.stats ?? null,
          status: deriveCancelledChannelStatus(response.files),
          updatedAt: new Date().toISOString()
        });
        return;
      }

      const existing = await this.worker.getIndexStatus(channelIndexTarget(channel));
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
      lastIndexStats: response.stats ?? null,
      // The sync itself worked (files are indexed and keyword-searchable); only the embeddings failed.
      lastError: response.embeddingError
        ? `Semantic search is paused: ${summarizeSearchFailure(response.embeddingError)} Chat uses keyword search until a sync can embed the new content.`
        : null,
      status: deriveChannelStatusFromFiles(response.files),
      updatedAt: new Date().toISOString()
    });
    this.refreshWatchers();
  }

  private async resolveModelSelection(modelId: string, options: { enforcePolicy?: boolean } = {}) {
    const model = this.db.getProviderModel(modelId);
    if (!model) {
      throw new Error("Provider model not found.");
    }
    const connection = this.db.getProviderConnection(model.connectionId);
    if (!connection) {
      throw new Error("Provider connection not found.");
    }
    if (options.enforcePolicy !== false) {
      this.assertConnectionAllowed(connection);
    }
    const secret = await this.getProviderSecret(connection);
    return { model, connection, secret };
  }

  private async getProviderSecret(connection: ProviderConnection) {
    if (connection.provider === "ollama" || connection.provider === "openai-codex") {
      return { apiKey: "" };
    }

    for (const service of SECRET_SERVICES) {
      const apiKey = await keytar.getPassword(service, connection.secretRef);
      if (apiKey) {
        if (service !== SECRET_SERVICE) {
          await keytar.setPassword(SECRET_SERVICE, connection.secretRef, apiKey);
        }
        return { apiKey };
      }
    }

    throw new Error(`Credentials missing for provider connection "${connection.name}".`);
  }

  private async resolveVisualContext(
    target: IndexTarget,
    connection: ProviderConnection,
    model: ProviderModel,
    results: SearchResult[],
    documents: IndexedDocumentRecord[] = [],
    query = ""
  ): Promise<ResolvedVisualAsset[]> {
    if (!model.supportsVision || !providerSupportsMultimodalInput(connection.provider)) {
      return [];
    }

    const selected: VisualAssetReference[] = [];
    const seen = new Set<string>();
    for (const result of results.slice(0, 5)) {
      for (const asset of result.visualAssets ?? []) {
        const key = [
          asset.kind,
          asset.relativePath,
          asset.pageNumber ?? "",
          asset.imageIndex ?? "",
          asset.mediaPath ?? ""
        ].join("|");
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        selected.push(asset);
        if (selected.length >= 3) {
          break;
        }
      }
      if (selected.length >= 3) {
        break;
      }
    }

    if (selected.length < 3 && isVisualInventoryQuery(query)) {
      for (const document of documents) {
        for (const asset of document.visualAssets ?? []) {
          const key = [
            asset.kind,
            asset.relativePath,
            asset.pageNumber ?? "",
            asset.imageIndex ?? "",
            asset.mediaPath ?? ""
          ].join("|");
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          selected.push(asset);
          if (selected.length >= 3) {
            break;
          }
        }
        if (selected.length >= 3) {
          break;
        }
      }
    }

    if (selected.length === 0) {
      return [];
    }

    try {
      return (await this.worker.resolveVisualAssets(target, selected, 3)).assets;
    } catch {
      return [];
    }
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

    const status = await this.worker.getIndexStatus(channelIndexTarget(channel));
    if (!status.exists || !status.manifest) {
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

    // Every index can serve keyword search. A semantic-search channel whose index has no vectors for its
    // embedding model yet (switched modes, changed model, or embedding failed) stays usable: chat falls back to
    // keyword search until a sync has embedded the rest.
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

  private deleteChannelIndexArtifacts(channel: Channel) {
    const targets = [
      channel.indexPath,
      `${channel.indexPath}.tmp`,
      `${channel.indexPath}.old`,
      join(channel.rootPath, INDEX_DIR_NAME),
      join(channel.rootPath, INDEX_TEMP_DIR_NAME)
    ];
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

  private async buildIndexOptions(channel: Channel): Promise<WorkerBuildOptions> {
    const retrievalOptions =
      channel.retrievalMode === "vector"
        ? await this.buildVectorIndexOptions(channel)
        : this.toWorkerBuildOptions({ retrievalMode: "vectorless" });
    return {
      ...retrievalOptions,
      excludePatterns: channel.excludePatterns,
      maxFileSizeMb: DEFAULT_MAX_FILE_SIZE_MB
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
  }

  private assertConnectionAllowed(connection: ProviderConnection) {
    if (connection.provider === "openai-codex" && !CODEX_ENABLED) {
      throw new Error("OpenAI Codex is disabled in this build. Pick a different model for this knowledge base.");
    }
    if (this.db.getAppSettings().dataPolicy === "local-only" && !isLocalConnection(connection)) {
      throw new Error(
        `Local-only mode is on, so "${connection.name}" can't be used because it would send file content off this computer. ` +
          "Pick a local Ollama model for this knowledge base, or turn off local-only mode in Settings."
      );
    }
  }

  private isConnectionAllowed(connection: ProviderConnection | null) {
    if (!connection) {
      return false;
    }
    try {
      this.assertConnectionAllowed(connection);
      return true;
    } catch {
      return false;
    }
  }

  private channelUsesConnection(channel: Channel, connectionId: string) {
    if (channel.preferredConnectionId === connectionId) {
      return true;
    }
    return [channel.chatModelId, channel.embeddingModelId].some(
      (modelId) => modelId !== null && this.db.getProviderModel(modelId)?.connectionId === connectionId
    );
  }

  /** Auto-sync only runs for indexed channels whose models are configured and allowed by the data policy. */
  private canAutoSync(channel: Channel) {
    if (!channel.autoSync || !channel.lastIndexedAt || channel.status === "indexing") {
      return false;
    }
    if (channel.retrievalMode === "vector") {
      const embeddingModel = channel.embeddingModelId ? this.db.getProviderModel(channel.embeddingModelId) : null;
      if (!embeddingModel || !this.isConnectionAllowed(this.db.getProviderConnection(embeddingModel.connectionId))) {
        return false;
      }
    }
    return existsSync(channel.rootPath);
  }

  private watchSignatures = new Map<string, string>();

  private refreshWatchers() {
    const channels = this.db.listChannels();
    const liveIds = new Set(channels.map((channel) => channel.id));
    for (const channelId of [...this.watchSignatures.keys()]) {
      if (!liveIds.has(channelId)) {
        this.watcher.unwatch(channelId);
        this.watchSignatures.delete(channelId);
      }
    }
    for (const channel of channels) {
      const shouldWatch = channel.autoSync && channel.lastIndexedAt !== null && existsSync(channel.rootPath);
      const signature = `${channel.rootPath}|${JSON.stringify(channel.excludePatterns)}`;
      if (!shouldWatch) {
        this.watcher.unwatch(channel.id);
        this.watchSignatures.delete(channel.id);
        continue;
      }
      if (this.watchSignatures.get(channel.id) === signature && this.watcher.isWatching(channel.id)) {
        continue;
      }
      this.watcher.watch(channel.id, channel.rootPath, channel.excludePatterns);
      this.watchSignatures.set(channel.id, signature);
    }
  }

  /** Older versions stored the index inside the user's folder; move it into app data. */
  private migrateLegacyIndexLocations() {
    for (const channel of this.db.listChannels()) {
      const target = channelIndexPath(channel.id);
      if (channel.indexPath === target || this.worker.hasActiveBuild(channel.id)) {
        continue;
      }
      if (moveLegacyIndex(channel.rootPath, target)) {
        this.db.updateChannel(channel.id, { indexPath: target });
      }
    }
  }
}

function indexStorageDir() {
  return join(app.getPath("userData"), INDEX_STORAGE_DIR_NAME);
}

function channelIndexPath(channelId: string) {
  return join(indexStorageDir(), channelId);
}

function channelIndexTarget(channel: Channel): IndexTarget {
  return { rootPath: channel.rootPath, indexPath: channel.indexPath };
}

function legacyIndexTarget(rootPath: string): IndexTarget {
  return { rootPath, indexPath: join(rootPath, INDEX_DIR_NAME) };
}

/**
 * Moves an in-folder index to `targetPath`. Returns true when the channel can point at
 * `targetPath` (moved, or there was nothing to move); false when the move failed, for example
 * because the folder is on a disconnected drive, so the caller keeps the old location for now.
 */
function moveLegacyIndex(rootPath: string, targetPath: string): boolean {
  const legacyPath = join(rootPath, INDEX_DIR_NAME);
  try {
    rmSync(join(rootPath, INDEX_TEMP_DIR_NAME), { recursive: true, force: true });
    if (!existsSync(legacyPath)) {
      return true;
    }
    if (existsSync(join(targetPath, "manifest.json"))) {
      rmSync(legacyPath, { recursive: true, force: true });
      return true;
    }
    mkdirSync(indexStorageDir(), { recursive: true });
    rmSync(targetPath, { recursive: true, force: true });
    try {
      renameSync(legacyPath, targetPath);
    } catch {
      // Cross-volume moves (EXDEV) need a copy.
      cpSync(legacyPath, targetPath, { recursive: true });
      rmSync(legacyPath, { recursive: true, force: true });
    }
    return true;
  } catch (error) {
    console.warn(`[hello-files] Could not move legacy index from ${legacyPath}:`, error);
    return false;
  }
}

function normalizeExcludePatterns(patterns: string[]) {
  return [...new Set(patterns.map((pattern) => pattern.trim()).filter(Boolean))].slice(0, 200);
}

function normalizeAzureEndpoint(baseUrl: string | undefined) {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "") ?? "";
  if (!trimmed) {
    throw new Error("Azure OpenAI needs the resource endpoint, for example https://my-resource.openai.azure.com.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Azure OpenAI endpoint must be a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Azure OpenAI endpoint must use https.");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function isLocalConnection(connection: ProviderConnection) {
  return connection.provider === "ollama" && isLocalUrl(connection.baseUrl || defaultBaseUrl("ollama") || "");
}

function isLocalUrl(url: string) {
  try {
    return LOCAL_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function normalizeOllamaUrl(baseUrl: string | undefined) {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "") || defaultBaseUrl("ollama") || "";
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  } catch {
    throw new Error("Ollama address must look like http://localhost:11434 or http://server-name:11434.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Ollama address must start with http:// or https://.");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}


function resolveDatabasePath() {
  const userDataDir = app.getPath("userData");
  const dbPath = join(userDataDir, DB_FILE_NAME);
  if (existsSync(dbPath)) {
    return dbPath;
  }

  for (const legacyDir of LEGACY_USER_DATA_DIRS) {
    const legacyDbPath = join(app.getPath("appData"), legacyDir, DB_FILE_NAME);
    if (!existsSync(legacyDbPath) || legacyDbPath === dbPath) {
      continue;
    }

    mkdirSync(userDataDir, { recursive: true });
    copyFileSync(legacyDbPath, dbPath);
    return dbPath;
  }

  return dbPath;
}

/** One short line for the toast: the provider's message without stack-like noise. */
function summarizeSearchFailure(message: string) {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}
