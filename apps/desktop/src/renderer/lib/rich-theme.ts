import { useEffect, useState, type RefObject } from "react";

export type ResolvedTheme = "light" | "dark";

/** Current resolved theme from <html data-theme>, which lib/theme.ts keeps up to date. */
export function readResolvedTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Re-renders when the app switches between light and dark. */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(readResolvedTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readResolvedTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/**
 * Reads a semantic colour token ("--surface", "--chart-1", ...) as a comma-separated rgb()/rgba() string
 * (the legacy syntax, which every chart/diagram colour parser understands).
 */
export function readToken(name: string, alpha?: number): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parts = raw.split(/\s+/).map(Number);
  const [r, g, b] = parts.length === 3 && parts.every(Number.isFinite) ? parts : [128, 128, 128];
  return alpha === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Categorical chart palette (fixed order, 8 slots) defined in styles/index.css. */
export function readChartPalette(): string[] {
  return Array.from({ length: 8 }, (_, index) => readToken(`--chart-${index + 1}`));
}

/** Defers work until the element is near the viewport (stays true once visible). */
export function useNearViewport(ref: RefObject<Element | null>, rootMargin = "600px"): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin, visible]);
  return visible;
}
