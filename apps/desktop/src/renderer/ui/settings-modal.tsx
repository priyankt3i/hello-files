import { useEffect, useMemo, useState } from "react";
import type {
  ConnectProviderInput,
  ProviderConnection,
  ProviderDefaults,
  ProviderKind,
  ProviderModel
} from "@fschat/shared";
import { Modal } from "./common";

const PROVIDERS: Array<{ value: ProviderKind; label: string; note: string }> = [
  { value: "openai", label: "OpenAI", note: "Chat and embedding models are discovered automatically." },
  {
    value: "openai-codex",
    label: "OpenAI Codex",
    note: "Codex uses browser-based OAuth in this desktop app. It is treated as chat-only here, so Codex channels should use vectorless retrieval. The model picker mirrors Cline's ChatGPT Subscription catalog, and the selected Codex model is sent directly."
  },
  {
    value: "anthropic",
    label: "Anthropic",
    note: "Claude chat models are discovered automatically. Anthropic works for vectorless channels, but vector channels still need embeddings from another provider."
  },
  { value: "google", label: "Google Gemini", note: "Chat and embedding models are discovered automatically." },
  {
    value: "ollama",
    label: "Ollama",
    note: "Installed local models are inspected and classified so chat pickers only show chat models and embedding pickers only show embedding models."
  },
  {
    value: "azure-openai",
    label: "Azure OpenAI",
    note: "Deployment-specific automatic model discovery is still not available in this version."
  }
];

type DraftDefaultsByConnection = Record<
  string,
  {
    chatModelId: string;
    embeddingModelId: string;
  }
>;

export function SettingsModal({
  connections,
  providerDefaults,
  models,
  onClose,
  onConnect,
  onResetAppData,
  onRefreshProviderModels,
  onSaveProviderDefaults
}: {
  connections: ProviderConnection[];
  providerDefaults: ProviderDefaults[];
  models: ProviderModel[];
  onClose: () => void;
  onConnect: (input: ConnectProviderInput) => Promise<{ warnings: string[] }>;
  onResetAppData: () => Promise<void>;
  onRefreshProviderModels: (connectionId: string) => Promise<{ warnings: string[] }>;
  onSaveProviderDefaults: (
    connectionId: string,
    chatModelId: string | null,
    embeddingModelId: string | null
  ) => Promise<void>;
}) {
  const [provider, setProvider] = useState<ProviderKind>("google");
  const [connectionName, setConnectionName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [draftDefaults, setDraftDefaults] = useState<DraftDefaultsByConnection>({});
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    const nextDrafts = Object.fromEntries(
      connections.map((connection) => {
        const defaults = providerDefaults.find((item) => item.connectionId === connection.id);
        return [
          connection.id,
          {
            chatModelId: defaults?.defaultChatModelId ?? "",
            embeddingModelId: defaults?.defaultEmbeddingModelId ?? ""
          }
        ];
      })
    );
    setDraftDefaults(nextDrafts);
  }, [connections, providerDefaults]);

  const providerNote = useMemo(() => PROVIDERS.find((item) => item.value === provider)?.note ?? "", [provider]);
  const providerNeedsApiKey = provider !== "ollama" && provider !== "openai-codex";

  return (
    <Modal title="Provider Settings" onClose={onClose}>
      <div className="grid gap-6 md:grid-cols-[1fr_1fr]">
        <div>
          <div className="mb-4 text-sm text-mist/75">
            Connect each provider once. The app discovers its models, then you choose default chat and embedding models
            for that provider connection.
          </div>
          <div className="space-y-3">
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value as ProviderKind)}
              className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none"
            >
              {PROVIDERS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <div className="rounded-2xl bg-white/5 px-4 py-3 text-xs leading-6 text-mist/75">{providerNote}</div>
            <input
              value={connectionName}
              onChange={(event) => setConnectionName(event.target.value)}
              placeholder="Connection name (optional)"
              className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none"
            />
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                provider === "ollama"
                  ? "No API key needed for local Ollama"
                  : provider === "openai-codex"
                    ? "No API key needed. Browser login opens during connect."
                    : "API key"
              }
              type="password"
              disabled={!providerNeedsApiKey}
              className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none disabled:opacity-50"
            />
            <button
              className="rounded-full bg-ember px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40"
              disabled={busy || (providerNeedsApiKey && !apiKey.trim())}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await onConnect({
                    provider,
                    connectionName: connectionName.trim() || undefined,
                    apiKey: providerNeedsApiKey ? apiKey.trim() : undefined
                  });
                  setWarnings(result.warnings);
                  setConnectionName("");
                  if (providerNeedsApiKey) {
                    setApiKey("");
                  }
                } finally {
                  setBusy(false);
                }
              }}
            >
              Connect Provider
            </button>
          </div>

          {warnings.length > 0 ? (
            <div className="mt-4 rounded-[24px] border border-amber-300/20 bg-amber-400/10 p-4">
              <div className="mb-2 text-sm font-semibold text-amber-100">Connection notes</div>
              <div className="space-y-2 text-xs leading-6 text-amber-100/85">
                {warnings.map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div>
          <div className="rounded-[24px] bg-white/5 p-4">
            <div className="mb-4 text-sm font-semibold text-paper">Connected Providers</div>
            <div className="space-y-4">
              {connections.length === 0 ? (
                <div className="text-sm text-mist/70">No providers connected yet.</div>
              ) : (
                connections.map((connection) => {
                  const connectionModels = models.filter((model) => model.connectionId === connection.id);
                  const chatModels = connectionModels.filter((model) => model.supportsChat);
                  const embeddingModels = connectionModels.filter((model) => model.supportsEmbedding);
                  const draft = draftDefaults[connection.id] ?? { chatModelId: "", embeddingModelId: "" };

                  return (
                    <div key={connection.id} className="rounded-2xl bg-black/15 px-4 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="break-anywhere text-sm text-paper">{connection.name}</div>
                          <div className="mt-1 text-xs text-mist/65">
                            {connection.provider} · {chatModels.length} chat · {embeddingModels.length} embedding
                          </div>
                        </div>
                        <button
                          className="shrink-0 rounded-full border border-white/10 px-3 py-1 text-xs text-mist"
                          onClick={async () => {
                            const result = await onRefreshProviderModels(connection.id);
                            setWarnings(result.warnings);
                          }}
                        >
                          Refresh Models
                        </button>
                      </div>

                      <div className="mt-4 grid gap-3">
                        <select
                          value={draft.chatModelId}
                          onChange={(event) =>
                            setDraftDefaults((current) => ({
                              ...current,
                              [connection.id]: {
                                ...current[connection.id],
                                chatModelId: event.target.value
                              }
                            }))
                          }
                          className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none"
                        >
                          <option value="">No default chat model</option>
                          {chatModels.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.displayName}
                            </option>
                          ))}
                        </select>
                        <select
                          value={draft.embeddingModelId}
                          onChange={(event) =>
                            setDraftDefaults((current) => ({
                              ...current,
                              [connection.id]: {
                                ...current[connection.id],
                                embeddingModelId: event.target.value
                              }
                            }))
                          }
                          className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-paper outline-none"
                        >
                          <option value="">No default embedding model</option>
                          {embeddingModels.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.displayName}
                            </option>
                          ))}
                        </select>
                        <button
                          className="w-fit rounded-full border border-white/10 px-4 py-2 text-sm text-mist"
                          onClick={() =>
                            void onSaveProviderDefaults(
                              connection.id,
                              draft.chatModelId || null,
                              draft.embeddingModelId || null
                            )
                          }
                        >
                          Save Provider Defaults
                        </button>
                      </div>
                      {chatModels.length === 0 ? (
                        <div className="mt-3 rounded-2xl border border-coral/25 bg-coral/10 px-4 py-3 text-sm text-[#ffd1ca]">
                          This provider connection has no chat-capable models available right now.
                        </div>
                      ) : null}
                      {embeddingModels.length === 0 ? (
                        <div className="mt-3 rounded-2xl border border-coral/25 bg-coral/10 px-4 py-3 text-sm text-[#ffd1ca]">
                          This provider connection has no embedding-capable models available right now.
                        </div>
                      ) : null}

                      <div className="mt-4">
                        <div className="mb-2 text-xs uppercase tracking-[0.2em] text-mist/45">Discovered Models</div>
                        <div className="flex flex-wrap gap-2">
                          {connectionModels.length === 0 ? (
                            <div className="text-xs text-mist/55">No discovered models.</div>
                          ) : (
                            connectionModels.map((model) => (
                              <div
                                key={model.id}
                                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-mist/80"
                              >
                                {model.displayName}
                                <span className="ml-2 text-mist/55">
                                  {model.supportsChat ? "chat" : ""}
                                  {model.supportsChat && model.supportsEmbedding ? ", " : ""}
                                  {model.supportsEmbedding ? "embedding" : ""}
                                  {!model.supportsChat && !model.supportsEmbedding ? "hidden" : ""}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="mt-6 rounded-[24px] border border-coral/20 bg-coral/10 p-4">
            <div className="text-sm font-semibold text-[#ffd1ca]">Reset App Data</div>
            <div className="mt-2 text-sm leading-6 text-[#ffd1ca]/85">
              This removes all saved channels, provider connections, default models, chat threads, and stored API
              credentials for this app. It does not delete your source folders or any `.fschat-index` folders.
            </div>
            {!confirmReset ? (
              <div className="mt-4">
                <button
                  className="rounded-full border border-coral/45 bg-coral/10 px-4 py-2 text-sm font-medium text-[#ffd1ca]"
                  onClick={() => setConfirmReset(true)}
                >
                  Reset App Data
                </button>
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  className="rounded-full border border-white/10 px-4 py-2 text-sm text-mist"
                  onClick={() => setConfirmReset(false)}
                >
                  Keep Data
                </button>
                <button
                  className="rounded-full border border-coral/55 bg-coral/15 px-4 py-2 text-sm font-medium text-[#ffd1ca]"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onResetAppData();
                      setConfirmReset(false);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Confirm Reset
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
