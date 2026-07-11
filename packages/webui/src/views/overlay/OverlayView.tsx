import { defineComponent, onMounted } from "vue";

import OverlayRoster from "@/features/overlay/OverlayRoster";
import { useOverlay } from "@/features/overlay/useOverlay";
import { t } from "@/i18n";
import "./OverlayView.scss";

/**
 * In-game overlay view (Mode 2). Transparent-window content: while Tab is held
 * the roster appears and WoWSP captures + re-anchors against the live team list.
 */
export default defineComponent({
  name: "OverlayView",
  setup() {
    const overlay = useOverlay();
    onMounted(() => {
      void overlay.refresh();
      void overlay.startWatching();
    });
    return () => (
      <main class="overlay-view">
        <div class="overlay-view__stage">
          <div class="overlay-view__hint">{t("overlay.hint")}</div>
          <OverlayRoster />
        </div>
      </main>
    );
  },
});
