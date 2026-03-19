import type {
  BootstrapResponse,
  CancelIndexInput,
  Channel,
  ChannelSnapshot,
  ConnectProviderInput,
  ConnectProviderResult,
  FileIndexStatus,
  IndexFileUpdateEvent,
  IndexProgressEvent,
  IndexedFileRecord,
  Message,
  ProviderDefaults,
  RefreshProviderModelsResult,
  RegisterChannelInput,
  SendMessageInput,
  SendMessageResult,
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
      deleteChannel: (channelId: string) => Promise<void>;
      loadChannel: (channelId: string) => Promise<ChannelSnapshot>;
      startIndex: (channelId: string) => Promise<ChannelSnapshot>;
      regenerateIndex: (channelId: string) => Promise<ChannelSnapshot>;
      cancelIndex: (input: CancelIndexInput) => Promise<void>;
      listChannelFiles: (channelId: string, status: FileIndexStatus) => Promise<IndexedFileRecord[]>;
      getThreadMessages: (threadId: string) => Promise<Message[]>;
      sendMessage: (input: SendMessageInput) => Promise<SendMessageResult>;
      onIndexProgress: (listener: (payload: IndexProgressEvent) => void) => () => void;
      onIndexFileUpdate: (listener: (payload: IndexFileUpdateEvent) => void) => () => void;
      onChannelRefreshed: (listener: (payload: ChannelSnapshot) => void) => () => void;
    };
  }
}

export {};
