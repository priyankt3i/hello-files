/**
 * Link / URL policy for assistant answers rendered by components/rich/rich-markdown.tsx
 * (react-markdown + remark-gfm + rehype-sanitize, no rehype-raw).
 *
 * Security properties (keep them when editing):
 *  - Raw HTML in model output is never interpreted (no rehype-raw); rehype-sanitize runs as defence in depth.
 *  - Only http(s) links become clickable; clicks are intercepted and sent to window.fsChat.openExternalUrl,
 *    never handled by in-app navigation. mailto: links are shown as text (the main process only opens http(s)).
 *  - Images from model output are never loaded (alt text is shown instead).
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** react-markdown urlTransform: keep http(s)/mailto URLs, drop everything else (javascript:, file:, data:, relative). */
export function safeUrlTransform(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? trimmed : "";
  } catch {
    return "";
  }
}

/** True when the href may be opened externally (http/https, no embedded credentials). */
export function isExternalHttpUrl(href: string | undefined | null): href is string {
  if (!href) return false;
  try {
    const parsed = new URL(href);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** Returns the external-link anchor that was clicked inside rendered markdown, if any. */
export function findExternalLink(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  return target.closest("a[data-external-link='true']") as HTMLAnchorElement | null;
}
