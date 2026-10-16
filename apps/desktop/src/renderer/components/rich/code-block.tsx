import { Copy } from "lucide-react";
import { copyText } from "../../lib/rich-export";
import { ActionButton, BlockToolbar } from "./toolbar";

export function CodeBlock({ code, language, note }: { code: string; language: string; note?: string }) {
  return (
    <div className="rich-block">
      <BlockToolbar title={language || "code"} label={`${language || "Code"} block actions`}>
        <ActionButton icon={Copy} label="Copy" doneLabel="Copied" action={() => copyText(code)} />
      </BlockToolbar>
      {note ? <div className="rich-note rich-note-warning">{note}</div> : null}
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
