import { defineComponent, ref } from "vue";

import { useThreeScene } from "./useThreeScene";
import "./HolographicMap.scss";

/**
 * The holographic battle map. Hosts a three.js scene that renders the match
 * map as a GLB and scrubs ship positions over the decoded replay timeline.
 *
 * Status: skeleton — renders a holographic plane + grid. M4 (PLAN.md) loads
 * the real map mesh and ship markers.
 */
export default defineComponent({
  name: "HolographicMap",
  props: {
    replayPath: { type: String, default: "" },
  },
  setup(props) {
    const container = ref<HTMLElement | null>(null);
    const { ready } = useThreeScene(container);

    return () => (
      <div class="holo-map">
        <div ref={container} class="holo-map__canvas" />
        {!ready.value ? <div class="holo-map__hint">Initializing holographic scene…</div> : null}
        {props.replayPath ? (
          <div class="holo-map__overlay-info">
            {/* TODO(M4): render ship markers from the decoded replay timeline. */}
            Replay: {props.replayPath}
          </div>
        ) : null}
      </div>
    );
  },
});
