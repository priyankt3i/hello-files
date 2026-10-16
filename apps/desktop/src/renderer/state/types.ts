import type {
  AppFeatures,
  AppSettings,
  Channel,
  ChannelSnapshot,
  IndexProgressEvent,
  Message,
  ProviderConnection,
  ProviderDefaults,
  ProviderModel,
  Thread
} from "@fschat/shared";

export type KbTab = "chat" | "files" | "settings";
export type AppSettingsSection = "providers" | "privacy" | "appearance" | "storage";

/** A message that is being sent (shown optimistically with a thinking indicator). */
export interface PendingTurn {
  channelId: string;
  threadId: string | null;
  text: string;
  createdAt: string;
}

/** A message whose model call failed. Nothing was saved by the backend, so we keep it for Retry / Edit. */
export interface FailedTurn {
  channelId: string;
  threadId: string | null;
  text: string;
  error: string;
}

export interface AppState {
  ready: boolean;
  channels: Channel[];
  connections: ProviderConnection[];
  providerDefaults: ProviderDefaults[];
  models: ProviderModel[];
  settings: AppSettings;
  features: AppFeatures;
  indexStorageDir: string;
  /** Chats of every knowledge base, for the sidebar. The selected KB's snapshot is the fresher source for that KB. */
  threads: Thread[];
  defaultSystemPrompt: string;

  selectedChannelId: string | null;
  snapshot: ChannelSnapshot | null;
  selectedThreadId: string | null;
  messages: Message[];
  tab: KbTab;

  /** Latest progress event per channel (manual runs and background auto-sync). */
  progressByChannel: Record<string, IndexProgressEvent>;
  cancellingByChannel: Record<string, boolean>;

  pendingTurn: PendingTurn | null;
  failedTurn: FailedTurn | null;
  /** Text to place into the composer (e.g. after "Edit" on a failed message). Consumed by the composer. */
  composerSeed: { text: string; nonce: number } | null;

  newKbOpen: boolean;
  appSettingsSection: AppSettingsSection | null;
}

export const initialAppState: AppState = {
  ready: false,
  channels: [],
  connections: [],
  providerDefaults: [],
  models: [],
  settings: { dataPolicy: "any" },
  features: { codexEnabled: false },
  indexStorageDir: "",
  threads: [],
  defaultSystemPrompt: "",
  selectedChannelId: null,
  snapshot: null,
  selectedThreadId: null,
  messages: [],
  tab: "chat",
  progressByChannel: {},
  cancellingByChannel: {},
  pendingTurn: null,
  failedTurn: null,
  composerSeed: null,
  newKbOpen: false,
  appSettingsSection: null
};

export type Patch = (update: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;
