import { defineComponent, onMounted, onBeforeUnmount } from "vue";

import OverlayRoster from "@/features/overlay/OverlayRoster";
import { useOverlay } from "@/features/overlay/useOverlay";
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
 * The overlay window has no title bar, no router, transparent background. It
 * renders the live roster (pushed by the Rust arena-info watcher) and shows a
 * hint to hold Tab. Visibility is controlled by the Rust side (show/hide the
 * window), not by CSS — so when hidden the window truly stops rendering.
 */
export default defineComponent({
  name: "OverlayApp",
  setup() {
    const overlay = useOverlay();
    onMounted(() => {
      void overlay.refresh();
      void overlay.startWatching();
    });
    onBeforeUnmount(() => void overlay.stopWatching());

    return () => (
      <div class="overlay-shell">
        <div class="overlay-shell__hint">{t("overlay.hint")}</div>
        <OverlayRoster />
      </div>
    );
  },
});
