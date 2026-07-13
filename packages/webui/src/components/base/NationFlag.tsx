import { defineComponent, computed, ref, type PropType } from "vue";

import { resolveNationFlag, nationInitial, type NationFlagVariant } from "@/utils/nationFlags";
import "./NationFlag.scss";

/**
 * Nation emblem badge — renders the in-game faction crest/flag when the asset
 * is installed, otherwise a circular initial-letter fallback so the UI is
 * never broken by a missing PNG.
 *
 * `variant` selects which emblem set to use:
 *   - "crest" (default): large vertical faction crest, for tech-tree switcher
 *     and ship-detail header.
 *   - "flag": small rectangular list-view flag, for compact ship cards.
 *
 * The URL always points at the public path; if the file is absent the `<img>`
 * fires `onerror` and we swap to the letter badge in-place (no flash of both).
 */
export default defineComponent({
  name: "NationFlag",
  props: {
    nation: { type: String, required: true },
    /** i18n label for fallback initial + title tooltip. */
    label: { type: String, default: "" },
    variant: {
      type: String as PropType<NationFlagVariant>,
      default: "crest",
    },
    size: {
      type: String as PropType<"sm" | "md" | "lg">,
      default: "md",
    },
    /** When true, render the nation label text next to the flag. */
    showLabel: { type: Boolean, default: false },
  },
  setup(props) {
    const url = computed(() => resolveNationFlag(props.nation, props.variant));
    const initial = computed(() => nationInitial(props.nation, props.label));
    const title = computed(() => props.label || props.nation);
    // Whether the flag image failed to load (404 / missing file) → show letter.
    const failed = ref(false);
    // Reset the failure flag if the target image changes (nation/variant swap).
    const srcKey = computed(() => `${props.nation}:${props.variant}`);
    return () => {
      const sz = props.size;
      const showImg = url.value && !failed.value;
      return (
        <span class={["nation-flag", `nation-flag--${sz}`, `nation-flag--${props.variant}`]} title={title.value} key={srcKey.value}>
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
