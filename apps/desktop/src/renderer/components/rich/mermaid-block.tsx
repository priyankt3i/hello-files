import { useEffect, useRef, useState } from "react";
import { Code2, Copy, Download, Image as ImageIcon, Maximize2 } from "lucide-react";
import { describeMermaidError, mermaidTitle, renderMermaidSvg } from "../../lib/mermaid-render";
import { copyText, exportFileName, savePng, saveSvg, serializeSvgElement } from "../../lib/rich-export";
import { readToken, useNearViewport, useResolvedTheme } from "../../lib/rich-theme";
import { DiagramViewer } from "./diagram-viewer";
import { ActionButton, BlockToolbar, ToolbarButton } from "./toolbar";

type State = { status: "pending" } | { status: "ok"; svg: string } | { status: "error"; error: string };

export function MermaidBlock({ source }: { source: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const figureRef = useRef<HTMLDivElement | null>(null);
  const visible = useNearViewport(rootRef);
  const theme = useResolvedTheme();
  const [state, setState] = useState<State>({ status: "pending" });
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const title = mermaidTitle(source);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    renderMermaidSvg(source, theme).then(
      (svg) => {
        if (!cancelled) setState({ status: "ok", svg });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", error: describeMermaidError(error) });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [source, theme, visible]);

  function currentSvg() {
    const svg = figureRef.current?.querySelector("svg");
    if (!svg) throw new Error("Diagram not rendered.");
    return serializeSvgElement(svg);
  }

  function saveCurrentSvg() {
    return saveSvg(currentSvg().markup, exportFileName(title, "svg"));
  }

  async function saveCurrentPng() {
    const { markup, width, height } = currentSvg();
    await savePng(markup, width, height, readToken("--surface"), exportFileName(title, "png"));
  }

  if (state.status === "error") {
    return (
      <div className="rich-block" ref={rootRef}>
        <BlockToolbar title="mermaid" label="Diagram source actions">
          <ActionButton icon={Copy} label="Copy source" doneLabel="Copied" action={() => copyText(source)} />
        </BlockToolbar>
        <div className="rich-note rich-note-warning" role="note">
          Couldn&apos;t render diagram: {state.error}
        </div>
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  const ready = state.status === "ok";
  return (
    <div className="rich-block" ref={rootRef}>
      <BlockToolbar title={title} label={`${title} actions`}>
        <ToolbarButton
          icon={Code2}
          label={showSource ? "Hide source" : "Show source"}
          pressed={showSource}
          onClick={() => setShowSource((value) => !value)}
        />
        <ActionButton icon={Copy} label="Copy source" doneLabel="Copied" action={() => copyText(source)} />
        {ready ? (
          <>
            <ToolbarButton icon={Maximize2} label="Expand" onClick={() => setExpanded(true)} />
            <ActionButton icon={Download} label="Save SVG" doneLabel="Saved" action={saveCurrentSvg} />
            <ActionButton icon={ImageIcon} label="Save PNG" doneLabel="Saved" action={saveCurrentPng} />
          </>
        ) : null}
      </BlockToolbar>
      {ready ? (
        <div
          ref={figureRef}
          className="rich-figure"
          role="img"
          aria-label={`${title}. Double-click to enlarge.`}
          title="Double-click to enlarge"
          onDoubleClick={() => setExpanded(true)}
          // Safe: produced by mermaid (securityLevel "strict") and sanitised with DOMPurify's SVG profile.
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      ) : (
        <div className="rich-placeholder" role="status">
          Rendering diagram…
        </div>
      )}
      {expanded && ready ? (
        <DiagramViewer
          svgMarkup={state.svg}
          title={title}
          onClose={() => setExpanded(false)}
          onSaveSvg={saveCurrentSvg}
          onSavePng={saveCurrentPng}
        />
      ) : null}
      {showSource ? (
        <pre className="border-t border-border">
          <code>{source}</code>
        </pre>
      ) : null}
    </div>
  );
}
