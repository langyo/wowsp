import { defineComponent } from "vue";

import { useTooltip } from "@/composables/useTooltip";
import "./STooltip.scss";

/**
 * Global tooltip host. Mount once at the app root; the v-tooltip directive
 * drives its content/position through the tooltip singleton.
 */
export default defineComponent({
  name: "STooltip",
  setup() {
    const { state } = useTooltip();
    return () => {
      if (!state.value.visible) return null;
      return (
        <div
          class="stooltip"
          style={{
            left: state.value.x + "px",
            top: state.value.y + "px",
          }}
        >
          <span class="stooltip__content">{state.value.content}</span>
        </div>
      );
    };
  },
});
