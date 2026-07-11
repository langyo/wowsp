import { defineComponent } from "vue";

import { useOverlay } from "./useOverlay";
import "./OverlayRoster.scss";

/**
 * Renders both teams' rosters as a glass overlay. In overlay mode this is the
 * transparent-window content; in review mode it can be reused as a sidebar.
 */
export default defineComponent({
  name: "OverlayRoster",
  setup() {
    const overlay = useOverlay();
    return () => (
      <div class={["overlay-roster", overlay.visible.value ? "is-visible" : ""]}>
        <div class="overlay-roster__team">
          {overlay.allies.value.map((v) => (
            <div class="overlay-roster__row ally" key={v.id}>
              <span class="overlay-roster__name">{v.name}</span>
              <span class="overlay-roster__ship">{v.shipName ?? v.shipId}</span>
            </div>
          ))}
        </div>
        <div class="overlay-roster__divider" />
        <div class="overlay-roster__team">
          {overlay.enemies.value.map((v) => (
            <div class="overlay-roster__row enemy" key={v.id}>
              <span class="overlay-roster__name">{v.name}</span>
              <span class="overlay-roster__ship">{v.shipName ?? v.shipId}</span>
            </div>
          ))}
        </div>
      </div>
    );
  },
});
