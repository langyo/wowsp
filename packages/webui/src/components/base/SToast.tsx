import { defineComponent } from "vue";
import { CheckCircle, XCircle, AlertTriangle, Info, X } from "lucide-vue-next";

import { useToast, type ToastType } from "@/composables/useToast";
import "./SToast.scss";

const ICONS: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const CLASSES: Record<ToastType, string> = {
  success: "s-toast--success",
  error: "s-toast--error",
  warning: "s-toast--warning",
  info: "s-toast--info",
};

/**
 * Toast notification stack. Mounted once at the app root (in AppShell).
 * Renders all active toasts in the top-right corner, auto-dismisses
 * success/info after 3s, errors/warnings are sticky until dismissed.
 */
export default defineComponent({
  name: "SToast",
  setup() {
    const { toasts, dismiss } = useToast();

    return () => (
      <Teleport to="body">
        <TransitionGroup name="s-toast" tag="div" class="s-toast-container">
          {toasts.map((toast) => {
            const Icon = ICONS[toast.type];
            return (
              <div class={["s-toast", CLASSES[toast.type]]} key={toast.id}>
                <Icon size={16} class="s-toast__icon" />
                <span class="s-toast__msg">{toast.message}</span>
                <button
                  class="s-toast__close"
                  onClick={() => dismiss(toast.id)}
                  aria-label="dismiss"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </TransitionGroup>
      </Teleport>
    );
  },
});
