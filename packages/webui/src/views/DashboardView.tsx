import { computed, defineComponent, ref, watch } from "vue";

import StatsCard from "@/components/stats/StatsCard";
import AccountSwitcherModal from "@/components/account/AccountSwitcherModal";
import SSpinner from "@/components/base/SSpinner";
import { useAccountStore } from "@/stores/account";
import { useStatsStore } from "@/stores/stats";
import { useTrendsStore } from "@/stores/trends";
import { t } from "@/i18n";
import "./DashboardView.scss";

/**
 * "My stats" dashboard. If no account is bound → centered bind prompt that
 * opens the AccountSwitcherModal. If bound → fetches the player's deep stats
 * via the stats store (which also appends a versioned snapshot for trend
 * tracking) and renders the StatsCard. The trend mini-chart appears once 2+
 * snapshots exist.
 */
export default defineComponent({
  name: "DashboardView",
  setup() {
    const accounts = useAccountStore();
    const stats = useStatsStore();
    const trends = useTrendsStore();

    const showModal = ref(false);

    const activeAccount = computed(() => accounts.activeAccount);
    const currentStats = computed(() => {
      if (!activeAccount.value) return null;
      return stats.cache.get(`${activeAccount.value.realm}_${activeAccount.value.accountId}`) ?? null;
    });

    // When the active account changes, fetch stats + trend. Loads the disk
    // cache first (instant render), then refreshes from the network.
    async function refresh() {
      const acc = activeAccount.value;
      if (!acc) return;
      // Warm the cache so the card renders immediately on cold start.
      try {
        await stats.loadCached(acc.realm, acc.accountId);
      } catch {
        // cache miss — fine
      }
      try {
        await stats.lookup(acc.nickname, acc.realm);
        await trends.loadPlayer(acc.accountId, acc.realm);
      } catch {
        // surfaced via stats.error
      }
    }

    watch(activeAccount, (acc) => {
      if (acc && !currentStats.value) void refresh();
    }, { immediate: true });

    return () => (
      <div class="dashboard-view">
        {!activeAccount.value ? (
          <div class="dashboard-view__empty">
            <div class="dashboard-view__empty-icon">
              <img src="/logo.webp" alt="WoWSP" />
            </div>
            <h2 class="dashboard-view__title">{t("dashboard.noAccount")}</h2>
            <p class="dashboard-view__hint">{t("dashboard.noAccountHint")}</p>
            <button class="dashboard-view__bind" onClick={() => (showModal.value = true)}>
              {t("account.search")}
            </button>
          </div>
        ) : stats.loading ? (
          <div class="dashboard-view__loading">
            <SSpinner center size="lg" text={t("dashboard.loading")} />
          </div>
        ) : currentStats.value ? (
          <div class="dashboard-view__content">
            <StatsCard stats={currentStats.value} />
            {trends.playerTrend && trends.playerTrend.buckets.length >= 2 ? (
              <div class="dashboard-view__trend">
                <h3>{t("trend.winrateOverTime")}</h3>
                <div class="dashboard-view__trend-line">
                  {trends.playerTrend.buckets.map((b) => (
                    <div
                      class="dashboard-view__trend-bar"
                      style={{
                        height: `${Math.max(10, Math.min(100, b.winrateAvg))}%`,
                        background: `rgb(var(--color-primary))`,
                      }}
                      title={`${b.version}: ${b.winrateAvg.toFixed(1)}% (${b.snapshotCount} snapshots)`}
                    />
                  ))}
                </div>
                <div class="dashboard-view__trend-labels">
                  {trends.playerTrend.buckets.map((b) => (
                    <span>{b.version}</span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : stats.error ? (
          <div class="dashboard-view__error">{stats.error}</div>
        ) : null}

        <AccountSwitcherModal
          modelValue={showModal.value}
          onUpdate:modelValue={(v: boolean) => (showModal.value = v)}
          onBound={() => void refresh()}
        />
      </div>
    );
  },
});
