import { useId, useState } from "react";
import { Check, FolderOpen, KeyRound } from "lucide-react";
import { cx, toErrorMessage } from "../lib/format";
import { describeDataDestination, isLocalConnection, pickInitialModels } from "../lib/providers";
import { useAppStore } from "../state/store";
import type { RootFolderInspection } from "../types/global";
import { ChatModelField, DataFlowNote, SearchTypeFields, validateSelection, withChatModel, type ModelSelection } from "./kb-settings/model-fields";
import { Button } from "./ui/button";
import { Callout, EmptyState } from "./ui/feedback";
import { Field, TextInput } from "./ui/form";
import { Modal } from "./ui/modal";

const STEPS = ["Folder", "Name & model", "Search", "Review"] as const;

export function NewKnowledgeBaseDialog() {
  const { state, actions, lookup } = useAppStore();
  const nameId = useId();
  const [step, setStep] = useState(0);
  const [inspection, setInspection] = useState<RootFolderInspection | null>(null);
  const [name, setName] = useState("");
  const [selection, setSelection] = useState<ModelSelection>(() => {
    const initial = pickInitialModels(state.connections, state.providerDefaults, state.models, state.settings);
    // Privacy-first default: semantic search only when embeddings run on this computer. Keyword search sends nothing
    // while indexing; users can still opt into cloud semantic search on the next step.
    const embeddingModel = initial.embeddingModelId ? lookup.modelById[initial.embeddingModelId] : undefined;
    const localEmbeddings = isLocalConnection(embeddingModel ? lookup.connectionById[embeddingModel.connectionId] : null);
    return { chatModelId: initial.chatModelId, embeddingModelId: initial.embeddingModelId, retrievalMode: localEmbeddings ? "vector" : "vectorless" };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasChatModels = state.models.some((model) => model.supportsChat);

  async function chooseFolder() {
    setError(null);
    try {
      const rootPath = await window.fsChat.selectRootFolder();
      if (!rootPath) return;
      const result = await window.fsChat.inspectRootFolder(rootPath);
      setInspection(result);
      setName(result.existingChannel?.displayName ?? result.defaultDisplayName);
    } catch (caught) {
      setError(toErrorMessage(caught));
    }
  }

  async function create() {
    if (!inspection) return;
    setBusy(true);
    setError(null);
    try {
      const chatModel = selection.chatModelId ? lookup.modelById[selection.chatModelId] : undefined;
      await actions.createKnowledgeBase({
        rootPath: inspection.rootPath,
        displayName: name.trim(),
        preferredConnectionId: chatModel?.connectionId ?? null,
        chatModelId: selection.chatModelId,
        embeddingModelId: selection.retrievalMode === "vector" ? selection.embeddingModelId : null,
        retrievalMode: selection.retrievalMode
      });
    } catch (caught) {
      setError(toErrorMessage(caught));
      setBusy(false);
    }
  }

  if (!hasChatModels) {
    return (
      <Modal title="New knowledge base" onClose={actions.closeNewKb} size="md">
        <EmptyState
          icon={KeyRound}
          title="Connect an AI provider first"
          actions={
            <Button variant="primary" onClick={() => actions.openAppSettings("providers")}>
              Open Settings → Providers
            </Button>
          }
        >
          Hello Files needs at least one AI model to answer questions. Your organisation may provide an Azure OpenAI endpoint, or
          you can use Ollama to keep everything on this computer.
        </EmptyState>
      </Modal>
    );
  }

  const existing = inspection?.existingChannel ?? null;
  const destination = describeDataDestination(selection, lookup, state.settings);
  const canNext = [
    Boolean(inspection) && !existing,
    name.trim().length > 0 && Boolean(selection.chatModelId),
    !validateSelection(selection),
    destination.tone !== "blocked"
  ][step];

  return (
    <Modal
      title="New knowledge base"
      description="Point Hello Files at a folder, then ask questions about its documents."
      onClose={actions.closeNewKb}
      dismissible={!busy}
      size="lg"
      footer={
        <>
          {step > 0 ? (
            <Button onClick={() => setStep(step - 1)} disabled={busy} className="mr-auto">
              Back
            </Button>
          ) : null}
          <Button onClick={actions.closeNewKb} disabled={busy}>
            Cancel
          </Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={() => setStep(step + 1)} disabled={!canNext}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void create()} disabled={!canNext} loading={busy}>
              Create and start indexing
            </Button>
          )}
        </>
      }
    >
      <ol className="mb-5 flex items-center gap-2" aria-label="Steps">
        {STEPS.map((label, index) => (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-2" aria-current={index === step ? "step" : undefined}>
            <span
              className={cx(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                index < step ? "border-accent bg-accent text-accent-fg" : index === step ? "border-accent text-accent" : "border-border text-text-muted"
              )}
            >
              {index < step ? <Check className="h-3.5 w-3.5" aria-hidden /> : index + 1}
            </span>
            <span className={cx("truncate text-xs font-medium", index === step ? "text-text" : "text-text-muted")}>{label}</span>
            {index < STEPS.length - 1 ? <span className="h-px min-w-[12px] flex-1 bg-border" aria-hidden /> : null}
          </li>
        ))}
      </ol>

      <div className="min-h-[260px] space-y-4">
        {step === 0 ? (
          <>
            <p className="text-sm text-text-muted">
              Choose a folder with the documents you want to ask about. Subfolders are included. Hello Files only reads your files;
              it never changes, moves or uploads the folder.
            </p>
            <div className="flex items-center gap-2">
              <div className="control flex h-8 min-w-0 flex-1 items-center bg-surface-2 text-text-muted" title={inspection?.rootPath}>
                <span className="truncate">{inspection?.rootPath ?? "No folder selected"}</span>
              </div>
              <Button variant={inspection ? "secondary" : "primary"} icon={FolderOpen} onClick={() => void chooseFolder()}>
                {inspection ? "Change…" : "Choose folder…"}
              </Button>
            </div>
            {existing ? (
              <Callout
                tone="info"
                title="This folder is already a knowledge base"
                actions={
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      actions.closeNewKb();
                      void actions.selectChannel(existing.id);
                    }}
                  >
                    Open “{existing.displayName}”
                  </Button>
                }
              >
                Open the existing one instead, or choose a different folder.
              </Callout>
            ) : inspection?.hasExistingIndex ? (
              <Callout tone="success" title="Existing index found">
                A previous index for this folder will be reused, so only new or changed files need to be read.
              </Callout>
            ) : null}
          </>
        ) : null}

        {step === 1 ? (
          <>
            <Field label="Name" htmlFor={nameId} hint="Shown in the sidebar. You can rename it later.">
              <TextInput id={nameId} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} data-autofocus />
            </Field>
            <ChatModelField value={selection.chatModelId} onChange={(id) => setSelection((current) => withChatModel(current, id, lookup))} />
          </>
        ) : null}

        {step === 2 ? (
          <>
            <SearchTypeFields selection={selection} onChange={setSelection} />
            <DataFlowNote selection={selection} />
          </>
        ) : null}

        {step === 3 ? (
          <>
            <dl className="divide-y divide-border rounded-md border border-border text-sm">
              <ReviewRow label="Folder" value={inspection?.rootPath ?? ""} />
              <ReviewRow label="Name" value={name} />
              <ReviewRow label="Chat model" value={destination.chatModel?.displayName ?? "—"} />
              <ReviewRow
                label="Search type"
                value={
                  selection.retrievalMode === "vector"
                    ? `Semantic search (${destination.embeddingModel?.displayName ?? "—"})`
                    : "Keyword search"
                }
              />
            </dl>
            <DataFlowNote selection={selection} />
            <p className="text-xs text-text-muted">
              Indexing starts right away. You can watch progress on the Files tab and start chatting when it's ready.
            </p>
          </>
        ) : null}

        {error ? <Callout tone="danger">{error}</Callout> : null}
      </div>
    </Modal>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 px-3 py-2">
      <dt className="text-text-muted">{label}</dt>
      <dd className="break-anywhere text-text">{value}</dd>
    </div>
  );
}
