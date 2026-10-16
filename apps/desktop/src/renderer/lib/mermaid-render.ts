/**
 * Lazy Mermaid renderer. `mermaid` and `dompurify` are dynamically imported so they live in separate
 * chunks and are only loaded when an answer actually contains a ```mermaid block.
 *
 * Security: securityLevel "strict" (no click handlers / HTML labels from the source), htmlLabels off
 * (pure SVG text, so no <foreignObject> and the PNG export canvas is never tainted), and the produced
 * SVG is sanitised with DOMPurify's SVG profile before it is inserted. Works under script-src 'self'
 * (no eval); inline <style> inside the SVG needs style-src 'unsafe-inline', which the app already allows.
 */
import type { ResolvedTheme } from "./rich-theme";

export const MAX_MERMAID_SOURCE = 20_000;

type MermaidApi = (typeof import("mermaid"))["default"];
type Purifier = (typeof import("dompurify"))["default"];

let modules: Promise<{ mermaid: MermaidApi; purify: Purifier }> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

function load() {
  modules ??= Promise.all([import("mermaid"), import("dompurify")]).then(([mermaidModule, purifyModule]) => ({
    mermaid: mermaidModule.default,
    purify: purifyModule.default
  }));
  // Allow a retry if the chunk failed to load.
  modules.catch(() => {
    modules = null;
  });
  return modules;
}

/** Renders Mermaid source to sanitised SVG markup. Throws with a readable message on parse/render errors. */
export function renderMermaidSvg(source: string, theme: ResolvedTheme): Promise<string> {
  // Mermaid keeps global config and temporary DOM nodes, so renders are serialised.
  const task = async () => {
    if (source.length > MAX_MERMAID_SOURCE) {
      throw new Error(`Diagram source is too large (over ${MAX_MERMAID_SOURCE.toLocaleString()} characters).`);
    }
    const { mermaid, purify } = await load();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "default",
      htmlLabels: false,
      suppressErrorRendering: true,
      maxTextSize: MAX_MERMAID_SOURCE,
      maxEdges: 500,
      fontFamily: getComputedStyle(document.body).fontFamily || "sans-serif"
    });
    counter += 1;
    const id = `fschat-mermaid-${counter}`;
    try {
      await mermaid.parse(source);
      const { svg } = await mermaid.render(id, source);
      const clean = purify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ["a", "image", "foreignObject", "script"],
        FORBID_ATTR: ["href", "xlink:href"]
      });
      return fitViewBoxToContent(clean);
    } finally {
      // Mermaid can leave its temporary container behind when a render fails.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  };
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

const VIEWBOX_PADDING = 12;

/**
 * Mermaid sizes the SVG from its own text measurements, which can come out smaller than what is actually drawn
 * (different fonts at measure time), clipping the right/bottom edge of larger diagrams and leaving blank margins on the
 * other sides. This measures the real drawn bounds in an off-screen container and sets the viewBox to match.
 * Falls back to the original markup if anything can't be measured.
 */
export function fitViewBoxToContent(markup: string): string {
  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.style.cssText = "position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none";
  try {
    container.innerHTML = markup;
    document.body.appendChild(container);
    const svg = container.querySelector("svg");
    if (!svg) return markup;
    const box = svg.getBBox();
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return markup;
    const x = box.x - VIEWBOX_PADDING;
    const y = box.y - VIEWBOX_PADDING;
    const width = box.width + VIEWBOX_PADDING * 2;
    const height = box.height + VIEWBOX_PADDING * 2;
    const round = (value: number) => Math.round(value * 100) / 100;
    svg.setAttribute("viewBox", `${round(x)} ${round(y)} ${round(width)} ${round(height)}`);
    // Mermaid also caps the responsive width with an inline max-width that must track the new width.
    svg.style.maxWidth = `${round(width)}px`;
    return svg.outerHTML;
  } catch {
    return markup;
  } finally {
    container.remove();
  }
}

export function describeMermaidError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "Unknown error.";
}

/** Accessible name for a diagram: accTitle / front-matter title, else the diagram kind. */
export function mermaidTitle(source: string): string {
  const explicit =
    source.match(/^\s*accTitle\s*:\s*(.+)$/m)?.[1] ?? source.match(/^---[\s\S]*?^\s*title\s*:\s*(.+)$[\s\S]*?^---/m)?.[1];
  if (explicit?.trim()) return explicit.trim().slice(0, 120);
  const kind = source
    .replace(/^---[\s\S]*?\n---\s*\n/, "")
    .replace(/^\s*%%.*$/gm, "")
    .trim()
    .split(/\s+/)[0];
  const names: Record<string, string> = {
    graph: "Flowchart",
    flowchart: "Flowchart",
    sequenceDiagram: "Sequence diagram",
    classDiagram: "Class diagram",
    stateDiagram: "State diagram",
    "stateDiagram-v2": "State diagram",
    erDiagram: "Entity relationship diagram",
    gantt: "Gantt chart",
    pie: "Pie chart",
    mindmap: "Mind map",
    timeline: "Timeline",
    journey: "User journey",
    gitGraph: "Git graph",
    quadrantChart: "Quadrant chart"
  };
  return (kind && names[kind]) || "Diagram";
}
