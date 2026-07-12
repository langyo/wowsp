import { computed, defineComponent, type PropType } from "vue";

import "./SSpinner.scss";

export type SpinnerSize = "xs" | "sm" | "md" | "lg" | "xl";

/**
 * WoWSP design-system spinner — pure-CSS infinite rotation, no SVG, no
 * library. Ported from shittim-chest's SSpinner. Two tones:
 *  - `primary` (default): muted track + primary-coloured arc. For use on
 *    neutral / surface backgrounds (under a disabled button, in a panel).
 *  - `current`: follows `currentcolor`, for use INSIDE a coloured button
 *    where the spinner should match the button label.
 *
 * The `.s-spinner` animation is preserved under prefers-reduced-motion
 * (registered in theme.scss's reduced-motion keep-list) so a spinner always
 * reads as "in progress" even when other animations are muted.
 */
export default defineComponent({
  name: "SSpinner",
  props: {
    size: {
      type: [String, Number] as PropType<SpinnerSize | number>,
      default: "md",
    },
    text: { type: String, default: undefined },
    center: { type: Boolean, default: false },
    tone: { type: String as PropType<"primary" | "current">, default: "primary" },
  },
  setup(props) {
    const sizeClass = computed(() =>
      typeof props.size === "string" ? `s-spinner-${props.size}` : "",
    );
    const sizeStyle = computed(() =>
      typeof props.size === "number"
        ? { width: `${props.size}px`, height: `${props.size}px` }
        : null,
    );

    return () => (
      <div class={["s-spinner-wrapper", props.center && "s-spinner-centered"]}>
        <div
          class={[
            "s-spinner",
            sizeClass.value,
            props.tone === "current" && "s-spinner-current",
          ]}
          style={sizeStyle.value ?? undefined}
        />
        {props.text ? <span class="s-spinner-text">{props.text}</span> : null}
      </div>
    );
  },
});
