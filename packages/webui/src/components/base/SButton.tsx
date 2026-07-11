import { computed, defineComponent, type PropType } from "vue";

import "./SButton.scss";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/**
 * WoWSP design-system button. Co-located SCSS pattern (TSX + SButton.scss next
 * to it) lifted from shittim-chest's base components. Variants/sizes consume
 * the global theme tokens.
 */
export default defineComponent({
  name: "SButton",
  props: {
    variant: { type: String as PropType<ButtonVariant>, default: "primary" },
    size: { type: String as PropType<ButtonSize>, default: "md" },
    disabled: { type: Boolean, default: false },
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
    ]);
    return () => (
      <button class={cls.value} disabled={props.disabled} onClick={(e) => emit("click", e)}>
        {slots.default?.()}
      </button>
    );
  },
});
