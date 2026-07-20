import { defineComponent } from "vue";
import { CheckCircle, XCircle, AlertTriangle, Info, Loader, X } from "lucide-vue-next";

import { useToast, type ToastType } from "@/composables/useToast";
import "./SToast.scss";

const ICONS: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
  loading: Loader,
};

const CLASSES: Record<ToastType, string> = {
  success: "s-toast--success",
  error: "s-toast--error",
  warning: "s-toast--warning",
  info: "s-toast--info",
  loading: "s-toast--loading",
};

function copyToastMsg(msg: string) {
  navigator.clipboard.writeText(msg).catch(() => {});
}

export default defineComponent({
  name: "SToast",
  setup() {
    const { toasts, dismiss } = useToast();

    return () => (
      <Teleport to="body">
        <TransitionGroup name="s-toast" tag="div" class="s-toast-container">
          {toasts.map((toast) => {
            const Icon = ICONS[toast.type];
            const copyable = toast.type === "error" || toast.type === "warning";
            return (
              <div class={["s-toast", CLASSES[toast.type]]} key={toast.id}>
                <Icon
                  size={16}
                  class={["s-toast__icon", toast.type === "loading" ? "s-toast__icon--spin" : ""]}
                />
                <span
                  class={["s-toast__msg", copyable ? "s-toast__msg--copyable" : ""]}
                  title={copyable ? "Click to copy" : undefined}
                  onClick={copyable ? () => copyToastMsg(toast.message) : undefined}
                >{toast.message}</span>
                {!toast.persistent ? (
                  <button
                    class="s-toast__close"
                    onClick={() => dismiss(toast.id)}
                    aria-label="dismiss"
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </TransitionGroup>
      </Teleport>
    );
  },
});
