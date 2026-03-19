import { contextBridge, ipcRenderer } from "electron";
import type {
  CancelIndexInput,
  BootstrapResponse,
  ChannelSnapshot,
  ConnectProviderInput,
  ConnectProviderResult,
  FileIndexStatus,
  IndexFileUpdateEvent,
  IndexProgressEvent,
  RegisterChannelInput,
  ProviderDefaults,
  RefreshProviderModelsResult,
  SendMessageInput,
  UpdateChannelModelsInput
} from "@fschat/shared";

const api = {
  bootstrap: (): Promise<BootstrapResponse> => ipcRenderer.invoke("fschat:bootstrap"),
  selectRootFolder: () => ipcRenderer.invoke("fschat:select-root-folder"),
  inspectRootFolder: (rootPath: string) => ipcRenderer.invoke("fschat:inspect-root-folder", rootPath),
  connectProvider: (input: ConnectProviderInput): Promise<ConnectProviderResult> =>
    ipcRenderer.invoke("fschat:connect-provider", input),
  resetAppData: (): Promise<void> => ipcRenderer.invoke("fschat:reset-app-data"),
  refreshProviderModels: (connectionId: string): Promise<RefreshProviderModelsResult> =>
    ipcRenderer.invoke("fschat:refresh-provider-models", connectionId),
  saveProviderDefaults: (
    connectionId: string,
    chatModelId: string | null,
    embeddingModelId: string | null
  ): Promise<ProviderDefaults> =>
    ipcRenderer.invoke("fschat:save-provider-defaults", connectionId, chatModelId, embeddingModelId),
  registerChannel: (input: RegisterChannelInput): Promise<ChannelSnapshot> => ipcRenderer.invoke("fschat:register-channel", input),
  updateChannelModels: (input: UpdateChannelModelsInput): Promise<ChannelSnapshot> => ipcRenderer.invoke("fschat:update-channel-models", input),
  deleteChannel: (channelId: string) => ipcRenderer.invoke("fschat:delete-channel", channelId),
  loadChannel: (channelId: string): Promise<ChannelSnapshot> => ipcRenderer.invoke("fschat:load-channel", channelId),
  startIndex: (channelId: string) => ipcRenderer.invoke("fschat:start-index", channelId),
  regenerateIndex: (channelId: string) => ipcRenderer.invoke("fschat:regenerate-index", channelId),
  cancelIndex: (input: CancelIndexInput) => ipcRenderer.invoke("fschat:cancel-index", input),
  listChannelFiles: (channelId: string, status: FileIndexStatus) =>
    ipcRenderer.invoke("fschat:list-channel-files", channelId, status),
  getThreadMessages: (threadId: string) => ipcRenderer.invoke("fschat:get-thread-messages", threadId),
  sendMessage: (input: SendMessageInput) => ipcRenderer.invoke("fschat:send-message", input),
  onIndexProgress: (listener: (event: IndexProgressEvent) => void) => {
    const wrapped = (_event: unknown, payload: IndexProgressEvent) => listener(payload);
    ipcRenderer.on("fschat:index-progress", wrapped);
    return () => ipcRenderer.removeListener("fschat:index-progress", wrapped);
  },
  onIndexFileUpdate: (listener: (event: IndexFileUpdateEvent) => void) => {
    const wrapped = (_event: unknown, payload: IndexFileUpdateEvent) => listener(payload);
    ipcRenderer.on("fschat:index-file-update", wrapped);
    return () => ipcRenderer.removeListener("fschat:index-file-update", wrapped);
  },
  onChannelRefreshed: (listener: (snapshot: ChannelSnapshot) => void) => {
    const wrapped = (_event: unknown, payload: ChannelSnapshot) => listener(payload);
    ipcRenderer.on("fschat:channel-refreshed", wrapped);
    return () => ipcRenderer.removeListener("fschat:channel-refreshed", wrapped);
  }
};

contextBridge.exposeInMainWorld("fsChat", api);
