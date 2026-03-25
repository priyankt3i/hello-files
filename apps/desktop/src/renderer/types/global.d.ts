import type {
  BootstrapResponse,
  CancelIndexInput,
  Channel,
  ChannelSnapshot,
  CreateThreadInput,
  ConnectProviderInput,
  ConnectProviderResult,
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
  UpdateChannelSystemPromptInput,
  UpdateThreadTitleInput,
  UpdateChannelModelsInput
} from "@fschat/shared";

declare global {
  interface Window {
    fsChat: {
      bootstrap: () => Promise<BootstrapResponse>;
      selectRootFolder: () => Promise<string | null>;
      inspectRootFolder: (rootPath: string) => Promise<{
        rootPath: string;
        indexPath: string;
        defaultDisplayName: string;
        hasExistingIndex: boolean;
        existingChannel: Channel | null;
      }>;
      connectProvider: (input: ConnectProviderInput) => Promise<ConnectProviderResult>;
      resetAppData: () => Promise<void>;
      refreshProviderModels: (connectionId: string) => Promise<RefreshProviderModelsResult>;
      saveProviderDefaults: (
        connectionId: string,
        chatModelId: string | null,
        embeddingModelId: string | null
      ) => Promise<ProviderDefaults>;
      registerChannel: (input: RegisterChannelInput) => Promise<ChannelSnapshot>;
      updateChannelModels: (input: UpdateChannelModelsInput) => Promise<ChannelSnapshot>;
      updateChannelSystemPrompt: (input: UpdateChannelSystemPromptInput) => Promise<ChannelSnapshot>;
      deleteChannel: (channelId: string) => Promise<void>;
      loadChannel: (channelId: string) => Promise<ChannelSnapshot>;
      startIndex: (channelId: string) => Promise<ChannelSnapshot>;
      regenerateIndex: (channelId: string) => Promise<ChannelSnapshot>;
      cancelIndex: (input: CancelIndexInput) => Promise<void>;
      listChannelFiles: (channelId: string, status: FileIndexStatus) => Promise<IndexedFileRecord[]>;
      createThread: (input: CreateThreadInput) => Promise<Thread>;
      updateThreadTitle: (input: UpdateThreadTitleInput) => Promise<Thread>;
      deleteThread: (threadId: string) => Promise<ChannelSnapshot>;
      openChannelFile: (input: OpenChannelFileInput) => Promise<void>;
      revealChannelFile: (input: OpenChannelFileInput) => Promise<void>;
      getThreadMessages: (threadId: string) => Promise<Message[]>;
      sendMessage: (input: SendMessageInput) => Promise<SendMessageResult>;
      openExternalUrl: (url: string) => Promise<void>;
      onIndexProgress: (listener: (payload: IndexProgressEvent) => void) => () => void;
      onIndexFileUpdate: (listener: (payload: IndexFileUpdateEvent) => void) => () => void;
      onChannelRefreshed: (listener: (payload: ChannelSnapshot) => void) => () => void;
    };
  }
}

export {};
