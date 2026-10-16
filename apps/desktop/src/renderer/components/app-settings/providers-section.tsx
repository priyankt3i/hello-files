import { useState } from "react";
import { Cloud, Lock, Plus, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
import type { ProviderConnection } from "@fschat/shared";
import { toErrorMessage } from "../../lib/format";
import { PROVIDER_LABEL, channelsUsingConnection, isConnectionAllowed, isLocalConnection } from "../../lib/providers";
import { useAppStore } from "../../state/store";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Callout, EmptyState, Pill } from "../ui/feedback";
import { Field, Select } from "../ui/form";
import { ProviderForm } from "./provider-form";

export function ProvidersSection() {
  const { state } = useAppStore();
  const [adding, setAdding] = useState(state.connections.length === 0);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-text">AI providers</h3>
          <p className="mt-0.5 text-sm text-text-muted">Connections to the AI services that read your questions and write answers.</p>
        </div>
        {!adding ? (
          <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
            Add provider
          </Button>
        ) : null}
      </div>

      {adding ? <ProviderForm onDone={() => setAdding(false)} /> : null}

      {state.connections.length === 0 && !adding ? (
        <EmptyState icon={Cloud} title="No providers connected">
          Add a provider to start creating knowledge bases.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {state.connections.map((connection) => (
            <li key={connection.id}>
              <ConnectionCard connection={connection} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConnectionCard({ connection }: { connection: ProviderConnection }) {
  const { state, actions, lookup } = useAppStore();
  const [showDefaults, setShowDefaults] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const models = state.models.filter((model) => model.connectionId === connection.id);
  const chatCount = models.filter((model) => model.supportsChat).length;
  const embeddingCount = models.filter((model) => model.supportsEmbedding).length;
  const local = isLocalConnection(connection);
  const allowed = isConnectionAllowed(connection, state.settings);
  const usedBy = channelsUsingConnection(state.channels, connection.id, lookup);

  return (
    <div className="rounded-md border border-border bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-text">{connection.name}</span>
            <Pill tone={local ? "success" : "neutral"} icon={local ? Lock : Cloud}>
              {local ? "On this computer" : "Cloud"}
            </Pill>
            {!allowed ? <Pill tone="danger">Blocked by Local-only mode</Pill> : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-muted">
            <span>{PROVIDER_LABEL[connection.provider]}</span>
            {connection.apiKeyHint ? <span className="font-mono">Key {connection.apiKeyHint}</span> : null}
            {connection.baseUrl ? <span className="break-anywhere">{connection.baseUrl}</span> : null}
            <span>
              {chatCount} chat · {embeddingCount} embedding models
            </span>
            {usedBy.length > 0 ? <span>Used by {usedBy.length} knowledge base{usedBy.length === 1 ? "" : "s"}</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1">
          <Button
            size="sm"
            variant="ghost"
            icon={RefreshCw}
            loading={refreshing}
            onClick={async () => {
              setRefreshing(true);
              setWarnings(await actions.refreshProviderModels(connection.id));
              setRefreshing(false);
            }}
          >
            Refresh models
          </Button>
          <Button size="sm" variant="ghost" icon={SlidersHorizontal} onClick={() => setShowDefaults((value) => !value)} aria-expanded={showDefaults}>
            Defaults
          </Button>
          <Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => setConfirmRemove(true)}>
            Remove
          </Button>
        </div>
      </div>

      {chatCount === 0 && embeddingCount === 0 ? (
        <Callout tone="warning" className="mt-3">
          No usable models were found. Check the connection, then refresh models.
        </Callout>
      ) : null}
      {warnings.length > 0 ? (
        <Callout tone="warning" className="mt-3">
          {warnings.join(" ")}
        </Callout>
      ) : null}
      {showDefaults ? <DefaultsEditor connection={connection} onDone={() => setShowDefaults(false)} /> : null}

      {confirmRemove ? (
        <ConfirmDialog
          title={`Remove “${connection.name}”?`}
          confirmLabel="Remove provider"
          onConfirm={() => actions.deleteProviderConnection(connection.id)}
          onClose={() => setConfirmRemove(false)}
        >
          <p>The connection and its stored API key will be deleted from this computer.</p>
          {usedBy.length > 0 ? (
            <Callout tone="warning" title="These knowledge bases use it and will need a new model:">
              <ul className="list-disc pl-4">
                {usedBy.map((channel) => (
                  <li key={channel.id}>{channel.displayName}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function DefaultsEditor({ connection, onDone }: { connection: ProviderConnection; onDone: () => void }) {
  const { state, actions } = useAppStore();
  const current = state.providerDefaults.find((item) => item.connectionId === connection.id);
  const models = state.models.filter((model) => model.connectionId === connection.id);
  const [chat, setChat] = useState(current?.defaultChatModelId ?? "");
  const [embedding, setEmbedding] = useState(current?.defaultEmbeddingModelId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await actions.saveProviderDefaults(connection.id, chat || null, embedding || null);
      onDone();
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      <p className="text-xs text-text-muted">Pre-selected when you create a new knowledge base.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Default chat model">
          <Select value={chat} onChange={(event) => setChat(event.target.value)}>
            <option value="">None</option>
            {models.filter((model) => model.supportsChat).map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default embedding model">
          <Select value={embedding} onChange={(event) => setEmbedding(event.target.value)}>
            <option value="">None</option>
            {models.filter((model) => model.supportsEmbedding).map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={() => void save()} loading={busy}>
          Save defaults
        </Button>
      </div>
    </div>
  );
}
