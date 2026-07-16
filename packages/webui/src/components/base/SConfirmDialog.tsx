import { defineComponent, type PropType } from "vue";

import SButton from "./SButton";
import type { ButtonVariant } from "./SButton";
import SModal from "./SModal";

/**
 * Confirmation dialog — wraps SModal with a standard confirm/cancel layout.
 * Ported from shittim-chest's SConfirmDialog. Use with `useConfirm()` for a
 * promise-based API, or wire directly via props/emits.
 */
export default defineComponent({
  name: "SConfirmDialog",
  props: {
    visible: { type: Boolean, required: true },
    title: { type: String, default: "" },
    message: { type: String, default: "" },
    confirmLabel: { type: String, default: undefined },
    confirmVariant: { type: String as PropType<ButtonVariant>, default: "primary" },
    cancelLabel: { type: String, default: undefined },
    loading: { type: Boolean, default: false },
  },
  emits: {
    confirm: () => true,
    cancel: () => true,
  },
  setup(props, { emit, slots }) {
    return () => (
      <SModal
        modelValue={props.visible}
        onUpdate:modelValue={(v: boolean) => {
          if (!v) emit("cancel");
        }}
        title={props.title}
        closeable={!props.loading}
        v-slots={{
          default: () =>
            slots.default ? slots.default() : <p class="s-confirm__msg">{props.message}</p>,
          footer: () => [
            <SButton
              variant="ghost"
              size="sm"
              onClick={() => emit("cancel")}
              disabled={props.loading}
            >
              {props.cancelLabel || "Cancel"}
            </SButton>,
            <SButton
              variant={props.confirmVariant}
              size="sm"
              onClick={() => emit("confirm")}
              loading={props.loading}
            >
              {props.confirmLabel || "Confirm"}
            </SButton>,
          ],
        }}
      />
    );
  },
});
