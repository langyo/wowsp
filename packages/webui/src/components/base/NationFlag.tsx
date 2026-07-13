import { defineComponent, computed, ref, type PropType } from "vue";

import { resolveNationFlag, nationInitial } from "@/utils/nationFlags";

/**
 * Nation emblem badge — renders the in-game faction crest when the asset is
 * installed under `src/res/images/nations/<nation>.webp`, otherwise a circular
 * initial-letter fallback so the UI is never broken by a missing PNG.
 *
 * The URL always points at the public path; if the file is absent the `<img>`
 * fires `onerror` and we swap to the letter badge in-place (no flash of both).
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
    // Whether the flag image failed to load (404 / missing file) → show letter.
    const failed = ref(false);
    return () => {
      const sz = props.size;
      const showImg = url.value && !failed.value;
      return (
        <span class={["nation-flag", `nation-flag--${sz}`]} title={title.value}>
          {showImg ? (
            <img
              class="nation-flag__img"
              src={url.value!}
              alt={props.label || props.nation}
              draggable={false}
              onError={() => (failed.value = true)}
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
