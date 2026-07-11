import { defineComponent } from "vue";
import { t } from "@/i18n";

/**
 * "My stats" dashboard. If no account is bound → centered bind prompt.
 * If bound → the player's deep stats (winrate, battles, avg dmg, ships, etc).
 * Account binding + stats fetching are wired in subsequent steps.
 */
export default defineComponent({
  name: "DashboardView",
  setup() {
    return () => (
      <div class="dashboard-view">
        <div class="dashboard-view__empty">
          <h2 class="dashboard-view__title">{t("dashboard.noAccount")}</h2>
          <p class="dashboard-view__hint">{t("dashboard.noAccountHint")}</p>
        </div>
      </div>
    );
  },
});
