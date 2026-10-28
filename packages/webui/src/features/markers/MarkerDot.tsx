import { defineComponent, type PropType } from "vue";

import type { MarkerColor } from "@/api";

import "./MarkerDot.scss";

/**
 * The local player-marker dot (玩家标记) for roster surfaces that have
 * no dot family of their own: a 6px color bead beside the nickname,
 * title = the localized marker name. Same inks as every other marker
 * surface (see playerContextMenu.MARKER_DOT_COLORS).
 */
export default defineComponent({
  name: "MarkerDot",
  props: {
    color: { type: String as PropType<MarkerColor>, required: true },
    /** Tooltip text — the localized marker name. */
    label: { type: String, required: true },
  },
  setup(props) {
    return () => (
      <span
        class={["marker-dot", `marker-dot--${props.color}`].join(" ")}
        title={props.label}
      />
    );
  },
});
