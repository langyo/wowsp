/**
 * The force-refresh pill riding the stats card's identity head, left of
 * ShareShotButton — re-runs the dashboard's loads with `force: true` so a
 * TTL-served snapshot (see DashboardView's revisit window) can be updated
 * on demand. Reuses ShareShotButton's pill style so both read as one
 * evenly-sized action strip.
 */
import { defineComponent } from "vue";
import { RotateCw } from "@lucide/vue";
import { HkSpinner } from "@celestia-island/hikari";

import { t } from "@/i18n";
import "@/features/share/ShareShotButton.scss";

export default defineComponent({
  name: "RefreshStatsButton",
  props: {
    busy: { type: Boolean, default: false },
  },
  emits: ["refresh"],
  setup(props, { emit }) {
    return () => (
      <button
        class="share-shot-btn"
        type="button"
        disabled={props.busy}
        onClick={() => emit("refresh")}
      >
        {props.busy ? <HkSpinner size="xs" tone="current" /> : <RotateCw size={13} />}
        {t("dashboard.refresh")}
      </button>
    );
  },
});
