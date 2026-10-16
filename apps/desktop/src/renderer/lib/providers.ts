import type {
  AppSettings,
  Channel,
  ProviderConnection,
  ProviderDefaults,
  ProviderKind,
  ProviderModel,
  RetrievalMode
} from "@fschat/shared";

export const PROVIDER_LABEL: Record<ProviderKind, string> = {
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  "azure-openai": "Azure OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  ollama: "Ollama",
  openrouter: "OpenRouter"
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Mirrors isLocalConnection() in the main process: only an Ollama endpoint on this computer is "local". */
export function isLocalConnection(connection: ProviderConnection | null | undefined) {
  if (!connection || connection.provider !== "ollama") return false;
  if (!connection.baseUrl) return true;
  try {
    return LOCAL_HOSTNAMES.has(new URL(connection.baseUrl).hostname);
  } catch {
    return false;
  }
}

export function connectionDestinationLabel(connection: ProviderConnection) {
  if (connection.provider === "ollama") {
    return isLocalConnection(connection) ? "Ollama (this computer)" : "Ollama (remote server)";
  }
  return PROVIDER_LABEL[connection.provider];
}

/** Codex is chat-only in this app, so channels that chat through it must use keyword search. */
export function requiresKeywordSearch(connection: ProviderConnection | null | undefined) {
  return connection?.provider === "openai-codex";
}

export function isConnectionAllowed(connection: ProviderConnection | null | undefined, settings: AppSettings) {
  if (!connection) return false;
  return settings.dataPolicy !== "local-only" || isLocalConnection(connection);
}

export interface ModelLookup {
  modelById: Record<string, ProviderModel>;
  connectionById: Record<string, ProviderConnection>;
}

export function buildLookup(models: ProviderModel[], connections: ProviderConnection[]): ModelLookup {
  return {
    modelById: Object.fromEntries(models.map((model) => [model.id, model])),
    connectionById: Object.fromEntries(connections.map((connection) => [connection.id, connection]))
  };
}

export interface DataDestination {
  /** Connection used for answering questions. */
  chatConnection: ProviderConnection | null;
  chatModel: ProviderModel | null;
  /** Connection used to embed file text during indexing (semantic search only). */
  embeddingConnection: ProviderConnection | null;
  embeddingModel: ProviderModel | null;
  /** Connections that receive content and are not on this computer. */
  external: ProviderConnection[];
  /** Connections blocked by local-only mode. */
  blocked: ProviderConnection[];
  tone: "local" | "external" | "blocked" | "unset";
  label: string;
  detail: string;
}

export function describeDataDestination(
  selection: { chatModelId: string | null; embeddingModelId: string | null; retrievalMode: RetrievalMode; preferredConnectionId?: string | null },
  lookup: ModelLookup,
  settings: AppSettings
): DataDestination {
  const chatModel = selection.chatModelId ? lookup.modelById[selection.chatModelId] ?? null : null;
  const chatConnection =
    (chatModel ? lookup.connectionById[chatModel.connectionId] : null) ??
    (selection.preferredConnectionId ? lookup.connectionById[selection.preferredConnectionId] ?? null : null);
  const embeddingModel =
    selection.retrievalMode === "vector" && selection.embeddingModelId ? lookup.modelById[selection.embeddingModelId] ?? null : null;
  const embeddingConnection = embeddingModel ? lookup.connectionById[embeddingModel.connectionId] ?? null : null;

  const used = uniqueConnections([chatConnection, embeddingConnection]);
  const external = used.filter((connection) => !isLocalConnection(connection));
  const blocked = settings.dataPolicy === "local-only" ? external : [];

  const parts: string[] = [];
  if (chatConnection) {
    parts.push(
      isLocalConnection(chatConnection)
        ? "Questions and matching file excerpts are answered by a model on this computer."
        : `Your questions and matching file excerpts are sent to ${connectionDestinationLabel(chatConnection)} to write answers.`
    );
  }
  if (selection.retrievalMode === "vector" && embeddingConnection) {
    parts.push(
      isLocalConnection(embeddingConnection)
        ? "File text is processed on this computer while indexing."
        : `File text is sent to ${connectionDestinationLabel(embeddingConnection)} while indexing (semantic search).`
    );
  } else if (selection.retrievalMode === "vectorless") {
    parts.push("Keyword search: nothing is sent while indexing.");
  }

  if (!chatConnection) {
    return { chatConnection, chatModel, embeddingConnection, embeddingModel, external, blocked, tone: "unset", label: "No model selected", detail: "Choose a chat model in this knowledge base's settings." };
  }
  if (blocked.length > 0) {
    return {
      chatConnection, chatModel, embeddingConnection, embeddingModel, external, blocked,
      tone: "blocked",
      label: "Blocked by Local-only mode",
      detail: `${parts.join(" ")} Local-only mode is on, so ${joinNames(blocked.map(connectionDestinationLabel))} can't be used. Pick local models or change the privacy setting.`
    };
  }
  if (external.length > 0) {
    return {
      chatConnection, chatModel, embeddingConnection, embeddingModel, external, blocked,
      tone: "external",
      label: `Sends excerpts to ${joinNames(uniqueStrings(external.map(connectionDestinationLabel)))}`,
      detail: parts.join(" ")
    };
  }
  return {
    chatConnection, chatModel, embeddingConnection, embeddingModel, external, blocked,
    tone: "local",
    label: "Local · Ollama",
    detail: `${parts.join(" ")} Nothing leaves this computer.`
  };
}

export function describeChannelDestination(channel: Channel, lookup: ModelLookup, settings: AppSettings) {
  return describeDataDestination(channel, lookup, settings);
}

export function modelsForCapability(models: ProviderModel[], capability: "chat" | "embedding") {
  return models.filter((model) => (capability === "chat" ? model.supportsChat : model.supportsEmbedding));
}

/** Initial chat / embedding picks for a new knowledge base, honouring saved provider defaults and the data policy. */
export function pickInitialModels(
  connections: ProviderConnection[],
  defaults: ProviderDefaults[],
  models: ProviderModel[],
  settings: AppSettings
) {
  const allowed = connections.filter((connection) => isConnectionAllowed(connection, settings));
  const allowedIds = new Set(allowed.map((connection) => connection.id));
  const defaultFor = (kind: "chat" | "embedding") => {
    for (const item of defaults) {
      if (!allowedIds.has(item.connectionId)) continue;
      const id = kind === "chat" ? item.defaultChatModelId : item.defaultEmbeddingModelId;
      if (id && models.some((model) => model.id === id)) return id;
    }
    const fallback = models.find(
      (model) => allowedIds.has(model.connectionId) && (kind === "chat" ? model.supportsChat : model.supportsEmbedding)
    );
    return fallback?.id ?? null;
  };
  return { chatModelId: defaultFor("chat"), embeddingModelId: defaultFor("embedding") };
}

/** Knowledge bases whose models depend on the given connection. */
export function channelsUsingConnection(channels: Channel[], connectionId: string, lookup: ModelLookup) {
  return channels.filter((channel) => {
    if (channel.preferredConnectionId === connectionId) return true;
    const chat = channel.chatModelId ? lookup.modelById[channel.chatModelId] : undefined;
    const embedding = channel.embeddingModelId ? lookup.modelById[channel.embeddingModelId] : undefined;
    return chat?.connectionId === connectionId || embedding?.connectionId === connectionId;
  });
}

function uniqueConnections(items: Array<ProviderConnection | null>) {
  const seen = new Map<string, ProviderConnection>();
  for (const item of items) {
    if (item && !seen.has(item.id)) seen.set(item.id, item);
  }
  return [...seen.values()];
}

function uniqueStrings(items: string[]) {
  return [...new Set(items)];
}

function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
