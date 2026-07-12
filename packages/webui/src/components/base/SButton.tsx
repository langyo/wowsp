import { computed, defineComponent, type PropType } from "vue";

import SSpinner from "./SSpinner";
import "./SButton.scss";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/**
 * WoWSP design-system button. Co-located SCSS pattern (TSX + SButton.scss next
 * to it) lifted from shittim-chest's base components. Variants/sizes consume
 * the global theme tokens.
 *
 * The `loading` prop shows a spinner inside the button and disables it — the
 * standard "submit in progress" affordance. This replaces the old pattern of
 * swapping the button's text content to "..." (which was inconsistent and
 * changed the button's width). Use `loading` everywhere an async action is in
 * flight.
 */
export default defineComponent({
  name: "SButton",
  props: {
    variant: { type: String as PropType<ButtonVariant>, default: "primary" },
    size: { type: String as PropType<ButtonSize>, default: "md" },
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    block: { type: Boolean, default: false },
  },
  emits: {
    click: (_e: MouseEvent) => true,
  },
  setup(props, { emit, slots }) {
    const cls = computed(() => [
      "s-btn",
      `s-btn-${props.variant}`,
      `s-btn-${props.size}`,
      props.block ? "s-btn-block" : "",
      props.loading ? "s-btn-loading" : "",
    ]);
    return () => (
      <button
        class={cls.value}
        disabled={props.disabled || props.loading}
        onClick={(e) => emit("click", e)}
      >
        {props.loading ? <SSpinner size="xs" tone="current" /> : null}
        {slots.default?.()}
      </button>
    );
  },
});
