export const INDEX_DIR_NAME = ".fschat-index";
export const INDEX_VERSION = 2;

export type ChannelStatus = "ready" | "indexing" | "stale" | "error" | "idle";
export type FileIndexStatus = "indexed" | "failed";
export type ProviderKind = "openai" | "azure-openai" | "anthropic" | "google" | "ollama";
export type ModelCapability = "chat" | "embedding" | "vision";

export interface ProviderConnection {
  id: string;
  name: string;
  provider: ProviderKind;
  baseUrl?: string;
  apiVersion?: string;
  apiKeyHint?: string;
  secretRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderDefaults {
  connectionId: string;
  defaultChatModelId: string | null;
  defaultEmbeddingModelId: string | null;
  updatedAt: string;
}

export interface ProviderModel {
  id: string;
  connectionId: string;
  provider: ProviderKind;
  modelId: string;
  displayName: string;
  supportsChat: boolean;
  supportsEmbedding: boolean;
  supportsVision: boolean;
  deployment?: string;
  metadata?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Channel {
  id: string;
  displayName: string;
  rootPath: string;
  indexPath: string;
  preferredConnectionId: string | null;
  chatModelId: string | null;
  embeddingModelId: string | null;
  lastIndexedAt: string | null;
  status: ChannelStatus;
  createdAt: string;
  updatedAt: string;
}

export interface IndexedFileRecord {
  relativePath: string;
  status: FileIndexStatus;
  size: number;
  mtime: number;
  parser: string;
  chunks: number;
  contentHash?: string;
  errorReason?: string;
}

export interface Citation {
  relativePath: string;
  chunkId: string;
  score: number;
  snippet: string;
}

export interface Thread {
  id: string;
  channelId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string;
  citations: Citation[];
  createdAt: string;
}

export interface ChannelSnapshot {
  channel: Channel;
  threads: Thread[];
  indexedFiles: IndexedFileRecord[];
  failedFiles: IndexedFileRecord[];
}

export interface IndexManifest {
  version: number;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  files: IndexedFileRecord[];
  chunkCount: number;
  embeddingDimension: number;
  embeddingModelKey?: string;
}

export interface IndexProgressEvent {
  channelId: string;
  phase: "discovering" | "extracting" | "embedding" | "writing" | "completed" | "cancelled" | "error";
  totalFiles: number;
  processedFiles: number;
  successCount: number;
  failureCount: number;
  currentFile?: string;
  message?: string;
}

export interface IndexFileUpdateEvent {
  channelId: string;
  file: IndexedFileRecord;
}

export interface SearchResult {
  chunkId: string;
  relativePath: string;
  score: number;
  snippet: string;
  text: string;
}

export interface WorkerSearchResponse {
  results: SearchResult[];
}

export interface ConnectProviderInput {
  provider: ProviderKind;
  apiKey?: string;
  connectionName?: string;
}

export interface ConnectProviderResult {
  connection: ProviderConnection;
  models: ProviderModel[];
  warnings: string[];
}

export interface RefreshProviderModelsResult {
  connection: ProviderConnection;
  models: ProviderModel[];
  warnings: string[];
}

export interface BootstrapResponse {
  channels: Channel[];
  providerConnections: ProviderConnection[];
  providerDefaults: ProviderDefaults[];
  providerModels: ProviderModel[];
}

export interface RegisterChannelInput {
  rootPath: string;
  displayName: string;
  preferredConnectionId: string | null;
  chatModelId: string | null;
  embeddingModelId: string | null;
}

export interface UpdateChannelModelsInput {
  channelId: string;
  preferredConnectionId: string | null;
  chatModelId: string | null;
  embeddingModelId: string | null;
}

export interface CancelIndexInput {
  channelId: string;
  retainPartial: boolean;
}

export interface SendMessageInput {
  channelId: string;
  threadId?: string | null;
  message: string;
}

export interface SendMessageResult {
  thread: Thread;
  userMessage: Message;
  assistantMessage: Message;
}

export interface WorkerBuildOptions {
  embeddingProvider?: {
    provider: ProviderKind;
    baseUrl?: string;
    apiVersion?: string;
    apiKey?: string;
    model?: string;
    deployment?: string;
  };
}

export interface WorkerBuildResponse {
  manifest: IndexManifest | null;
  files: IndexedFileRecord[];
  cancelled?: boolean;
  retainedPartial?: boolean;
}

export interface WorkerEnvelope<TPayload = unknown> {
  id?: string;
  type: "request" | "response" | "event";
  method?: string;
  ok?: boolean;
  payload?: TPayload;
  error?: string;
}
