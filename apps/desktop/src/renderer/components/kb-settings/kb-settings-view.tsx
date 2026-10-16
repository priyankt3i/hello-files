import { useEffect, useId, useState } from "react";
import { FolderOpen, Hammer, RefreshCw, Trash2 } from "lucide-react";
import type { Channel } from "@fschat/shared";
import { formatDateTime, toErrorMessage } from "../../lib/format";
import { useAppStore } from "../../state/store";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Callout, TechnicalDetails } from "../ui/feedback";
import { Field, Section, TextArea, TextInput } from "../ui/form";
import { AiModelsSection } from "./ai-models-section";
import { SyncSection } from "./sync-section";

export function KbSettingsView({ channel }: { channel: Channel }) {
  const { actions } = useAppStore();
  const [confirm, setConfirm] = useState<"rebuild" | "delete" | null>(null);
  const indexing = channel.status === "indexing";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
        <GeneralSection channel={channel} />
        <AiModelsSection key={`models-${channel.id}`} channel={channel} />
        <SyncSection key={`sync-${channel.id}`} channel={channel} />
        <InstructionsSection key={`prompt-${channel.id}`} channel={channel} />

        <Section title="Maintenance" description="Sync now picks up added, changed and removed files. Rebuild re-reads every file from scratch.">
          <div className="flex flex-wrap gap-2">
            <Button icon={RefreshCw} onClick={() => actions.startSync(channel.id)} disabled={indexing}>
              Sync now
            </Button>
            <Button icon={Hammer} onClick={() => setConfirm("rebuild")} disabled={indexing}>
              Rebuild from scratch
            </Button>
          </div>
          <div className="mt-4">
            <TechnicalDetails>
              <div>Knowledge base ID: {channel.id}</div>
              <div className="break-anywhere">Index location: {channel.indexPath}</div>
              <div>Retrieval mode: {channel.retrievalMode}</div>
              <div>Created: {formatDateTime(channel.createdAt)}</div>
              <div>Last indexed: {formatDateTime(channel.lastIndexedAt) || "never"}</div>
            </TechnicalDetails>
          </div>
        </Section>

        <section className="rounded-md border border-danger/30 bg-surface p-5 shadow-card">
          <h3 className="text-sm font-semibold text-danger">Danger zone</h3>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-text-muted">
              Deleting removes this knowledge base, its chats and its search index from Hello Files. The files in your folder are
              never touched.
            </p>
            <Button variant="danger" icon={Trash2} onClick={() => setConfirm("delete")} disabled={indexing}>
              Delete knowledge base
            </Button>
          </div>
          {indexing ? <p className="mt-2 text-xs text-text-muted">Cancel indexing first to delete or rebuild.</p> : null}
        </section>
      </div>

      {confirm === "rebuild" ? (
        <ConfirmDialog
          title="Rebuild from scratch?"
          confirmLabel="Rebuild"
          tone="primary"
          onConfirm={() => actions.rebuildIndex(channel.id)}
          onClose={() => setConfirm(null)}
        >
          <p>
            Every file in <span className="font-medium text-text">{channel.displayName}</span> will be read again. This can take a
            while for large folders{channel.retrievalMode === "vector" ? " and sends all file text to the embedding provider again" : ""}.
            Chat is unavailable until it finishes.
          </p>
          <p>Use this only if answers seem out of date after a normal sync.</p>
        </ConfirmDialog>
      ) : null}
      {confirm === "delete" ? (
        <ConfirmDialog
          title={`Delete “${channel.displayName}”?`}
          confirmLabel="Delete knowledge base"
          onConfirm={() => actions.deleteChannel(channel.id)}
          onClose={() => setConfirm(null)}
        >
          <p>This removes the knowledge base, all of its chats, and its search index from Hello Files.</p>
          <p className="font-medium text-text">Your original files in {channel.rootPath} are not touched.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function GeneralSection({ channel }: { channel: Channel }) {
  const { actions } = useAppStore();
  const id = useId();
  const [name, setName] = useState(channel.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(channel.displayName), [channel.displayName]);
  const dirty = name.trim() !== channel.displayName && name.trim().length > 0;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await actions.updateChannelSettings({ channelId: channel.id, displayName: name.trim() });
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="General">
      <div className="space-y-4">
        <Field label="Name" htmlFor={id} error={error}>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (dirty) void save();
            }}
          >
            <TextInput id={id} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
            <Button type="submit" variant="primary" disabled={!dirty} loading={saving}>
              Save
            </Button>
          </form>
        </Field>
        <Field label="Folder" hint="To use a different folder, create a new knowledge base.">
          <div className="flex items-center gap-2">
            <div className="control flex h-8 min-w-0 items-center bg-surface-2 text-text-muted" title={channel.rootPath}>
              <span className="truncate">{channel.rootPath}</span>
            </div>
            <Button icon={FolderOpen} onClick={() => void actions.openFolder(channel.id)}>
              Open folder
            </Button>
          </div>
        </Field>
      </div>
    </Section>
  );
}

function InstructionsSection({ channel }: { channel: Channel }) {
  const { state, actions } = useAppStore();
  const id = useId();
  const [text, setText] = useState(channel.systemPrompt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = text !== channel.systemPrompt;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await actions.updateSystemPrompt(channel.id, text);
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Assistant instructions"
      description="Tell the assistant how to answer for this knowledge base: tone, format, what to cite, what to avoid. Applies to every chat here."
    >
      <Field label="Instructions" htmlFor={id} error={error}>
        <TextArea id={id} rows={8} value={text} onChange={(event) => setText(event.target.value)} />
      </Field>
      {!text.trim() ? (
        <Callout tone="warning" className="mt-3">
          Instructions can't be empty.
        </Callout>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        {state.defaultSystemPrompt && text !== state.defaultSystemPrompt ? (
          <Button variant="ghost" className="mr-auto" onClick={() => setText(state.defaultSystemPrompt)} disabled={saving}>
            Reset to default
          </Button>
        ) : null}
        <Button onClick={() => setText(channel.systemPrompt)} disabled={!dirty || saving}>
          Discard changes
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || !text.trim()} loading={saving}>
          Save instructions
        </Button>
      </div>
    </Section>
  );
}
