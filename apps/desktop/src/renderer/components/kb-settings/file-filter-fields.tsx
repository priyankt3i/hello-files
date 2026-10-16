import { useEffect, useId, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { Field, TextArea, TextInput } from "../ui/form";

const COMMON_FILE_TYPES = [
  { ext: "doc", label: ".doc" },
  { ext: "docx", label: ".docx" },
  { ext: "docm", label: ".docm" },
  { ext: "pdf", label: ".pdf" },
  { ext: "xlsx", label: ".xlsx" },
  { ext: "xlsm", label: ".xlsm" },
  { ext: "csv", label: ".csv" },
  { ext: "rtf", label: ".rtf" },
  { ext: "txt", label: ".txt" },
  { ext: "md", label: ".md" }
] as const;

const QUICK_EXCLUDE_PATTERNS = [
  { pattern: "*Test Result*", label: "*Test Result*" },
  { pattern: "*.md", label: "*.md" },
  { pattern: "*.xml", label: "*.xml" },
  { pattern: "archive/**", label: "archive/**" }
] as const;

const INCLUDE_EXT_RE = /^!(?:\*\*\/)?\*\.([A-Za-z0-9_-]+)$/;

export type ParsedFileFilters = {
  includeExtensions: string[];
  includeNamePatterns: string[];
  excludePatterns: string[];
};

export function parseFileFilterPatterns(patterns: string[]): ParsedFileFilters {
  const includeExtensions: string[] = [];
  const includeNamePatterns: string[] = [];
  const excludePatterns: string[] = [];

  for (const raw of patterns) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const extMatch = INCLUDE_EXT_RE.exec(trimmed);
    if (extMatch) {
      const ext = extMatch[1].toLowerCase();
      if (!includeExtensions.includes(ext)) {
        includeExtensions.push(ext);
      }
    } else if (trimmed.startsWith("!")) {
      const inner = trimmed.slice(1).trim();
      if (inner && !includeNamePatterns.includes(inner)) {
        includeNamePatterns.push(inner);
      }
    } else if (!excludePatterns.includes(trimmed)) {
      excludePatterns.push(trimmed);
    }
  }

  return { includeExtensions, includeNamePatterns, excludePatterns };
}

export function buildFileFilterPatterns({
  includeExtensions,
  includeNamePatterns,
  excludePatterns
}: ParsedFileFilters): string[] {
  const result: string[] = [];
  for (const rawExt of includeExtensions) {
    const ext = rawExt.trim().replace(/^\*?\./, "").toLowerCase();
    if (ext) {
      const pattern = `!*.${ext}`;
      if (!result.includes(pattern)) result.push(pattern);
    }
  }
  for (const rawName of includeNamePatterns) {
    const trimmed = rawName.trim().replace(/^!+/, "").trim();
    if (!trimmed) continue;
    const glob =
      trimmed.includes("*") || trimmed.includes("?") || trimmed.includes("/") ? trimmed : `*${trimmed}*`;
    const pattern = `!${glob}`;
    if (!result.includes(pattern)) result.push(pattern);
  }
  for (const rawExclude of excludePatterns) {
    const trimmed = rawExclude.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cleaned = trimmed.startsWith("!") ? trimmed.slice(1).trim() : trimmed;
    if (cleaned && !result.includes(cleaned)) {
      result.push(cleaned);
    }
  }
  return result;
}

export function describeFileFilters(patterns: string[]): string {
  const { includeExtensions, includeNamePatterns, excludePatterns } = parseFileFilterPatterns(patterns);
  const parts: string[] = [];
  if (includeExtensions.length > 0) {
    parts.push(`Only ${includeExtensions.map((ext) => `.${ext}`).join(", ")}`);
  }
  if (includeNamePatterns.length > 0) {
    parts.push(`${includeExtensions.length > 0 ? "or filename" : "Filename"} matches ${includeNamePatterns.join(", ")}`);
  }
  if (excludePatterns.length > 0) {
    parts.push(`Excluding ${excludePatterns.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "All supported files (default)";
}

function splitCommaOrNewline(text: string): string[] {
  return text
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !item.startsWith("#"));
}

export function FileFilterFields({
  patterns,
  onChange,
  compact = false
}: {
  patterns: string[];
  onChange: (patterns: string[]) => void;
  compact?: boolean;
}) {
  const includeNameId = useId();
  const excludeId = useId();
  const parsed = parseFileFilterPatterns(patterns);

  const [includeNameText, setIncludeNameText] = useState(() => parsed.includeNamePatterns.join(", "));
  const [excludeText, setExcludeText] = useState(() => parsed.excludePatterns.join("\n"));
  const lastEmittedRef = useRef<string>(JSON.stringify(patterns));

  useEffect(() => {
    const serialized = JSON.stringify(patterns);
    if (serialized !== lastEmittedRef.current) {
      lastEmittedRef.current = serialized;
      const next = parseFileFilterPatterns(patterns);
      setIncludeNameText(next.includeNamePatterns.join(", "));
      setExcludeText(next.excludePatterns.join("\n"));
    }
  }, [patterns]);

  function emit(next: ParsedFileFilters) {
    const built = buildFileFilterPatterns(next);
    lastEmittedRef.current = JSON.stringify(built);
    onChange(built);
  }

  function toggleExtension(ext: string) {
    const lower = ext.toLowerCase();
    const removing = parsed.includeExtensions.includes(lower);
    const nextExts = removing ? parsed.includeExtensions.filter((item) => item !== lower) : [...parsed.includeExtensions, lower];
    let names = splitCommaOrNewline(includeNameText);
    if (removing) {
      // A name entry such as "*.java" is the same rule as the .java chip, so drop it too.
      names = names.filter((item) => item.toLowerCase().replace(/^!+/, "").replace(/^\*\*\//, "") !== `*.${lower}`);
      setIncludeNameText(names.join(", "));
    }
    emit({
      includeExtensions: nextExts,
      includeNamePatterns: names,
      excludePatterns: splitCommaOrNewline(excludeText)
    });
  }

  function setPresetExtensions(exts: string[]) {
    emit({
      includeExtensions: exts,
      includeNamePatterns: splitCommaOrNewline(includeNameText),
      excludePatterns: splitCommaOrNewline(excludeText)
    });
  }

  function handleIncludeNameChange(value: string) {
    setIncludeNameText(value);
    emit({
      includeExtensions: parsed.includeExtensions,
      includeNamePatterns: splitCommaOrNewline(value),
      excludePatterns: splitCommaOrNewline(excludeText)
    });
  }

  function handleExcludeChange(value: string) {
    setExcludeText(value);
    emit({
      includeExtensions: parsed.includeExtensions,
      includeNamePatterns: splitCommaOrNewline(includeNameText),
      excludePatterns: splitCommaOrNewline(value)
    });
  }

  function toggleQuickExclude(pattern: string) {
    const currentExcludes = splitCommaOrNewline(excludeText);
    const exists = currentExcludes.some((item) => item.toLowerCase() === pattern.toLowerCase());
    const nextExcludes = exists
      ? currentExcludes.filter((item) => item.toLowerCase() !== pattern.toLowerCase())
      : [...currentExcludes, pattern];
    const nextText = nextExcludes.join("\n");
    setExcludeText(nextText);
    emit({
      includeExtensions: parsed.includeExtensions,
      includeNamePatterns: splitCommaOrNewline(includeNameText),
      excludePatterns: nextExcludes
    });
  }

  return (
    <div className={cx("space-y-3.5", compact && "rounded-md border border-border bg-surface-2/40 p-3.5")}>
      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-text">Include only specific file types</span>
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => setPresetExtensions(["doc", "docx", "pdf", "xlsx"])}
              className="text-accent hover:underline"
            >
              Docs, PDF & Excel
            </button>
            {parsed.includeExtensions.length > 0 ? (
              <>
                <span className="text-text-muted">·</span>
                <button
                  type="button"
                  onClick={() => setPresetExtensions([])}
                  className="text-text-muted hover:text-text hover:underline"
                >
                  All supported types
                </button>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[
            ...COMMON_FILE_TYPES,
            // Extensions typed as filename patterns (for example *.java) show up as chips too.
            ...parsed.includeExtensions
              .filter((ext) => !COMMON_FILE_TYPES.some((common) => common.ext === ext))
              .map((ext) => ({ ext, label: `.${ext}` }))
          ].map(({ ext, label }) => {
            const active = parsed.includeExtensions.includes(ext);
            return (
              <button
                key={ext}
                type="button"
                aria-pressed={active}
                onClick={() => toggleExtension(ext)}
                className={cx(
                  "inline-flex h-6 items-center rounded border px-2 font-mono text-xs transition-colors",
                  active
                    ? "border-accent bg-accent/15 font-medium text-accent"
                    : "border-border bg-surface text-text-muted hover:border-text-muted/50 hover:text-text"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="mt-1 text-xs text-text-muted">
          {parsed.includeExtensions.length === 0
            ? "No file-type restriction — all supported document types will be indexed."
            : `Indexing ${parsed.includeExtensions.map((ext) => `.${ext}`).join(", ")} files${
                parsed.includeNamePatterns.length > 0 ? ", plus any file whose name matches the filename filter below" : ""
              }.`}
        </div>
      </div>

      <Field
        label="Also include filenames matching"
        htmlFor={includeNameId}
        hint={
          <>
            Optional. Comma-separated words or wildcards, e.g. <code className="font-mono">*FR*</code>,{" "}
            <code className="font-mono">FR, Spec</code> or <code className="font-mono">*.java</code>. These are added to the
            file types above: a file is indexed if it matches either. With neither set, all supported files are indexed.
          </>
        }
      >
        <TextInput
          id={includeNameId}
          value={includeNameText}
          onChange={(event) => handleIncludeNameChange(event.target.value)}
          placeholder="e.g. *FR*, *.java"
          spellCheck={false}
          className="font-mono text-xs"
        />
      </Field>

      <Field
        label="Exclude files or folders"
        htmlFor={excludeId}
        hint={
          <>
            One pattern per line (or comma-separated). Examples: <code className="font-mono">*Test Result*</code>,{" "}
            <code className="font-mono">*.md</code>, <code className="font-mono">archive/**</code>.
          </>
        }
      >
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-2xs text-text-muted">Quick exclude:</span>
          {QUICK_EXCLUDE_PATTERNS.map(({ pattern, label }) => {
            const active = parsed.excludePatterns.some((item) => item.toLowerCase() === pattern.toLowerCase());
            return (
              <button
                key={pattern}
                type="button"
                aria-pressed={active}
                onClick={() => toggleQuickExclude(pattern)}
                className={cx(
                  "inline-flex h-5 items-center rounded border px-1.5 font-mono text-2xs transition-colors",
                  active
                    ? "border-accent bg-accent/15 font-medium text-accent"
                    : "border-border bg-surface text-text-muted hover:text-text"
                )}
              >
                {active ? `✓ ${label}` : `+ ${label}`}
              </button>
            );
          })}
        </div>
        <TextArea
          id={excludeId}
          rows={compact ? 3 : 4}
          value={excludeText}
          onChange={(event) => handleExcludeChange(event.target.value)}
          placeholder={"*Test Result*\n*.md\narchive/**"}
          spellCheck={false}
          className="font-mono text-xs"
        />
      </Field>
    </div>
  );
}
