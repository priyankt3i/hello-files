export const INDEX_DIR_NAME = ".fschat-index";
export const INDEX_VERSION = 3;

export type ChannelStatus = "ready" | "indexing" | "stale" | "error" | "idle";
export type FileIndexStatus = "indexed" | "failed" | "skipped";
export type ProviderKind = "openai" | "openai-codex" | "azure-openai" | "anthropic" | "google" | "ollama";
export type ModelCapability = "chat" | "embedding" | "vision";
export type RetrievalMode = "vector" | "vectorless";
export type DataPolicy = "any" | "local-only";

export const DEFAULT_MAX_FILE_SIZE_MB = 50;

export interface AppSettings {
  /** "local-only" blocks every provider connection that is not a local Ollama endpoint. */
  dataPolicy: DataPolicy;
}

export interface AppFeatures {
  /** OpenAI Codex sign-in is hidden unless HELLO_FILES_ENABLE_CODEX=1. */
  codexEnabled: boolean;
}

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
  retrievalMode: RetrievalMode;
  systemPrompt: string;
  autoSync: boolean;
  excludePatterns: string[];
  lastIndexedAt: string | null;
  lastIndexStats: IndexBuildStats | null;
  lastError: string | null;
  status: ChannelStatus;
  createdAt: string;
  updatedAt: string;
}

export interface IndexBuildStats {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  failed: number;
  skipped: number;
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

export interface IndexedDocumentRecord {
  documentId: string;
  relativePath: string;
  parser: string;
  size: number;
  mtime: number;
  chunks: number;
  tokenEstimate: number;
  summary: string;
  sectionHints: string[];
  contentHash?: string;
  structure?: IndexedDocumentStructure;
  visualAssetSummary?: IndexedDocumentVisualSummary;
  visualAssets?: VisualAssetReference[];
}

export interface IndexedSheetProfile {
  name: string;
  rowCount: number;
  columnCount: number;
  headerHints: string[];
}

export interface IndexedDocumentStructure {
  kind: "spreadsheet";
  sheetCount: number;
  rowCount: number;
  sheetNames: string[];
  columnHints: string[];
  sheets?: IndexedSheetProfile[];
}

export interface Citation {
  relativePath: string;
  chunkId: string;
  score: number;
  snippet: string;
}

export type VisualAssetKind = "pdf-page" | "pdf-image" | "docx-image" | "image-file";

export interface IndexedDocumentVisualSummary {
  total: number;
  byKind: Partial<Record<VisualAssetKind, number>>;
  pages: number[];
  labels: string[];
}

export interface VisualAssetReference {
  kind: VisualAssetKind;
  relativePath: string;
  label: string;
  anchorText?: string;
  pageNumber?: number;
  imageIndex?: number;
  mediaPath?: string;
  width?: number;
  height?: number;
  mimeType?: string;
}

export interface ResolvedVisualAsset {
  asset: VisualAssetReference;
  mimeType: string;
  dataBase64: string;
}

export interface Thread {
  id: string;
  channelId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** How an exact spreadsheet answer was computed. Shown in a collapsed "How this was calculated" detail. */
export interface MessageCalculation {
  /** The read-only SELECT that produced the numbers (sanitised, length-capped). */
  sql: string;
  /** Human-readable sheet labels the query read, e.g. "claims.xlsx > Claims". */
  sheets: string[];
}

export interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string;
  citations: Citation[];
  /** Present only when the answer's numbers were calculated exactly from spreadsheet data. */
  calculation?: MessageCalculation;
  createdAt: string;
}

export interface ChannelSnapshot {
  channel: Channel;
  threads: Thread[];
  indexedFiles: IndexedFileRecord[];
  failedFiles: IndexedFileRecord[];
  skippedFiles: IndexedFileRecord[];
}

export interface IndexManifest {
  version: number;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  files: IndexedFileRecord[];
  chunkCount: number;
  documentCount?: number;
  retrievalMode: RetrievalMode;
  indexEngine?: string;
  embeddingDimension?: number;
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
  chunkType?: string;
  sheetName?: string;
  rowNumber?: number;
  visualAssets?: VisualAssetReference[];
}

export interface WorkerSearchResponse {
  results: SearchResult[];
}

export interface WorkerDocumentsResponse {
  documents: IndexedDocumentRecord[];
}

export type SpreadsheetColumnType = "integer" | "real" | "text" | "date";

export interface SpreadsheetColumnSchema {
  /** Sanitised SQL column name. */
  name: string;
  /** Header text as it appears in the sheet. */
  original: string;
  type: SpreadsheetColumnType;
  nonNull: number;
  /** Text companion column holding cells that could not be read as numbers/dates. */
  rawColumn?: string;
  coerceFailures?: number;
  /** Distinct values of a low-cardinality text column. */
  values?: string[];
}

export interface SpreadsheetSheetSchema {
  sheet: string;
  /** Stable, sanitised SQL table name. */
  table: string;
  rowCount: number;
  headerRow: number | null;
  columns: SpreadsheetColumnSchema[];
  /** Up to 3 rows, aligned with `columns`. */
  sampleRows: unknown[][];
}

export interface WorkerSpreadsheetSchemaResponse {
  documents: Array<{ document: string; sheets: SpreadsheetSheetSchema[] }>;
  skipped: Array<{ document: string; reason: string }>;
  truncatedDocuments: boolean;
}

export interface SpreadsheetTableRef {
  document: string;
  sheet: string;
  table: string;
}

export interface WorkerSpreadsheetQueryResponse {
  columns: string[];
  rows: unknown[][];
  /** Rows returned (not the size of the full result when `truncated`). */
  rowCount: number;
  truncated: boolean;
  tablesUsed: SpreadsheetTableRef[];
  skipped?: Array<{ document: string; reason: string }>;
  sql: string;
}

export interface ConnectProviderInput {
  provider: ProviderKind;
  apiKey?: string;
  connectionName?: string;
  /** Azure OpenAI: resource endpoint (required). Ollama: server address (optional, defaults to http://127.0.0.1:11434). */
  baseUrl?: string;
  /** Azure OpenAI only. */
  apiVersion?: string;
  /** Azure OpenAI only: deployment names, since Azure has no model discovery. */
  azureChatDeployment?: string;
  azureEmbeddingDeployment?: string;
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
  /** Every chat thread, across all knowledge bases (for the sidebar). */
  threads: Thread[];
  settings: AppSettings;
  features: AppFeatures;
  defaults: {
    /** The assistant instructions a new knowledge base starts with. */
    systemPrompt: string;
  };
  /** Directory that holds every channel's search index. */
  indexStorageDir: string;
}

export interface RegisterChannelInput {
  rootPath: string;
  displayName: string;
  preferredConnectionId: string | null;
  chatModelId: string | null;
  embeddingModelId: string | null;
  retrievalMode?: RetrievalMode;
  systemPrompt?: string;
  autoSync?: boolean;
  excludePatterns?: string[];
}

export interface UpdateChannelModelsInput {
  channelId: string;
  preferredConnectionId: string | null;
  chatModelId: string | null;
  embeddingModelId: string | null;
  retrievalMode?: RetrievalMode;
}

export interface UpdateChannelSettingsInput {
  channelId: string;
  displayName?: string;
  autoSync?: boolean;
  excludePatterns?: string[];
}

export interface UpdateChannelSystemPromptInput {
  channelId: string;
  systemPrompt: string;
}

export interface CreateThreadInput {
  channelId: string;
  title?: string | null;
}

export interface UpdateThreadTitleInput {
  threadId: string;
  title: string;
}

export interface OpenChannelFileInput {
  channelId: string;
  relativePath: string;
}

export interface CancelIndexInput {
  channelId: string;
  retainPartial: boolean;
}

export interface DeleteChannelInput {
  channelId: string;
  removeIndex?: boolean;
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
  excludePatterns?: string[];
  maxFileSizeMb?: number;
  includeHidden?: boolean;
  retrieval?: {
    mode: RetrievalMode;
    engine?: string;
    documentIds?: string[];
  };
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
  stats?: IndexBuildStats;
}

export interface WorkerEnvelope<TPayload = unknown> {
  id?: string;
  type: "request" | "response" | "event";
  method?: string;
  ok?: boolean;
  payload?: TPayload;
  error?: string;
}
