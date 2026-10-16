import { useId, useState, type FormEvent } from "react";
import type { ConnectProviderInput, ProviderKind } from "@fschat/shared";
import { cx, toErrorMessage } from "../../lib/format";
import { PROVIDER_LABEL } from "../../lib/providers";
import { useAppStore } from "../../state/store";
import { Button } from "../ui/button";
import { Callout } from "../ui/feedback";
import { Field, TextInput } from "../ui/form";

const DEFAULT_AZURE_API_VERSION = "2024-10-21";

const PROVIDER_NOTES: Record<ProviderKind, string> = {
  openai: "Uses your OpenAI API key. Chat and embedding models are found automatically. Content you ask about is sent to OpenAI.",
  "azure-openai":
    "Your organisation's Azure OpenAI resource. Enter the endpoint and deployment names provided by your IT team. Content is sent to that Azure resource.",
  anthropic:
    "Claude chat models. Anthropic doesn't provide embeddings, so use keyword search or pair it with another provider for semantic search.",
  google: "Gemini chat and embedding models are found automatically. Content you ask about is sent to Google.",
  ollama: "Runs models on this computer, so nothing leaves your machine. Ollama must be installed and running (http://localhost:11434).",
  openrouter:
    "One API key for hundreds of chat models and low-cost embedding models. Models are listed cheapest first with their price per million tokens. Content you ask about is sent to OpenRouter and the model's host.",
  "openai-codex": "Signs in with a ChatGPT account in your browser. Chat only; knowledge bases using it must use keyword search."
};

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

function isLocalAddress(address: string) {
  const trimmed = address.trim() || DEFAULT_OLLAMA_URL;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function ProviderForm({ onDone }: { onDone: () => void }) {
  const { state, actions } = useAppStore();
  const localOnly = state.settings.dataPolicy === "local-only";
  const kinds: ProviderKind[] = ["openai", "azure-openai", "anthropic", "google", "openrouter", "ollama", ...(state.features.codexEnabled ? (["openai-codex"] as const) : [])];
  const [provider, setProvider] = useState<ProviderKind>(localOnly ? "ollama" : "openai");
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState(DEFAULT_OLLAMA_URL);
  const [apiVersion, setApiVersion] = useState(DEFAULT_AZURE_API_VERSION);
  const [chatDeployment, setChatDeployment] = useState("");
  const [embeddingDeployment, setEmbeddingDeployment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const ids = { name: useId(), key: useId(), endpoint: useId(), version: useId(), chat: useId(), embed: useId() };

  const needsKey = provider !== "ollama" && provider !== "openai-codex";
  const isAzure = provider === "azure-openai";
  const isOllama = provider === "ollama";
  const ollamaRemote = isOllama && !isLocalAddress(ollamaUrl);
  const blocked = localOnly && (provider !== "ollama" || ollamaRemote);
  const azureInvalid =
    isAzure && (!/^https:\/\/\S+$/i.test(endpoint.trim()) || (!chatDeployment.trim() && !embeddingDeployment.trim()));
  const canSubmit = !blocked && (!needsKey || apiKey.trim().length > 0) && !azureInvalid;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const input: ConnectProviderInput = {
        provider,
        connectionName: name.trim() || undefined,
        apiKey: needsKey ? apiKey.trim() : undefined,
        ...(isAzure
          ? {
              baseUrl: endpoint.trim(),
              apiVersion: apiVersion.trim() || DEFAULT_AZURE_API_VERSION,
              azureChatDeployment: chatDeployment.trim() || undefined,
              azureEmbeddingDeployment: embeddingDeployment.trim() || undefined
            }
          : {}),
        ...(isOllama ? { baseUrl: ollamaUrl.trim() || DEFAULT_OLLAMA_URL } : {})
      };
      const result = await actions.connectProvider(input);
      setApiKey("");
      if (result.warnings.length > 0) {
        setWarnings(result.warnings);
      } else {
        onDone();
      }
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4 rounded-md border border-border bg-surface-2/50 p-4">
      <div>
        <div className="mb-2 text-sm font-medium text-text">Provider</div>
        <div role="radiogroup" aria-label="Provider" className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          {kinds.map((kind) => {
            const disabled = localOnly && kind !== "ollama";
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={provider === kind}
                disabled={disabled}
                title={disabled ? "Blocked by Local-only mode" : undefined}
                onClick={() => {
                  setProvider(kind);
                  setError(null);
                  setWarnings([]);
                }}
                className={cx(
                  "h-9 rounded border px-3 text-left text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  provider === kind ? "border-accent bg-accent/5 text-text" : "border-border bg-surface text-text hover:bg-surface-2"
                )}
              >
                {PROVIDER_LABEL[kind]}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-text-muted">{PROVIDER_NOTES[provider]}</p>
        {localOnly ? (
          <p className="mt-1 text-xs text-text-muted">Local-only mode is on, so only Ollama on this computer can be added. Change this under Privacy.</p>
        ) : null}
      </div>

      {isAzure ? (
        <Field label="Endpoint" htmlFor={ids.endpoint} hint="For example https://my-resource.openai.azure.com">
          <TextInput id={ids.endpoint} value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://" spellCheck={false} />
        </Field>
      ) : null}

      {isOllama ? (
        <Field
          label="Ollama address"
          htmlFor={ids.endpoint}
          hint={
            ollamaRemote
              ? "This is another computer, so questions and file excerpts will be sent over the network to it."
              : "Leave as is for Ollama on this computer."
          }
        >
          <TextInput id={ids.endpoint} value={ollamaUrl} onChange={(event) => setOllamaUrl(event.target.value)} spellCheck={false} />
        </Field>
      ) : null}

      {needsKey ? (
        <Field label="API key" htmlFor={ids.key} hint="Stored in the operating system's secure credential store (Windows Credential Manager), not in the app's files.">
          <TextInput id={ids.key} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      ) : null}

      {isAzure ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Chat deployment" htmlFor={ids.chat} hint="Deployment name of a chat model, e.g. gpt-4o.">
            <TextInput id={ids.chat} value={chatDeployment} onChange={(event) => setChatDeployment(event.target.value)} spellCheck={false} />
          </Field>
          <Field label="Embedding deployment" htmlFor={ids.embed} hint="Optional. Needed for semantic search.">
            <TextInput id={ids.embed} value={embeddingDeployment} onChange={(event) => setEmbeddingDeployment(event.target.value)} spellCheck={false} />
          </Field>
          <Field label="API version" htmlFor={ids.version}>
            <TextInput id={ids.version} value={apiVersion} onChange={(event) => setApiVersion(event.target.value)} spellCheck={false} />
          </Field>
        </div>
      ) : null}

      <Field label="Display name" htmlFor={ids.name} hint="Optional. Helps tell connections apart, e.g. “Team Azure”.">
        <TextInput id={ids.name} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
      </Field>

      {isAzure && azureInvalid && endpoint.trim() ? (
        <p className="text-xs text-text-muted">Enter an https endpoint and at least one deployment name.</p>
      ) : null}
      {error ? <Callout tone="danger" title="Couldn't connect">{error}</Callout> : null}
      {warnings.length > 0 ? (
        <Callout
          tone="warning"
          title="Connected, with notes"
          actions={
            <Button size="sm" onClick={onDone}>
              Done
            </Button>
          }
        >
          <ul className="list-disc space-y-1 pl-4">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit} loading={busy}>
          {provider === "openai-codex" ? "Sign in and connect" : "Connect"}
        </Button>
      </div>
    </form>
  );
}
