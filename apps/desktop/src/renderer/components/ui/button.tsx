import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import { cx } from "../../lib/format";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent/90 border border-transparent shadow-card",
  secondary: "bg-surface text-text border border-border hover:bg-surface-2 shadow-card",
  ghost: "bg-transparent text-text border border-transparent hover:bg-surface-2",
  danger: "bg-danger text-white border border-transparent hover:bg-danger/90 shadow-card dark:text-bg",
  "danger-ghost": "bg-transparent text-danger border border-transparent hover:bg-danger/10"
};

const SIZE: Record<Size, string> = {
  sm: "h-7 gap-1.5 px-2.5 text-xs",
  md: "h-8 gap-2 px-3 text-sm"
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  loading?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, loading, disabled, className, children, type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANT[variant],
        SIZE[size],
        className
      )}
      {...rest}
    >
      {loading ? (
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
      ) : Icon ? (
        <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden />
      ) : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  size?: Size;
  tone?: "default" | "danger";
}

/** Square icon-only button. `label` is required and used for aria-label and tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = "md", tone = "default", className, type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "h-6 w-6" : "h-8 w-8",
        tone === "danger" ? "text-text-muted hover:bg-danger/10 hover:text-danger" : "text-text-muted hover:bg-surface-2 hover:text-text",
        className
      )}
      {...rest}
    >
      <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden />
    </button>
  );
});
