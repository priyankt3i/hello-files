import { useEffect, useState } from "react";
import type { Channel } from "@fschat/shared";
import { DEFAULT_MAX_FILE_SIZE_MB } from "@fschat/shared";
import { toErrorMessage } from "../../lib/format";
import { useAppStore } from "../../state/store";
import { Button } from "../ui/button";
import { Callout } from "../ui/feedback";
import { Section, Toggle } from "../ui/form";
import { FileFilterFields } from "./file-filter-fields";

export function SyncSection({ channel }: { channel: Channel }) {
  const { actions } = useAppStore();
  const [patterns, setPatterns] = useState<string[]>(channel.excludePatterns);
  const [savingPatterns, setSavingPatterns] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(patterns) !== JSON.stringify(channel.excludePatterns);

  useEffect(() => {
    setPatterns(channel.excludePatterns);
  }, [channel.id, channel.excludePatterns]);

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
      await actions.updateChannelSettings({ channelId: channel.id, excludePatterns: patterns });
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setSavingPatterns(false);
    }
  }

  return (
    <Section title="Sync & file filters" description="Keep this knowledge base up to date and choose which files to include or exclude.">
      <div className="space-y-5">
        <Toggle
          checked={channel.autoSync}
          disabled={savingToggle}
          onChange={(value) => void setAutoSync(value)}
          label="Sync automatically"
          description="Watches the folder while Hello Files is open and picks up new, changed and deleted files in the background. Chat stays available during a sync."
        />
        <FileFilterFields patterns={patterns} onChange={setPatterns} />
        <div className="rounded-md bg-surface-2 px-3 py-2 text-xs leading-relaxed text-text-muted">
          Always skipped: hidden files and folders, <code className="font-mono">.git</code>, <code className="font-mono">node_modules</code>,
          Office lock files (<code className="font-mono">~$*</code>), and files larger than {DEFAULT_MAX_FILE_SIZE_MB} MB.
        </div>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <div className="flex items-center justify-end gap-2">
          {dirty && channel.lastIndexedAt ? <span className="mr-auto text-xs text-text-muted">Saving starts a sync to apply the new rules.</span> : null}
          <Button onClick={() => setPatterns(channel.excludePatterns)} disabled={!dirty || savingPatterns}>
            Discard changes
          </Button>
          <Button variant="primary" onClick={() => void savePatterns()} disabled={!dirty} loading={savingPatterns}>
            Save file filters
          </Button>
        </div>
      </div>
    </Section>
  );
}

