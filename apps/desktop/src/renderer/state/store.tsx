import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isTerminalPhase } from "../lib/format";
import { buildLookup } from "../lib/providers";
import { mergeChannels, mergeSnapshotFileUpdate } from "../lib/snapshot";
import { createAdminActions } from "./admin-actions";
import { createCoreActions } from "./core-actions";
import { useToasts } from "./toasts";
import { initialAppState, type AppState, type Patch } from "./types";

function useStoreController() {
  const toast = useToasts();
  const [state, setState] = useState<AppState>(initialAppState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const patch = useCallback<Patch>((update) => {
    setState((current) => {
      const next = { ...current, ...(typeof update === "function" ? update(current) : update) };
      stateRef.current = next;
      return next;
    });
  }, []);

  // Actions read live state through stateRef, so they are created once and keep a stable identity.
  const actions = useMemo(() => {
    const deps = { get: () => stateRef.current, patch, toast };
    const core = createCoreActions(deps);
    return { ...core, ...createAdminActions(deps, core) };
  }, [patch, toast]);

  // Initial load.
  const bootStarted = useRef(false);
  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    void actions.refreshBootstrap();
  }, [actions]);

  // Tell the main process to swap the splash window once the UI is ready.
  const readySent = useRef(false);
  useEffect(() => {
    if (!state.ready || readySent.current) return;
    readySent.current = true;
    window.fsChat.rendererReady();
  }, [state.ready]);

  // Backend events. Subscribed once; handlers use functional patches so they never see stale state.
  useEffect(() => {
    const offProgress = window.fsChat.onIndexProgress((event) => {
      if (event.channelId === "global") {
        // Only emitted when the indexing worker process itself crashed.
        toast.error("The indexing engine stopped unexpectedly", event.message ?? "It will restart on the next sync.", "worker-crash");
        return;
      }
      patch((current) => ({ progressByChannel: { ...current.progressByChannel, [event.channelId]: event } }));
      if (isTerminalPhase(event.phase)) {
        actions.setCancelling(event.channelId, false);
      }
      if (event.phase === "error") {
        const name = stateRef.current.channels.find((channel) => channel.id === event.channelId)?.displayName ?? "A knowledge base";
        toast.error(`Indexing failed for ${name}`, event.message, `index-error-${event.channelId}`);
      }
      if (event.warning) {
        const name = stateRef.current.channels.find((channel) => channel.id === event.channelId)?.displayName ?? "A knowledge base";
        toast.show({
          tone: "warning",
          title: `Semantic search paused for ${name}`,
          description: `${event.warning} Files are still being indexed for keyword search.`,
          id: `embed-warning-${event.channelId}`
        });
      }
      if ((event.phase === "completed" || event.phase === "cancelled") && stateRef.current.selectedChannelId === event.channelId) {
        void actions.reloadChannel(event.channelId);
      }
    });
    const offFileUpdate = window.fsChat.onIndexFileUpdate((event) => {
      patch((current) => ({ snapshot: mergeSnapshotFileUpdate(current.snapshot, event) }));
    });
    const offChannel = window.fsChat.onChannelRefreshed((snapshot) => {
      if (snapshot.channel.status !== "indexing") {
        actions.setCancelling(snapshot.channel.id, false);
      }
      patch((current) => {
        // A refresh outside of "indexing" means any run has finished; drop a dangling non-terminal progress event.
        const progress = current.progressByChannel[snapshot.channel.id];
        const progressByChannel =
          snapshot.channel.status !== "indexing" && progress && !isTerminalPhase(progress.phase)
            ? { ...current.progressByChannel, [snapshot.channel.id]: { ...progress, phase: "completed" as const } }
            : current.progressByChannel;
        return {
          progressByChannel,
          channels: mergeChannels(current.channels, snapshot.channel),
          snapshot: current.selectedChannelId === snapshot.channel.id ? snapshot : current.snapshot
        };
      });
    });
    return () => {
      offProgress();
      offFileUpdate();
      offChannel();
    };
  }, [actions, patch, toast]);

  const lookup = useMemo(() => buildLookup(state.models, state.connections), [state.models, state.connections]);
  const selectedChannel = state.channels.find((channel) => channel.id === state.selectedChannelId) ?? null;

  return { state, actions, lookup, selectedChannel };
}

export type AppStore = ReturnType<typeof useStoreController>;

const StoreContext = createContext<AppStore | null>(null);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const store = useStoreController();
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useAppStore() {
  const context = useContext(StoreContext);
  if (!context) throw new Error("useAppStore must be used inside <AppStoreProvider>.");
  return context;
}

/** True while a background auto-sync (not a manual "indexing" run) is in progress for the channel. */
export function isBackgroundSyncing(state: AppState, channelId: string) {
  const channel = state.channels.find((item) => item.id === channelId);
  const progress = state.progressByChannel[channelId];
  return Boolean(channel && progress && channel.status !== "indexing" && !isTerminalPhase(progress.phase));
}
