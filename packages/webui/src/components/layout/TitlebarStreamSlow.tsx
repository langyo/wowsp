import { computed, defineComponent } from "vue";
import { HkPersistentToast } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useShipStatsStore } from "@/stores/shipStats";
import "./TitlebarStreamSlow.scss";

/**
 * TitlebarStreamSlow — the yellow "degraded loading" chip in the title
 * bar's actions slot, beside the fault and loading chips (never replaces
 * either; all three can show at once).
 *
 * Visible while any per-ship fetch source is STREAMING PAST the slow
 * threshold (15s elapsed, bytes still arriving — the degraded-transport
 * face the vortex crawl of 2026-10 made routine): the fetch has not
 * failed, it is still receiving, and the table is already filling with
 * the rows parsed so far. The chip's hover card says exactly that. It
 * stands down by itself when every source settles (done/aborted) — no
 * dismissal, because the condition is live, not an episode to silence.
 *
 * Renders null when no stream is slow — the actions slot stays untouched.
 */
export default defineComponent({
  name: "TitlebarStreamSlow",
  setup() {
    const shipStats = useShipStatsStore();
    const visible = computed(() => shipStats.anySlowStream);

    return () => {
      if (!visible.value) return null;
      return (
        <HkPersistentToast
          class="titlebar-stream-slow"
          tone="warning"
          label={t("upstream.slow.short")}
          detailLabel={t("upstream.slow.tooltip")}
        >
          {{
            detail: () => (
              <div class="titlebar-stream-slow__card">
                <p class="titlebar-stream-slow__text">{t("upstream.slow.tooltip")}</p>
              </div>
            ),
          }}
        </HkPersistentToast>
      );
    };
  },
});
