import { computed, defineComponent, type PropType } from "vue";

import "./STag.scss";

export type TagVariant =
  | "neutral"
  | "primary"
  | "gold"
  | "info"
  | "success"
  | "danger"
  | "legendary";
export type TagSize = "sm" | "md";

/**
 * WoWSP design-system tag / badge / pill. Single source of truth for every
 * small label-shaped element in the app (ship tier/type/nation, premium/
 * special, realm, hidden, etc.). All variants share an identical line-box
 * height per size so mixed tags in one row line up perfectly.
 *
 * Co-located SCSS pattern (TSX + STag.scss) matches SButton / SSelect.
 */
export default defineComponent({
  name: "STag",
  props: {
    variant: { type: String as PropType<TagVariant>, default: "neutral" },
    size: { type: String as PropType<TagSize>, default: "md" },
    /** Render as a solid-filled pill (strong background) vs the default
     *  soft tinted style. Used for emphasis (e.g. Premium ships). */
    solid: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    const cls = computed(() => [
      "s-tag",
      `s-tag-${props.variant}`,
      `s-tag-${props.size}`,
      props.solid ? "s-tag-solid" : "",
    ]);
    return () => <span class={cls.value}>{slots.default?.()}</span>;
  },
});
