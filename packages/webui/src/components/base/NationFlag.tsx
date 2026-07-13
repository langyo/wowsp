import { defineComponent, computed, type PropType } from "vue";

import { resolveNationFlag, nationInitial } from "@/utils/nationFlags";

/**
 * Nation emblem badge — renders the in-game faction crest when the asset is
 * installed under `src/res/images/nations/<nation>.png`, otherwise a circular
 * initial-letter fallback so the UI is never broken by a missing PNG.
 *
 * Used both in the ship detail header (with label text) and on ship cards
 * (icon-only, compact). The `size` prop controls the rendered diameter.
 */
export default defineComponent({
  name: "NationFlag",
  props: {
    nation: { type: String, required: true },
    /** i18n label for fallback initial + title tooltip. */
    label: { type: String, default: "" },
    size: {
      type: String as PropType<"sm" | "md" | "lg">,
      default: "md",
    },
    /** When true, render the nation label text next to the flag. */
    showLabel: { type: Boolean, default: false },
  },
  setup(props) {
    const url = computed(() => resolveNationFlag(props.nation));
    const initial = computed(() => nationInitial(props.nation, props.label));
    const title = computed(() => props.label || props.nation);
    return () => {
      const sz = props.size;
      return (
        <span class={["nation-flag", `nation-flag--${sz}`]} title={title.value}>
          {url.value ? (
            <img
              class="nation-flag__img"
              src={url.value}
              alt={props.label || props.nation}
              draggable={false}
            />
          ) : (
            <span class="nation-flag__fallback">{initial.value}</span>
          )}
          {props.showLabel ? (
            <span class="nation-flag__label">{props.label}</span>
          ) : null}
        </span>
      );
    };
  },
});
