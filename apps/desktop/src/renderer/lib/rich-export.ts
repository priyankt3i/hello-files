/**
 * Browser-side export helpers for rich answer blocks (tables, diagrams, charts).
 * Everything stays local: files are saved through a Blob + <a download> (Electron shows its save dialog),
 * and SVG -> PNG goes through an <img src="data:..."> and a canvas (allowed by img-src 'self' data:).
 */

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** File-name-safe slug from a title. */
export function exportFileName(title: string, extension: string, fallback = "diagram") {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || fallback}.${extension}`;
}

/** Serialises an in-document <svg> element to a standalone SVG file string with explicit pixel size. */
export function serializeSvgElement(svg: SVGSVGElement): { markup: string; width: number; height: number } {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const box = svg.viewBox?.baseVal;
  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(box && box.width > 0 ? box.width : rect.width || 800));
  const height = Math.max(1, Math.round(box && box.height > 0 ? box.height : rect.height || 600));
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.style.removeProperty("max-width");
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const markup = new XMLSerializer().serializeToString(clone);
  return { markup, width, height };
}

export function saveSvg(markup: string, fileName: string) {
  downloadBlob(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${markup}`], { type: "image/svg+xml" }), fileName);
}

/** Rasterises SVG markup to a PNG blob (2x scale) on an opaque background. */
export function svgToPngBlob(markup: string, width: number, height: number, background: string, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.min(16_384, Math.round(width * scale));
        canvas.height = Math.min(16_384, Math.round(height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas is not available.");
        context.fillStyle = background;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG export failed."))), "image/png");
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    image.onerror = () => reject(new Error("Couldn't load the SVG for PNG export."));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });
}

export async function savePng(markup: string, width: number, height: number, background: string, fileName: string) {
  downloadBlob(await svgToPngBlob(markup, width, height, background), fileName);
}
