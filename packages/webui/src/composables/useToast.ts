import { reactive } from "vue";

export type ToastType = "success" | "error" | "warning" | "info";

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
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

function show(message: string, type: ToastType = "info", duration = DEFAULT_DURATION) {
  const id = ++nextId;
  state.toasts.push({ id, type, message });
  // Auto-dismiss for success/info (errors/warnings are sticky).
  if (type === "success" || type === "info") {
    timers.set(id, setTimeout(() => dismiss(id), duration));
  }
  return id;
}

/** Toast composable. Shared module-level state so all callers see the same
 *  toasts. Mount <SToast /> once at the app root to render them. */
export function useToast() {
  return {
    toasts: state.toasts,
    show,
    success: (msg: string) => show(msg, "success"),
    error: (msg: string) => show(msg, "error"),
    warning: (msg: string) => show(msg, "warning"),
    info: (msg: string) => show(msg, "info"),
    dismiss,
  };
}
