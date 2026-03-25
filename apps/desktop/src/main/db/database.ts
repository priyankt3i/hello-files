import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type {
  Channel,
  ChannelSnapshot,
  FileIndexStatus,
  IndexedFileRecord,
  Message,
  ProviderConnection,
  ProviderDefaults,
  ProviderModel,
  Thread
} from "@fschat/shared";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");

type BetterDatabase = InstanceType<typeof BetterSqlite3>;

export class AppDatabase {
  private db: BetterDatabase;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        index_path TEXT NOT NULL,
        chat_profile_id TEXT,
        embedding_profile_id TEXT,
        preferred_connection_id TEXT,
        chat_model_id TEXT,
        embedding_model_id TEXT,
        retrieval_mode TEXT NOT NULL DEFAULT 'vector',
        system_prompt TEXT NOT NULL DEFAULT '',
        last_indexed_at TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        purpose TEXT NOT NULL,
        base_url TEXT,
        api_version TEXT,
        api_key_hint TEXT,
        chat_model TEXT,
        embedding_model TEXT,
        deployment TEXT,
        secret_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        base_url TEXT,
        api_version TEXT,
        api_key_hint TEXT,
        secret_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_models (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        supports_chat INTEGER NOT NULL DEFAULT 0,
        supports_embedding INTEGER NOT NULL DEFAULT 0,
        supports_vision INTEGER NOT NULL DEFAULT 0,
        deployment TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(connection_id, model_id)
      );

      CREATE TABLE IF NOT EXISTS provider_default_models (
        connection_id TEXT PRIMARY KEY,
        default_chat_model_id TEXT,
        default_embedding_model_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        citations_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS indexed_files (
        channel_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        status TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime REAL NOT NULL,
        parser TEXT NOT NULL,
        chunks INTEGER NOT NULL,
        content_hash TEXT,
        error_reason TEXT,
        PRIMARY KEY (channel_id, relative_path)
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    this.ensureColumn("channels", "preferred_connection_id", "TEXT");
    this.ensureColumn("channels", "chat_model_id", "TEXT");
    this.ensureColumn("channels", "embedding_model_id", "TEXT");
    this.ensureColumn("channels", "retrieval_mode", "TEXT NOT NULL DEFAULT 'vector'");
    this.ensureColumn("channels", "system_prompt", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("indexed_files", "content_hash", "TEXT");

    this.migrateLegacyProviderProfiles();
  }

  private ensureColumn(tableName: string, columnName: string, columnDefinition: string) {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === columnName)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }

  private tableExists(tableName: string) {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { name?: string } | undefined;
    return Boolean(row?.name);
  }

  private migrateLegacyProviderProfiles() {
    if (!this.tableExists("provider_profiles")) {
      return;
    }

    const connectionCount = this.db.prepare("SELECT COUNT(*) as count FROM provider_connections").get() as { count: number };
    if (connectionCount.count > 0) {
      return;
    }

    const legacyProfiles = this.db.prepare("SELECT * FROM provider_profiles ORDER BY created_at ASC").all() as any[];
    if (legacyProfiles.length === 0) {
      return;
    }

    const insertConnection = this.db.prepare(
      `INSERT OR IGNORE INTO provider_connections (
        id, name, provider, base_url, api_version, api_key_hint, secret_ref, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertModel = this.db.prepare(
      `INSERT OR IGNORE INTO provider_models (
        id, connection_id, provider, model_id, display_name, supports_chat, supports_embedding, supports_vision, deployment, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const connectionByLegacyProfileId = new Map<string, string>();
    const modelByLegacyProfileId = new Map<string, string>();

    const transaction = this.db.transaction(() => {
      for (const row of legacyProfiles) {
        const connectionId = `legacy-connection:${row.id}`;
        const modelId = `legacy-model:${row.id}`;
        connectionByLegacyProfileId.set(row.id, connectionId);
        modelByLegacyProfileId.set(row.id, modelId);

        insertConnection.run(
          connectionId,
          row.name,
          row.provider,
          row.base_url ?? null,
          row.api_version ?? null,
          row.api_key_hint ?? null,
          row.secret_ref,
          row.created_at,
          row.updated_at
        );

        const discoveredModel = row.chat_model ?? row.embedding_model ?? row.deployment ?? row.name;
        insertModel.run(
          modelId,
          connectionId,
          row.provider,
          discoveredModel,
          discoveredModel,
          row.purpose === "chat" ? 1 : 0,
          row.purpose === "embedding" ? 1 : 0,
          0,
          row.deployment ?? null,
          null,
          row.created_at,
          row.updated_at
        );
      }

      for (const channel of this.listLegacyChannels()) {
        const chatModelId = channel.chat_profile_id ? modelByLegacyProfileId.get(channel.chat_profile_id) ?? null : null;
        const embeddingModelId = channel.embedding_profile_id
          ? modelByLegacyProfileId.get(channel.embedding_profile_id) ?? null
          : null;
        const preferredConnectionId =
          (channel.chat_profile_id ? connectionByLegacyProfileId.get(channel.chat_profile_id) : null) ??
          (channel.embedding_profile_id ? connectionByLegacyProfileId.get(channel.embedding_profile_id) : null) ??
          null;

        this.db
          .prepare(
            "UPDATE channels SET preferred_connection_id = COALESCE(preferred_connection_id, ?), chat_model_id = COALESCE(chat_model_id, ?), embedding_model_id = COALESCE(embedding_model_id, ?) WHERE id = ?"
          )
          .run(
            preferredConnectionId,
            chatModelId,
            embeddingModelId,
            channel.id
          );
      }

      const defaults = this.db.prepare("SELECT key, value FROM app_settings").all() as Array<{ key: string; value: string | null }>;
      const legacyDefaultChat = defaults.find((row) => row.key === "defaultChatProfileId")?.value ?? null;
      const legacyDefaultEmbedding = defaults.find((row) => row.key === "defaultEmbeddingProfileId")?.value ?? null;
      const saveProviderDefaults = this.db.prepare(
        `INSERT INTO provider_default_models (connection_id, default_chat_model_id, default_embedding_model_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(connection_id) DO UPDATE SET
           default_chat_model_id = excluded.default_chat_model_id,
           default_embedding_model_id = excluded.default_embedding_model_id,
           updated_at = excluded.updated_at`
      );
      const preferredLegacyConnectionId =
        (legacyDefaultChat ? connectionByLegacyProfileId.get(legacyDefaultChat) : null) ??
        (legacyDefaultEmbedding ? connectionByLegacyProfileId.get(legacyDefaultEmbedding) : null);
      if (preferredLegacyConnectionId) {
        saveProviderDefaults.run(
          preferredLegacyConnectionId,
          legacyDefaultChat ? modelByLegacyProfileId.get(legacyDefaultChat) ?? null : null,
          legacyDefaultEmbedding ? modelByLegacyProfileId.get(legacyDefaultEmbedding) ?? null : null,
          new Date().toISOString()
        );
      }
    });

    transaction();
  }

  private listLegacyChannels() {
    return this.db.prepare("SELECT id, chat_profile_id, embedding_profile_id FROM channels").all() as Array<{
      id: string;
      chat_profile_id: string | null;
      embedding_profile_id: string | null;
    }>;
  }

  listChannels(): Channel[] {
    const rows = this.db.prepare("SELECT * FROM channels ORDER BY display_name COLLATE NOCASE").all() as any[];
    return rows.map(mapChannel);
  }

  getChannel(id: string): Channel | null {
    const row = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as any;
    return row ? mapChannel(row) : null;
  }

  getChannelByRoot(rootPath: string): Channel | null {
    const row = this.db.prepare("SELECT * FROM channels WHERE root_path = ?").get(rootPath) as any;
    return row ? mapChannel(row) : null;
  }

  createChannel(channel: Channel): Channel {
    this.db
      .prepare(
        `INSERT INTO channels (
          id, display_name, root_path, index_path, chat_profile_id, embedding_profile_id, preferred_connection_id, chat_model_id, embedding_model_id, retrieval_mode, system_prompt, last_indexed_at, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        channel.id,
        channel.displayName,
        channel.rootPath,
        channel.indexPath,
        null,
        null,
        channel.preferredConnectionId,
        channel.chatModelId,
        channel.embeddingModelId,
        channel.retrievalMode,
        channel.systemPrompt,
        channel.lastIndexedAt,
        channel.status,
        channel.createdAt,
        channel.updatedAt
      );
    return channel;
  }

  deleteChannel(id: string) {
    const deleteMessages = this.db.prepare(
      "DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE channel_id = ?)"
    );
    const deleteThreads = this.db.prepare("DELETE FROM threads WHERE channel_id = ?");
    const deleteIndexedFiles = this.db.prepare("DELETE FROM indexed_files WHERE channel_id = ?");
    const deleteChannel = this.db.prepare("DELETE FROM channels WHERE id = ?");

    const transaction = this.db.transaction(() => {
      deleteMessages.run(id);
      deleteThreads.run(id);
      deleteIndexedFiles.run(id);
      deleteChannel.run(id);
    });

    transaction();
  }

  updateChannel(
    id: string,
    patch: Partial<
      Pick<
        Channel,
        | "displayName"
        | "preferredConnectionId"
        | "chatModelId"
        | "embeddingModelId"
        | "retrievalMode"
        | "systemPrompt"
        | "lastIndexedAt"
        | "status"
        | "updatedAt"
      >
    >
  ) {
    const current = this.getChannel(id);
    if (!current) {
      throw new Error(`Channel ${id} not found.`);
    }

    const next: Channel = {
      ...current,
      ...patch
    };

    this.db
      .prepare(
        `UPDATE channels
         SET display_name = ?, preferred_connection_id = ?, chat_model_id = ?, embedding_model_id = ?, retrieval_mode = ?, system_prompt = ?, last_indexed_at = ?, status = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        next.displayName,
        next.preferredConnectionId,
        next.chatModelId,
        next.embeddingModelId,
        next.retrievalMode,
        next.systemPrompt,
        next.lastIndexedAt,
        next.status,
        next.updatedAt,
        id
      );
  }

  getUniqueChannelName(baseName: string): string {
    const names = this.db
      .prepare("SELECT display_name FROM channels WHERE display_name LIKE ? ORDER BY display_name COLLATE NOCASE")
      .all(`${baseName}%`) as Array<{ display_name: string }>;

    if (!names.some((row) => row.display_name === baseName)) {
      return baseName;
    }

    let suffix = 2;
    while (names.some((row) => row.display_name === `${baseName} (${suffix})`)) {
      suffix += 1;
    }

    return `${baseName} (${suffix})`;
  }

  getUniqueConnectionName(baseName: string): string {
    const names = this.db
      .prepare("SELECT name FROM provider_connections WHERE name LIKE ? ORDER BY name COLLATE NOCASE")
      .all(`${baseName}%`) as Array<{ name: string }>;

    if (!names.some((row) => row.name === baseName)) {
      return baseName;
    }

    let suffix = 2;
    while (names.some((row) => row.name === `${baseName} (${suffix})`)) {
      suffix += 1;
    }

    return `${baseName} (${suffix})`;
  }

  listProviderConnections(): ProviderConnection[] {
    const rows = this.db.prepare("SELECT * FROM provider_connections ORDER BY name COLLATE NOCASE").all() as any[];
    return rows.map(mapProviderConnection);
  }

  getProviderConnection(id: string): ProviderConnection | null {
    const row = this.db.prepare("SELECT * FROM provider_connections WHERE id = ?").get(id) as any;
    return row ? mapProviderConnection(row) : null;
  }

  saveProviderConnection(connection: ProviderConnection): ProviderConnection {
    this.db
      .prepare(
        `INSERT INTO provider_connections (
          id, name, provider, base_url, api_version, api_key_hint, secret_ref, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          provider = excluded.provider,
          base_url = excluded.base_url,
          api_version = excluded.api_version,
          api_key_hint = excluded.api_key_hint,
          secret_ref = excluded.secret_ref,
          updated_at = excluded.updated_at`
      )
      .run(
        connection.id,
        connection.name,
        connection.provider,
        connection.baseUrl ?? null,
        connection.apiVersion ?? null,
        connection.apiKeyHint ?? null,
        connection.secretRef,
        connection.createdAt,
        connection.updatedAt
      );
    return connection;
  }

  listProviderModels(connectionId?: string): ProviderModel[] {
    const rows = connectionId
      ? (this.db
          .prepare("SELECT * FROM provider_models WHERE connection_id = ? ORDER BY display_name COLLATE NOCASE")
          .all(connectionId) as any[])
      : (this.db.prepare("SELECT * FROM provider_models ORDER BY display_name COLLATE NOCASE").all() as any[]);
    return rows.map(mapProviderModel);
  }

  getProviderModel(id: string): ProviderModel | null {
    const row = this.db.prepare("SELECT * FROM provider_models WHERE id = ?").get(id) as any;
    return row ? mapProviderModel(row) : null;
  }

  replaceProviderModels(connectionId: string, models: ProviderModel[]) {
    const clear = this.db.prepare("DELETE FROM provider_models WHERE connection_id = ?");
    const insert = this.db.prepare(
      `INSERT INTO provider_models (
        id, connection_id, provider, model_id, display_name, supports_chat, supports_embedding, supports_vision, deployment, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const transaction = this.db.transaction(() => {
      clear.run(connectionId);
      for (const model of models) {
        insert.run(
          model.id,
          model.connectionId,
          model.provider,
          model.modelId,
          model.displayName,
          model.supportsChat ? 1 : 0,
          model.supportsEmbedding ? 1 : 0,
          model.supportsVision ? 1 : 0,
          model.deployment ?? null,
          model.metadata ?? null,
          model.createdAt,
          model.updatedAt
        );
      }
    });

    transaction();
  }

  listProviderDefaults(): ProviderDefaults[] {
    const rows = this.db
      .prepare("SELECT * FROM provider_default_models ORDER BY connection_id COLLATE NOCASE")
      .all() as Array<{
      connection_id: string;
      default_chat_model_id: string | null;
      default_embedding_model_id: string | null;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      connectionId: row.connection_id,
      defaultChatModelId: row.default_chat_model_id,
      defaultEmbeddingModelId: row.default_embedding_model_id,
      updatedAt: row.updated_at
    }));
  }

  getProviderDefaults(connectionId: string): ProviderDefaults | null {
    const row = this.db.prepare("SELECT * FROM provider_default_models WHERE connection_id = ?").get(connectionId) as
      | {
          connection_id: string;
          default_chat_model_id: string | null;
          default_embedding_model_id: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      connectionId: row.connection_id,
      defaultChatModelId: row.default_chat_model_id,
      defaultEmbeddingModelId: row.default_embedding_model_id,
      updatedAt: row.updated_at
    };
  }

  saveProviderDefaults(defaults: ProviderDefaults) {
    this.db
      .prepare(
        `INSERT INTO provider_default_models (
          connection_id, default_chat_model_id, default_embedding_model_id, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
          default_chat_model_id = excluded.default_chat_model_id,
          default_embedding_model_id = excluded.default_embedding_model_id,
          updated_at = excluded.updated_at`
      )
      .run(
        defaults.connectionId,
        defaults.defaultChatModelId,
        defaults.defaultEmbeddingModelId,
        defaults.updatedAt
      );
  }

  resetAllAppData() {
    const statements = [
      "DELETE FROM messages",
      "DELETE FROM threads",
      "DELETE FROM indexed_files",
      "DELETE FROM channels",
      "DELETE FROM provider_default_models",
      "DELETE FROM provider_models",
      "DELETE FROM provider_connections",
      "DELETE FROM provider_profiles",
      "DELETE FROM app_settings"
    ].map((sql) => this.db.prepare(sql));

    const transaction = this.db.transaction(() => {
      for (const statement of statements) {
        statement.run();
      }
    });

    transaction();
  }

  listThreads(channelId: string): Thread[] {
    return (this.db
      .prepare("SELECT * FROM threads WHERE channel_id = ? ORDER BY updated_at DESC")
      .all(channelId) as any[]).map(mapThread);
  }

  getThread(id: string): Thread | null {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as any;
    return row ? mapThread(row) : null;
  }

  createThread(thread: Thread): Thread {
    this.db
      .prepare("INSERT INTO threads (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(thread.id, thread.channelId, thread.title, thread.createdAt, thread.updatedAt);
    return thread;
  }

  updateThreadTitle(id: string, title: string) {
    this.db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, id);
  }

  deleteThread(id: string) {
    const deleteMessages = this.db.prepare("DELETE FROM messages WHERE thread_id = ?");
    const deleteThread = this.db.prepare("DELETE FROM threads WHERE id = ?");

    const transaction = this.db.transaction(() => {
      deleteMessages.run(id);
      deleteThread.run(id);
    });

    transaction();
  }

  touchThread(id: string, updatedAt: string) {
    this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(updatedAt, id);
  }

  listMessages(threadId: string): Message[] {
    return (this.db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC").all(threadId) as any[]).map(
      mapMessage
    );
  }

  createMessage(message: Message) {
    this.db
      .prepare("INSERT INTO messages (id, thread_id, role, content, citations_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(message.id, message.threadId, message.role, message.content, JSON.stringify(message.citations), message.createdAt);
  }

  replaceIndexedFiles(channelId: string, files: IndexedFileRecord[]) {
    const clear = this.db.prepare("DELETE FROM indexed_files WHERE channel_id = ?");
    const insert = this.db.prepare(
      `INSERT INTO indexed_files (
        channel_id, relative_path, status, size, mtime, parser, chunks, content_hash, error_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const transaction = this.db.transaction(() => {
      clear.run(channelId);
      for (const file of files) {
        insert.run(
          channelId,
          file.relativePath,
          file.status,
          file.size,
          file.mtime,
          file.parser,
          file.chunks,
          file.contentHash ?? null,
          file.errorReason ?? null
        );
      }
    });

    transaction();
  }

  listChannelFiles(channelId: string, status: FileIndexStatus): IndexedFileRecord[] {
    return (this.db
      .prepare("SELECT * FROM indexed_files WHERE channel_id = ? AND status = ? ORDER BY relative_path COLLATE NOCASE")
      .all(channelId, status) as any[]).map(mapIndexedFile);
  }

  getChannelSnapshot(channelId: string): ChannelSnapshot {
    const channel = this.getChannel(channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} not found.`);
    }

    return {
      channel,
      threads: this.listThreads(channelId),
      indexedFiles: this.listChannelFiles(channelId, "indexed"),
      failedFiles: this.listChannelFiles(channelId, "failed")
    };
  }
}

function mapChannel(row: any): Channel {
  return {
    id: row.id,
    displayName: row.display_name,
    rootPath: row.root_path,
    indexPath: row.index_path,
    preferredConnectionId: row.preferred_connection_id ?? null,
    chatModelId: row.chat_model_id ?? null,
    embeddingModelId: row.embedding_model_id ?? null,
    retrievalMode: row.retrieval_mode ?? "vector",
    systemPrompt: row.system_prompt ?? "",
    lastIndexedAt: row.last_indexed_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapProviderConnection(row: any): ProviderConnection {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.base_url ?? undefined,
    apiVersion: row.api_version ?? undefined,
    apiKeyHint: row.api_key_hint ?? undefined,
    secretRef: row.secret_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapProviderModel(row: any): ProviderModel {
  return {
    id: row.id,
    connectionId: row.connection_id,
    provider: row.provider,
    modelId: row.model_id,
    displayName: row.display_name,
    supportsChat: Boolean(row.supports_chat),
    supportsEmbedding: Boolean(row.supports_embedding),
    supportsVision: Boolean(row.supports_vision),
    deployment: row.deployment ?? undefined,
    metadata: row.metadata_json ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapThread(row: any): Thread {
  return {
    id: row.id,
    channelId: row.channel_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMessage(row: any): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    citations: JSON.parse(row.citations_json),
    createdAt: row.created_at
  };
}

function mapIndexedFile(row: any): IndexedFileRecord {
  return {
    relativePath: row.relative_path,
    status: row.status,
    size: row.size,
    mtime: row.mtime,
    parser: row.parser,
    chunks: row.chunks,
    contentHash: row.content_hash ?? undefined,
    errorReason: row.error_reason ?? undefined
  };
}
