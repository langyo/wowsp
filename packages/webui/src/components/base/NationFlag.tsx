import { defineComponent, computed, type PropType } from "vue";
import { useImage } from "@wowsp/holo";

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
 * The URL always points at the public path; the shared useImage() hook tracks
 * the load lifecycle — if the file is absent the `<img>` fires `onerror` and
 * we swap to the letter badge in-place (no flash of both).
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
    const initial = computed(() => nationInitial(props.nation, props.label));
    const title = computed(() => props.label || props.nation);
    // Load lifecycle from the shared hook: empty/error → letter badge, and a
    // nation/variant swap resets the tracking automatically via the source.
    const img = useImage(() => resolveNationFlag(props.nation, props.variant));
    return () => {
      const sz = props.size;
      const showImg = img.status.value === "loading" || img.status.value === "loaded";
      return (
        <span class={["nation-flag", `nation-flag--${sz}`, `nation-flag--${props.variant}`]} title={title.value} key={img.key.value}>
          {showImg ? (
            <img
              class={["nation-flag__img", "image-asset__img", img.status.value === "loaded" ? "is-loaded" : ""].join(" ")}
              src={img.src.value}
              alt={props.label || props.nation}
              draggable={false}
              onLoad={img.onLoad}
              onError={img.onError}
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
