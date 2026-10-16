/**
 * Typed view of `window.fsChat` (apps/desktop/src/preload/index.ts).
 *
 * The preload's `api` object is not exported and imports Electron, so it can't be referenced from the
 * renderer bundle. Keep this interface in sync with the preload by hand; several preload methods are
 * untyped (`ipcRenderer.invoke` returns `any`), so this file is also where their return types are pinned.
 */
import type {
  AppSettings,
  BootstrapResponse,
  CancelIndexInput,
  Channel,
  ChannelSnapshot,
  ConnectProviderInput,
  ConnectProviderResult,
  CreateThreadInput,
  DeleteChannelInput,
  FileIndexStatus,
  IndexFileUpdateEvent,
  IndexProgressEvent,
  IndexedFileRecord,
  Message,
  OpenChannelFileInput,
  ProviderDefaults,
  RefreshProviderModelsResult,
  RegisterChannelInput,
  SendMessageInput,
  SendMessageResult,
  Thread,
  UpdateChannelModelsInput,
  UpdateChannelSettingsInput,
  UpdateChannelSystemPromptInput,
  UpdateThreadTitleInput
} from "@fschat/shared";

export interface RootFolderInspection {
  rootPath: string;
  indexPath: string;
  defaultDisplayName: string;
  hasExistingIndex: boolean;
  existingChannel: Channel | null;
}

export interface FsChatApi {
  rendererReady: () => void;
  bootstrap: () => Promise<BootstrapResponse>;
  selectRootFolder: () => Promise<string | null>;
  inspectRootFolder: (rootPath: string) => Promise<RootFolderInspection>;
  connectProvider: (input: ConnectProviderInput) => Promise<ConnectProviderResult>;
  resetAppData: () => Promise<void>;
  updateAppSettings: (settings: AppSettings) => Promise<AppSettings>;
  deleteProviderConnection: (connectionId: string) => Promise<void>;
  updateChannelSettings: (input: UpdateChannelSettingsInput) => Promise<ChannelSnapshot>;
  refreshProviderModels: (connectionId: string) => Promise<RefreshProviderModelsResult>;
  saveProviderDefaults: (
    connectionId: string,
    chatModelId: string | null,
    embeddingModelId: string | null
  ) => Promise<ProviderDefaults>;
  registerChannel: (input: RegisterChannelInput) => Promise<ChannelSnapshot>;
  updateChannelModels: (input: UpdateChannelModelsInput) => Promise<ChannelSnapshot>;
  updateChannelSystemPrompt: (input: UpdateChannelSystemPromptInput) => Promise<ChannelSnapshot>;
  deleteChannel: (input: DeleteChannelInput) => Promise<void>;
  loadChannel: (channelId: string) => Promise<ChannelSnapshot>;
  /** Incremental sync ("Sync now"). Resolves when the run finishes. */
  startIndex: (channelId: string) => Promise<ChannelSnapshot>;
  /** Full rebuild ("Rebuild from scratch"). Resolves when the run finishes. */
  regenerateIndex: (channelId: string) => Promise<ChannelSnapshot>;
  cancelIndex: (input: CancelIndexInput) => Promise<void>;
  listChannelFiles: (channelId: string, status: FileIndexStatus) => Promise<IndexedFileRecord[]>;
  createThread: (input: CreateThreadInput) => Promise<Thread>;
  updateThreadTitle: (input: UpdateThreadTitleInput) => Promise<Thread>;
  deleteThread: (threadId: string) => Promise<ChannelSnapshot>;
  openChannelFile: (input: OpenChannelFileInput) => Promise<void>;
  revealChannelFile: (input: OpenChannelFileInput) => Promise<void>;
  openChannelFolder: (channelId: string) => Promise<void>;
  getThreadMessages: (threadId: string) => Promise<Message[]>;
  sendMessage: (input: SendMessageInput) => Promise<SendMessageResult>;
  openExternalUrl: (url: string) => Promise<void>;
  onIndexProgress: (listener: (payload: IndexProgressEvent) => void) => () => void;
  onIndexFileUpdate: (listener: (payload: IndexFileUpdateEvent) => void) => () => void;
  onChannelRefreshed: (listener: (payload: ChannelSnapshot) => void) => () => void;
}

declare global {
  interface Window {
    fsChat: FsChatApi;
  }
}
