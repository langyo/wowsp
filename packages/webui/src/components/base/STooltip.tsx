import { defineComponent, nextTick, ref, watch } from "vue";

import { useTooltip } from "@/composables/useTooltip";
import "./STooltip.scss";

const MARGIN = 8;
const GAP = 8;

/**
 * Global tooltip host. Mount once at the app root; the v-tooltip directive
 * drives its content through the tooltip singleton. Positioning is anchored to
 * the hovered element (fixed, not mouse-following), flipped below when the top
 * edge is too close, and clamped horizontally to stay inside the viewport.
 */
export default defineComponent({
  name: "STooltip",
  setup() {
    const { state } = useTooltip();
    const el = ref<HTMLElement | null>(null);
    const pos = ref({ x: 0, y: 0, bottom: false });

    function compute() {
      const anchor = state.value.anchor;
      const node = el.value;
      if (!anchor || !node) return;
      const rect = node.getBoundingClientRect();
      const vw = window.innerWidth;

      // Center on the anchor, clamped horizontally to the viewport.
      const halfW = rect.width / 2;
      const x = Math.max(
        halfW + MARGIN,
        Math.min(vw - halfW - MARGIN, anchor.left + anchor.width / 2),
      );

      // Flip below when the top edge has no room for the tooltip.
      const bottom = anchor.top - rect.height - GAP < MARGIN;
      const y = bottom ? anchor.bottom + GAP : anchor.top - GAP;

      pos.value = { x, y, bottom };
    }

    watch(
      () => state.value.content,
      () => {
        if (state.value.visible) void nextTick(compute);
      },
    );

    return () => {
      if (!state.value.visible) return null;
      return (
        <div
          ref={el}
          class={["stooltip", pos.value.bottom ? "stooltip--bottom" : ""]}
          style={{ left: pos.value.x + "px", top: pos.value.y + "px" }}
        >
          <span class="stooltip__content">{state.value.content}</span>
        </div>
      );
    };
  },
});
