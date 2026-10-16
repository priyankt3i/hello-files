import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastApi {
  /** Shows a toast. Passing an existing id replaces that toast (useful for de-duplication). */
  show: (toast: Omit<Toast, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
  error: (title: string, description?: string, id?: string) => string;
  success: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  warning: (title: string, description?: string) => string;
}

const ToastContext = createContext<ToastApi | null>(null);
const ToastListContext = createContext<Toast[]>([]);

const AUTO_DISMISS_MS: Record<ToastTone, number | null> = {
  info: 4000,
  success: 4000,
  warning: 8000,
  error: null // errors stay until dismissed
};

const MAX_TOASTS = 5;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, number>());
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback<ToastApi["show"]>(
    (input) => {
      counter.current += 1;
      const id = input.id ?? `toast-${counter.current}`;
      const toast: Toast = { id, tone: input.tone, title: input.title, description: input.description };
      setToasts((current) => [...current.filter((item) => item.id !== id), toast].slice(-MAX_TOASTS));
      const existing = timers.current.get(id);
      if (existing) window.clearTimeout(existing);
      const delay = AUTO_DISMISS_MS[input.tone];
      if (delay) {
        timers.current.set(id, window.setTimeout(() => dismiss(id), delay));
      }
      return id;
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      error: (title, description, id) => show({ tone: "error", title, description, id }),
      success: (title, description) => show({ tone: "success", title, description }),
      info: (title, description) => show({ tone: "info", title, description }),
      warning: (title, description) => show({ tone: "warning", title, description })
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={api}>
      <ToastListContext.Provider value={toasts}>{children}</ToastListContext.Provider>
    </ToastContext.Provider>
  );
}

/** Stable toast functions (identity never changes). */
export function useToasts() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToasts must be used inside <ToastProvider>.");
  return context;
}

export function useToastList() {
  return useContext(ToastListContext);
}
