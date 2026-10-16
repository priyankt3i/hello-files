import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, Download, Image as ImageIcon, Maximize, Minus, Plus, ScanSearch, X } from "lucide-react";

const MIN_SCALE = 0.05;
const MAX_SCALE = 12;
const FIT_PADDING = 0.92;
/** Below this scale the whole diagram would be too small to read, so the viewer opens at a readable size instead. */
const READABLE_MIN_SCALE = 0.5;
const KEY_PAN_STEP = 60;

interface View {
  scale: number;
  x: number;
  y: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Gives the root <svg> an explicit pixel size taken from its viewBox. Mermaid emits width="100%" plus a max-width style,
 * which cannot be zoomed in a free-form viewer. Works on the opening tag only, so the sanitised body is left untouched.
 */
export function withNaturalSize(markup: string): { html: string; width: number; height: number } {
  const match = /<svg\b[^>]*>/i.exec(markup);
  const viewBox = match ? /viewBox="([^"]+)"/i.exec(match[0]) : null;
  const parts = viewBox ? viewBox[1].trim().split(/[\s,]+/).map(Number) : [];
  const width = parts.length === 4 && parts[2] > 0 ? parts[2] : 800;
  const height = parts.length === 4 && parts[3] > 0 ? parts[3] : 600;
  if (!match) return { html: markup, width, height };
  const stripped = match[0].replace(/\s(?:width|height|style)="[^"]*"/gi, "");
  const sized = stripped.replace(/\/?>$/, (end) => ` width="${width}" height="${height}" style="max-width:none"${end}`);
  return { html: markup.replace(match[0], sized), width, height };
}

/**
 * Full-window viewer for a rendered diagram: wheel / buttons / keys to zoom, drag to move, Fit to reset.
 * `svgMarkup` must already be sanitised (it is produced by mermaid in strict mode and run through DOMPurify).
 */
export function DiagramViewer({
  svgMarkup,
  title,
  onClose,
  onSaveSvg,
  onSavePng
}: {
  svgMarkup: string;
  title: string;
  onClose: () => void;
  onSaveSvg: () => void | Promise<void>;
  onSavePng: () => void | Promise<void>;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const naturalRef = useRef({ width: 0, height: 0 });
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [view, setViewState] = useState<View>(viewRef.current);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const setView = useCallback((next: View) => {
    viewRef.current = next;
    setViewState(next);
    setNotice(null);
  }, []);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    const { width, height } = naturalRef.current;
    if (!viewport || !width || !height) return;
    const rect = viewport.getBoundingClientRect();
    const scale = clamp(Math.min(rect.width / width, rect.height / height) * FIT_PADDING, MIN_SCALE, 2);
    setView({ scale, x: (rect.width - width * scale) / 2, y: (rect.height - height * scale) / 2 });
  }, [setView]);

  /** Fits the diagram's width (readable text for tall diagrams), aligned to the top so the user can drag down. */
  const fitWidth = useCallback((maxScale = MAX_SCALE) => {
    const viewport = viewportRef.current;
    const { width } = naturalRef.current;
    if (!viewport || !width) return;
    const rect = viewport.getBoundingClientRect();
    const scale = clamp((rect.width / width) * FIT_PADDING, MIN_SCALE, maxScale);
    setView({ scale, x: (rect.width - width * scale) / 2, y: 24 });
  }, [setView]);

  /** Zooms to `scale`, keeping the point (px, py) of the viewport fixed. Defaults to the viewport centre. */
  const zoomTo = useCallback(
    (scale: number, px?: number, py?: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const anchorX = px ?? rect.width / 2;
      const anchorY = py ?? rect.height / 2;
      const current = viewRef.current;
      const next = clamp(scale, MIN_SCALE, MAX_SCALE);
      const ratio = next / current.scale;
      setView({ scale: next, x: anchorX - (anchorX - current.x) * ratio, y: anchorY - (anchorY - current.y) * ratio });
    },
    [setView]
  );

  const prepared = useMemo(() => withNaturalSize(svgMarkup), [svgMarkup]);
  naturalRef.current = { width: prepared.width, height: prepared.height };

  // Open showing the whole diagram, unless that would be unreadably small.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const { width, height } = naturalRef.current;
    if (!viewport || !width || !height) return;
    const rect = viewport.getBoundingClientRect();
    const contain = Math.min(rect.width / width, rect.height / height) * FIT_PADDING;
    if (contain >= READABLE_MIN_SCALE) {
      fit();
      return;
    }
    fitWidth(1);
    setNotice("Large diagram: showing a readable size. Press 0 to fit the whole diagram.");
  }, [prepared, fit, fitWidth]);

  // Wheel zoom needs a non-passive listener so the page behind doesn't scroll.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      zoomTo(viewRef.current.scale * factor, event.clientX - rect.left, event.clientY - rect.top);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  // Re-fit when the window is resized.
  useEffect(() => {
    const onResize = () => fit();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fit]);

  // Restore focus to the opener on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    viewportRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  // Keyboard works from anywhere while the viewer is open (focus may sit on a toolbar button or the page body).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const current = viewRef.current;
      switch (event.key) {
        case "Escape":
          event.stopPropagation();
          onCloseRef.current();
          break;
        case "+":
        case "=":
          zoomTo(current.scale * 1.25);
          break;
        case "-":
        case "_":
          zoomTo(current.scale / 1.25);
          break;
        case "0":
          fit();
          break;
        case "1":
          zoomTo(1);
          break;
        case "w":
        case "W":
          fitWidth();
          break;
        case "ArrowLeft":
          setView({ ...current, x: current.x + KEY_PAN_STEP });
          break;
        case "ArrowRight":
          setView({ ...current, x: current.x - KEY_PAN_STEP });
          break;
        case "ArrowUp":
          setView({ ...current, y: current.y + KEY_PAN_STEP });
          break;
        case "ArrowDown":
          setView({ ...current, y: current.y - KEY_PAN_STEP });
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [fit, fitWidth, setView, zoomTo]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = viewRef.current;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: current.x, originY: current.y };
    setDragging(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView({ ...viewRef.current, x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY });
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  }

  const percent = Math.round(view.scale * 100);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-surface"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} — enlarged view`}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{title}</h2>
        <span className="hidden max-w-[28rem] truncate text-xs text-text-muted md:inline" role="status">
          {notice ?? "Scroll to zoom · drag to move · 0 fit · W fit width · 1 actual size · Esc close"}
        </span>
        <div className="flex items-center gap-1" role="group" aria-label="Zoom">
          <ViewerButton label="Zoom out" onClick={() => zoomTo(view.scale / 1.25)}>
            <Minus className="h-4 w-4" aria-hidden />
          </ViewerButton>
          <span className="w-12 text-center text-xs tabular-nums text-text-muted" aria-live="polite">
            {percent}%
          </span>
          <ViewerButton label="Zoom in" onClick={() => zoomTo(view.scale * 1.25)}>
            <Plus className="h-4 w-4" aria-hidden />
          </ViewerButton>
          <ViewerButton label="Fit to window" onClick={fit}>
            <Maximize className="h-4 w-4" aria-hidden />
          </ViewerButton>
          <ViewerButton label="Fit width" onClick={() => fitWidth()}>
            <ArrowLeftRight className="h-4 w-4" aria-hidden />
          </ViewerButton>
          <ViewerButton label="Actual size (100%)" onClick={() => zoomTo(1)}>
            <ScanSearch className="h-4 w-4" aria-hidden />
          </ViewerButton>
        </div>
        <div className="mx-1 h-5 w-px bg-border" aria-hidden />
        <ViewerButton label="Save SVG" onClick={() => void onSaveSvg()}>
          <Download className="h-4 w-4" aria-hidden />
        </ViewerButton>
        <ViewerButton label="Save PNG" onClick={() => void onSavePng()}>
          <ImageIcon className="h-4 w-4" aria-hidden />
        </ViewerButton>
        <ViewerButton label="Close" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden />
        </ViewerButton>
      </div>
      <div
        ref={viewportRef}
        tabIndex={0}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-bg outline-none"
        style={{ cursor: dragging ? "grabbing" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={fit}
      >
        <div
          ref={contentRef}
          className="absolute left-0 top-0 origin-top-left will-change-transform"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          // Safe: produced by mermaid (securityLevel "strict") and sanitised with DOMPurify's SVG profile.
          dangerouslySetInnerHTML={{ __html: prepared.html }}
        />
      </div>
    </div>,
    document.body
  );
}

function ViewerButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      {children}
    </button>
  );
}
