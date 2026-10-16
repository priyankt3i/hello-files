import { useId, useState } from "react";
import type { Channel } from "@fschat/shared";
import { DEFAULT_MAX_FILE_SIZE_MB } from "@fschat/shared";
import { toErrorMessage } from "../../lib/format";
import { useAppStore } from "../../state/store";
import { Button } from "../ui/button";
import { Callout } from "../ui/feedback";
import { Field, Section, TextArea, Toggle } from "../ui/form";

function parsePatterns(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function SyncSection({ channel }: { channel: Channel }) {
  const { actions } = useAppStore();
  const id = useId();
  const [patterns, setPatterns] = useState(channel.excludePatterns.join("\n"));
  const [savingPatterns, setSavingPatterns] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(parsePatterns(patterns)) !== JSON.stringify(channel.excludePatterns);

  async function setAutoSync(autoSync: boolean) {
    setSavingToggle(true);
    setError(null);
    try {
      await actions.updateChannelSettings({ channelId: channel.id, autoSync });
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setSavingToggle(false);
    }
  }

  async function savePatterns() {
    setSavingPatterns(true);
    setError(null);
    try {
      await actions.updateChannelSettings({ channelId: channel.id, excludePatterns: parsePatterns(patterns) });
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setSavingPatterns(false);
    }
  }

  return (
    <Section title="Sync" description="Keep this knowledge base up to date as files in the folder change.">
      <div className="space-y-5">
        <Toggle
          checked={channel.autoSync}
          disabled={savingToggle}
          onChange={(value) => void setAutoSync(value)}
          label="Sync automatically"
          description="Watches the folder while Hello Files is open and picks up new, changed and deleted files in the background. Chat stays available during a sync."
        />
        <Field
          label="Excluded files and folders"
          htmlFor={id}
          hint={
            <>
              One pattern per line, relative to the folder. Examples: <code className="font-mono">archive/**</code>,{" "}
              <code className="font-mono">*.tmp</code>. Lines starting with # are ignored.
            </>
          }
        >
          <TextArea
            id={id}
            rows={5}
            value={patterns}
            onChange={(event) => setPatterns(event.target.value)}
            placeholder={"archive/**\n*.tmp"}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>
        <div className="rounded-md bg-surface-2 px-3 py-2 text-xs leading-relaxed text-text-muted">
          Always skipped: hidden files and folders, <code className="font-mono">.git</code>, <code className="font-mono">node_modules</code>,
          Office lock files (<code className="font-mono">~$*</code>), and files larger than {DEFAULT_MAX_FILE_SIZE_MB} MB.
        </div>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <div className="flex items-center justify-end gap-2">
          {dirty && channel.lastIndexedAt ? <span className="mr-auto text-xs text-text-muted">Saving starts a sync to apply the new rules.</span> : null}
          <Button onClick={() => setPatterns(channel.excludePatterns.join("\n"))} disabled={!dirty || savingPatterns}>
            Discard changes
          </Button>
          <Button variant="primary" onClick={() => void savePatterns()} disabled={!dirty} loading={savingPatterns}>
            Save exclusions
          </Button>
        </div>
      </div>
    </Section>
  );
}
