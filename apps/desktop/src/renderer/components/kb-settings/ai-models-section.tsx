import { useEffect, useState } from "react";
import type { Channel } from "@fschat/shared";
import { toErrorMessage } from "../../lib/format";
import { useAppStore } from "../../state/store";
import { Button } from "../ui/button";
import { Callout } from "../ui/feedback";
import { Section } from "../ui/form";
import { ChatModelField, DataFlowNote, SearchTypeFields, validateSelection, withChatModel, type ModelSelection } from "./model-fields";

function fromChannel(channel: Channel): ModelSelection {
  return { chatModelId: channel.chatModelId, embeddingModelId: channel.embeddingModelId, retrievalMode: channel.retrievalMode };
}

export function AiModelsSection({ channel }: { channel: Channel }) {
  const { state, actions, lookup } = useAppStore();
  const [draft, setDraft] = useState<ModelSelection>(() => fromChannel(channel));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pick up changes saved elsewhere (or by the backend clearing a removed model).
  useEffect(() => {
    setDraft(fromChannel(channel));
  }, [channel.chatModelId, channel.embeddingModelId, channel.retrievalMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const saved = fromChannel(channel);
  const dirty =
    draft.chatModelId !== saved.chatModelId ||
    draft.retrievalMode !== saved.retrievalMode ||
    (draft.retrievalMode === "vector" && draft.embeddingModelId !== saved.embeddingModelId);
  const needsReindex =
    channel.lastIndexedAt !== null &&
    (draft.retrievalMode !== saved.retrievalMode || (draft.retrievalMode === "vector" && draft.embeddingModelId !== saved.embeddingModelId));
  const validation = validateSelection(draft);
  const indexing = channel.status === "indexing";
  const noModels = !state.models.some((model) => model.supportsChat);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const chatModel = draft.chatModelId ? lookup.modelById[draft.chatModelId] : undefined;
      await actions.updateChannelModels({
        channelId: channel.id,
        preferredConnectionId: chatModel?.connectionId ?? channel.preferredConnectionId,
        chatModelId: draft.chatModelId,
        embeddingModelId: draft.retrievalMode === "vector" ? draft.embeddingModelId : null,
        retrievalMode: draft.retrievalMode
      });
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="AI models" description="Choose which model answers questions and how files are searched.">
      {noModels ? (
        <Callout
          tone="warning"
          title="No AI provider connected"
          actions={
            <Button size="sm" onClick={() => actions.openAppSettings("providers")}>
              Connect a provider
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          <ChatModelField value={draft.chatModelId} onChange={(id) => setDraft((current) => withChatModel(current, id, lookup))} />
          <div>
            <div className="mb-2 text-sm font-medium text-text">Search type</div>
            <SearchTypeFields selection={draft} onChange={setDraft} />
          </div>
          <DataFlowNote selection={draft} />
          {needsReindex ? (
            <Callout tone="warning" title="This will require re-indexing">
              Changing the search type or embedding model clears the current index. Run “Sync now” afterwards; chat is unavailable
              until it finishes.
            </Callout>
          ) : null}
          {indexing ? <Callout tone="info">Model settings can't be changed while indexing is running.</Callout> : null}
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <div className="flex items-center justify-end gap-2">
            {dirty && validation ? <span className="mr-auto text-xs text-text-muted">{validation}</span> : null}
            <Button onClick={() => setDraft(saved)} disabled={!dirty || saving}>
              Discard changes
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={!dirty || Boolean(validation) || indexing} loading={saving}>
              Save models
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}
