/**
 * The force-refresh action riding the stats card's identity head, left of
 * ShareShotButton — re-runs the dashboard's loads with `force: true` so a
 * TTL-served snapshot (see DashboardView's revisit window) can be updated
 * on demand. Same HkButton as ShareShotButton (ghost xs — issue #1736 P2)
 * so both read as one action strip; loading supplies the ring + disabled.
 */
import { defineComponent } from "vue";
import { RotateCw } from "@lucide/vue";
import { HkButton } from "@celestia-island/hikari";

import { t } from "@/i18n";

export default defineComponent({
  name: "RefreshStatsButton",
  props: {
    busy: { type: Boolean, default: false },
  },
  emits: ["refresh"],
  setup(props, { emit }) {
    return () => (
      <HkButton variant="ghost" size="xs" loading={props.busy} onClick={() => emit("refresh")}>
        <RotateCw size={13} />
        {t("dashboard.refresh")}
      </HkButton>
    );
  },
});
