import { defineComponent, onBeforeUnmount, onMounted } from "vue";

import OverlayStatsLayer from "@/features/overlay/OverlayStatsLayer";
import { useOverlayStore } from "@/stores/overlay";
import { t } from "@/i18n";
import "./OverlayApp.scss";

/**
 * Root component for the dedicated overlay window (Mode 2).
 *
 * This is a SEPARATE window from the main shell — created on demand by the
 * Rust side as a transparent, always-on-top, click-through, decoration-less
 * window loading the same index.html with `?window=overlay`. main.ts detects
 * that query param and mounts this component instead of the router-driven App.
 *
 * The window has no title bar, no router, transparent background. It renders
 * the per-row stat chips anchored to the game's team list. Visibility is
 * controlled by the Rust Tab watcher (show/hide the window without stealing
 * focus), not by CSS — so when hidden the window truly stops rendering. The
 * hint pill shows while no battle roster is known yet.
 *
 * (Deliberately no `useOverlay` composable here — distinct from the unrelated
 * modal helper in `composables/useOverlay.ts`, wiring the store inline keeps
 * reactive refs flowing into the render function.)
 */
export default defineComponent({
  name: "OverlayApp",
  setup() {
    const store = useOverlayStore();

    onMounted(() => {
      void store.initRealm();
      void store.refreshArenaInfo();
      void store.startWatching();
    });
    onBeforeUnmount(() => void store.stopWatching());

    return () => (
      <div class="overlay-shell">
        {store.arenaInfo ? (
          <OverlayStatsLayer />
        ) : (
          <div class="overlay-shell__hint">{t("overlay.hint")}</div>
        )}
      </div>
    );
  },
});
