import { useId } from "react";
import type { ProviderConnection, ProviderModel, RetrievalMode } from "@fschat/shared";
import { PROVIDER_LABEL, describeDataDestination, isConnectionAllowed, isLocalConnection, requiresKeywordSearch } from "../../lib/providers";
import { useAppStore } from "../../state/store";
import { Callout, Pill } from "../ui/feedback";
import { Field, RadioCard, Select } from "../ui/form";

export interface ModelSelection {
  chatModelId: string | null;
  embeddingModelId: string | null;
  retrievalMode: RetrievalMode;
}

/** Model <select> grouped by provider connection. Models blocked by the data policy are disabled. */
function ModelSelect({
  id,
  capability,
  value,
  onChange
}: {
  id: string;
  capability: "chat" | "embedding";
  value: string | null;
  onChange: (modelId: string | null) => void;
}) {
  const { state } = useAppStore();
  const groups = state.connections
    .map((connection) => ({
      connection,
      models: state.models.filter(
        (model) => model.connectionId === connection.id && (capability === "chat" ? model.supportsChat : model.supportsEmbedding)
      )
    }))
    .filter((group) => group.models.length > 0);
  const known = value ? state.models.some((model) => model.id === value) : true;

  return (
    <Select id={id} value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">{capability === "chat" ? "Choose a chat model…" : "Choose an embedding model…"}</option>
      {!known ? <option value={value ?? ""}>Unavailable model</option> : null}
      {groups.map(({ connection, models }) => (
        <optgroup key={connection.id} label={groupLabel(connection)}>
          {models.map((model) => (
            <option key={model.id} value={model.id} disabled={!isConnectionAllowed(connection, state.settings)}>
              {model.displayName}
              {!isConnectionAllowed(connection, state.settings) ? " (blocked by Local-only mode)" : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

function groupLabel(connection: ProviderConnection) {
  const where = isLocalConnection(connection) ? "on this computer" : "cloud";
  return `${connection.name} · ${PROVIDER_LABEL[connection.provider]} (${where})`;
}

export function ChatModelField({ value, onChange }: { value: string | null; onChange: (modelId: string | null) => void }) {
  const id = useId();
  return (
    <Field label="Chat model" htmlFor={id} hint="Writes the answers. It receives your question and the most relevant file excerpts.">
      <ModelSelect id={id} capability="chat" value={value} onChange={onChange} />
    </Field>
  );
}

/** Search type choice plus the embedding model picker for semantic search. */
export function SearchTypeFields({
  selection,
  onChange
}: {
  selection: ModelSelection;
  onChange: (next: ModelSelection) => void;
}) {
  const { state, lookup } = useAppStore();
  const id = useId();
  const chatModel: ProviderModel | undefined = selection.chatModelId ? lookup.modelById[selection.chatModelId] : undefined;
  const keywordOnly = requiresKeywordSearch(chatModel ? lookup.connectionById[chatModel.connectionId] : null);
  const hasEmbeddingModels = state.models.some((model) => model.supportsEmbedding);
  const name = `search-type-${id}`;

  return (
    <div className="space-y-3">
      <div className="space-y-2" role="radiogroup" aria-label="Search type">
        <RadioCard
          name={name}
          checked={selection.retrievalMode === "vectorless"}
          onChange={() => onChange({ ...selection, retrievalMode: "vectorless", embeddingModelId: null })}
          title="Keyword search"
          badge={<Pill tone="success">Nothing sent while indexing</Pill>}
          description="Finds documents by the words they contain. No embedding model needed. Good for exact terms such as policy numbers and form names."
        />
        <RadioCard
          name={name}
          checked={selection.retrievalMode === "vector"}
          disabled={keywordOnly || !hasEmbeddingModels}
          onChange={() => onChange({ ...selection, retrievalMode: "vector" })}
          title="Semantic search"
          badge={<Pill tone="warning">Sends file text while indexing</Pill>}
          description={
            keywordOnly
              ? "Not available with the selected chat model."
              : !hasEmbeddingModels
                ? "Connect a provider with an embedding model to use this."
                : "Better at finding passages that mean the same thing in different words. File text is sent to the embedding provider while indexing."
          }
        />
      </div>
      {selection.retrievalMode === "vector" ? (
        <Field
          label="Embedding model"
          htmlFor={`${id}-embedding`}
          hint="Can come from a different provider than the chat model. Changing it later requires re-indexing."
        >
          <ModelSelect
            id={`${id}-embedding`}
            capability="embedding"
            value={selection.embeddingModelId}
            onChange={(embeddingModelId) => onChange({ ...selection, embeddingModelId })}
          />
        </Field>
      ) : null}
    </div>
  );
}

/** Plain-language summary of where content goes for the given selection. */
export function DataFlowNote({ selection }: { selection: ModelSelection }) {
  const { state, lookup } = useAppStore();
  if (!selection.chatModelId) return null;
  const destination = describeDataDestination(selection, lookup, state.settings);
  const tone = destination.tone === "local" ? "success" : destination.tone === "blocked" ? "danger" : destination.tone === "external" ? "warning" : "info";
  const title =
    destination.tone === "local"
      ? "Everything stays on this computer"
      : destination.tone === "blocked"
        ? "Blocked by Local-only mode"
        : destination.tone === "external"
          ? "Some content leaves this computer"
          : "Where your content goes";
  return (
    <Callout tone={tone} title={title}>
      {destination.detail}
    </Callout>
  );
}

export function validateSelection(selection: ModelSelection): string | null {
  if (!selection.chatModelId) return "Choose a chat model.";
  if (selection.retrievalMode === "vector" && !selection.embeddingModelId) return "Choose an embedding model for semantic search.";
  return null;
}

/** Updates the chat model, forcing keyword search when the chat provider can't do semantic search. */
export function withChatModel(selection: ModelSelection, chatModelId: string | null, lookup: ReturnType<typeof useAppStore>["lookup"]): ModelSelection {
  const model = chatModelId ? lookup.modelById[chatModelId] : undefined;
  const connection = model ? lookup.connectionById[model.connectionId] : undefined;
  if (requiresKeywordSearch(connection)) {
    return { chatModelId, retrievalMode: "vectorless", embeddingModelId: null };
  }
  return { ...selection, chatModelId };
}
