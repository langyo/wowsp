import { reactive } from "vue";

export type ToastType = "success" | "error" | "warning" | "info" | "loading";

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  /** When true, the close button is hidden and the toast is auto-dismissed
   *  only by the caller (via dismiss). Loading toasts use this. */
  persistent?: boolean;
}

const state = reactive<{ toasts: ToastItem[] }>({ toasts: [] });
let nextId = 0;

const DEFAULT_DURATION = 3000;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function dismiss(id: number) {
  const idx = state.toasts.findIndex((t) => t.id === id);
  if (idx >= 0) state.toasts.splice(idx, 1);
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

function show(message: string, type: ToastType = "info", duration = DEFAULT_DURATION): number {
  const id = ++nextId;
  const persistent = type === "loading" || type === "error" || type === "warning";
  state.toasts.push({ id, type, message, persistent });
  // Auto-dismiss for success/info only (errors/warnings/loading are sticky).
  if (!persistent) {
    timers.set(id, setTimeout(() => dismiss(id), duration));
  }
  return id;
}

/** Show a persistent loading toast. Returns the toast id for later dismissal. */
function showLoading(message: string): number {
  const id = ++nextId;
  state.toasts.push({ id, type: "loading", message, persistent: true });
  return id;
}

export function useToast() {
  return {
    toasts: state.toasts,
    show,
    success: (msg: string) => show(msg, "success"),
    error: (msg: string) => show(msg, "error"),
    warning: (msg: string) => show(msg, "warning"),
    info: (msg: string) => show(msg, "info"),
    loading: (msg: string) => showLoading(msg),
    dismiss,
  };
}
