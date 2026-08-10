import { computed, defineComponent, type PropType } from "vue";
import "./UiButton.scss";

export type UiButtonVariant = "primary" | "secondary" | "text";
export type UiButtonSize = "sm" | "md" | "lg";

/**
 * UiButton — canonical WoWSP site button ("Abyssal Glass").
 *
 * - primary:   gradient pill, the one CTA per section
 * - secondary: frosted glass pill
 * - text:      borderless link-style action (Apple's "Learn more >")
 *
 * Renders `<a>` when `href` is set, `<button>` otherwise — callers pass
 * RouterLink-style `to` via href on the site (full reload is fine for the
 * marketing site anchors) or use @click for actions.
 */
export default defineComponent({
  name: "UiButton",
  props: {
    variant: { type: String as PropType<UiButtonVariant>, default: "primary" },
    size: { type: String as PropType<UiButtonSize>, default: "md" },
    href: { type: String, default: undefined },
    external: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
  },
  emits: { click: (_e: MouseEvent) => true },
  setup(props, { emit, slots }) {
    const cls = computed(() => [
      "ui-btn",
      `ui-btn--${props.variant}`,
      `ui-btn--${props.size}`,
      props.disabled ? "is-disabled" : "",
    ]);

    return () =>
      props.href ? (
        <a
          class={cls.value}
          href={props.disabled ? undefined : props.href}
          target={props.external ? "_blank" : undefined}
          rel={props.external ? "noopener" : undefined}
          aria-disabled={props.disabled ? "true" : undefined}
          onClick={(e) => {
            if (props.disabled) { e.preventDefault(); return; }
            emit("click", e);
          }}
        >
          {slots.default?.()}
        </a>
      ) : (
        <button
          class={cls.value}
          type="button"
          disabled={props.disabled}
          onClick={(e) => emit("click", e)}
        >
          {slots.default?.()}
        </button>
      );
  },
});
