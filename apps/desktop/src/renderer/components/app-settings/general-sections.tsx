import { useState } from "react";
import { Monitor, Moon, Sun, Trash2 } from "lucide-react";
import { describeChannelDestination, describeDataDestination } from "../../lib/providers";
import type { ThemeMode } from "../../lib/theme";
import { useAppStore } from "../../state/store";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Callout } from "../ui/feedback";
import { SegmentedControl, Toggle } from "../ui/form";

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-base font-semibold text-text">{title}</h3>
      <p className="mt-0.5 text-sm text-text-muted">{description}</p>
    </div>
  );
}

export function PrivacySection() {
  const { state, actions, lookup } = useAppStore();
  const [busy, setBusy] = useState(false);
  const localOnly = state.settings.dataPolicy === "local-only";
  // Evaluate against local-only regardless of the current setting, to show what would be blocked.
  const wouldBlock = state.channels.filter(
    (channel) => describeDataDestination(channel, lookup, { dataPolicy: "local-only" }).tone === "blocked"
  );

  return (
    <div className="space-y-4">
      <SectionHeading title="Privacy" description="Control whether any content may leave this computer." />
      <div className="rounded-md border border-border bg-surface p-4 shadow-card">
        <Toggle
          checked={localOnly}
          disabled={busy}
          onChange={async (value) => {
            setBusy(true);
            await actions.setDataPolicy(value ? "local-only" : "any");
            setBusy(false);
          }}
          label="Local-only mode"
          description="Only AI models running on this computer (Ollama) can be used. Cloud providers such as OpenAI, Azure OpenAI, Anthropic and Google are blocked for chatting, indexing and adding new connections. Use this for confidential or regulated content."
        />
      </div>

      <div className="rounded-md border border-border bg-surface p-4 text-sm shadow-card">
        <div className="font-medium text-text">What is sent where</div>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-text-muted">
          <li>Your files are read on this computer. The search index is stored in this app's data folder, not in your folders.</li>
          <li>When you ask a question, the question and the most relevant excerpts from your files are sent to the knowledge base's chat model.</li>
          <li>With semantic search, file text is also sent to the embedding model while indexing. Keyword search sends nothing while indexing.</li>
          <li>With Ollama on this computer, nothing leaves your machine.</li>
        </ul>
      </div>

      {wouldBlock.length > 0 ? (
        <Callout
          tone={localOnly ? "danger" : "info"}
          title={localOnly ? "These knowledge bases are blocked until they use local models:" : "Turning on local-only mode would block:"}
        >
          <ul className="mt-1 space-y-1">
            {wouldBlock.map((channel) => (
              <li key={channel.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-text">{channel.displayName}</span>
                <span className="text-xs">{describeChannelDestination(channel, lookup, { dataPolicy: "any" }).label}</span>
              </li>
            ))}
          </ul>
        </Callout>
      ) : state.channels.length > 0 ? (
        <Callout tone="success">All knowledge bases use models on this computer.</Callout>
      ) : null}
    </div>
  );
}

export function AppearanceSection({ theme, onThemeChange }: { theme: ThemeMode; onThemeChange: (theme: ThemeMode) => void }) {
  return (
    <div className="space-y-4">
      <SectionHeading title="Appearance" description="Choose how Hello Files looks." />
      <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface p-4 shadow-card">
        <div>
          <div className="text-sm font-medium text-text">Theme</div>
          <div className="text-xs text-text-muted">System follows your Windows light/dark setting.</div>
        </div>
        <SegmentedControl<ThemeMode>
          label="Theme"
          value={theme}
          onChange={onThemeChange}
          options={[
            { value: "light", label: <><Sun className="h-3.5 w-3.5" aria-hidden /> Light</> },
            { value: "dark", label: <><Moon className="h-3.5 w-3.5" aria-hidden /> Dark</> },
            { value: "system", label: <><Monitor className="h-3.5 w-3.5" aria-hidden /> System</> }
          ]}
        />
      </div>
    </div>
  );
}

export function StorageSection() {
  const { state, actions } = useAppStore();
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div className="space-y-4">
      <SectionHeading title="Storage" description="Where Hello Files keeps its own data." />
      <div className="rounded-md border border-border bg-surface p-4 shadow-card">
        <div className="text-sm font-medium text-text">Search index location</div>
        <p className="mt-0.5 text-xs text-text-muted">
          Indexes contain text extracted from your files. They're kept in your user profile, separate from your folders.
        </p>
        <div className="break-anywhere mt-2 rounded bg-surface-2 px-3 py-2 font-mono text-xs text-text">{state.indexStorageDir || "Unknown"}</div>
      </div>

      <div className="rounded-md border border-danger/30 bg-surface p-4 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-danger">Reset all app data</div>
            <p className="mt-0.5 text-xs leading-relaxed text-text-muted">
              Deletes every knowledge base, chat, search index, provider connection and stored API key. Your original files are not
              touched.
            </p>
          </div>
          <Button variant="danger" icon={Trash2} onClick={() => setConfirmReset(true)}>
            Reset app data
          </Button>
        </div>
      </div>

      {confirmReset ? (
        <ConfirmDialog
          title="Reset all app data?"
          confirmLabel="Reset everything"
          confirmText="RESET"
          onConfirm={actions.resetAppData}
          onClose={() => setConfirmReset(false)}
        >
          <p>
            This permanently removes {state.channels.length} knowledge base{state.channels.length === 1 ? "" : "s"}, all chats, all
            search indexes, and {state.connections.length} provider connection{state.connections.length === 1 ? "" : "s"} with
            their API keys. This can't be undone.
          </p>
          <p className="font-medium text-text">Your original files are not touched.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
