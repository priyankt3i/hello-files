import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cx } from "../../lib/format";

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  className
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={cx("min-w-0", className)}>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-text">
        {label}
      </label>
      {children}
      {error ? (
        <div role="alert" className="mt-1 text-xs text-danger">
          {error}
        </div>
      ) : hint ? (
        <div className="mt-1 text-xs text-text-muted">{hint}</div>
      ) : null}
    </div>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("control h-8", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx("control h-8 pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("control resize-y leading-relaxed", className)} {...rest} />;
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {label}
        </label>
        {description ? <div className="mt-0.5 text-xs leading-relaxed text-text-muted">{description}</div> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "border-accent bg-accent" : "border-border bg-surface-2"
        )}
      >
        <span
          className={cx(
            "inline-block h-3.5 w-3.5 rounded-full shadow-card transition-transform",
            checked ? "translate-x-[18px] bg-accent-fg" : "translate-x-[2px] bg-text-muted"
          )}
        />
      </button>
    </div>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "md"
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; count?: number }>;
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded border border-border bg-surface-2 p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-sm font-medium transition-colors",
              size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-3 text-sm",
              active ? "bg-surface text-text shadow-card" : "text-text-muted hover:text-text"
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className={cx("tabular-nums text-2xs", active ? "text-text-muted" : "text-text-muted/80")}>
                {option.count.toLocaleString()}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Large radio option with a title and explanation (used for search-type choices). */
export function RadioCard({
  name,
  checked,
  onChange,
  title,
  description,
  disabled,
  badge
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  title: ReactNode;
  description: ReactNode;
  disabled?: boolean;
  badge?: ReactNode;
}) {
  return (
    <label
      className={cx(
        "flex cursor-pointer gap-3 rounded-md border p-3 transition-colors",
        checked ? "border-accent bg-accent/5" : "border-border hover:bg-surface-2",
        disabled && "cursor-not-allowed opacity-50"
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} disabled={disabled} className="mt-0.5 accent-[rgb(var(--accent))]" />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
          {title}
          {badge}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-text-muted">{description}</span>
      </span>
    </label>
  );
}

export function Section({ title, description, children, actions }: { title: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-surface p-5 shadow-card">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text">{title}</h3>
          {description ? <p className="mt-0.5 text-xs leading-relaxed text-text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
