import { computed, defineComponent, ref, Transition, watch } from "vue";

import StatsCard from "@/components/stats/StatsCard";
import AccountSwitcherModal from "@/components/account/AccountSwitcherModal";
import { HTag, HTabs, HButton } from "@celestia-island/hikari";

import ShipFilterBar from "@/components/ships/ShipFilterBar";
import SScrollTop from "@/components/base/SScrollTop";
import { useAccountStore } from "@/stores/account";
import { useStatsStore } from "@/stores/stats";
import { useShipStatsStore } from "@/stores/shipStats";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useTrendsStore } from "@/stores/trends";
import { useRankedStore } from "@/stores/ranked";
import { useToast } from "@celestia-island/hikari";
import { winrateColor } from "@/utils/winrate";
import {
  filterByDateRange,
  aggregateByType,
  SHIP_TYPE_SHORT,
  type DateRange,
} from "@/utils/shipAggregation";
import { shipNameFromModelDb, shipNameFromOfflineDb } from "@/features/holographic/modelLoader";
import { t } from "@/i18n";
import "./DashboardView.scss";

/**
 * "My stats" dashboard — a rich personal stats page.
 *
 * Layout (top to bottom):
 *   1. Identity header: avatar + clan tag + nickname + realm (centered).
 *   2. KPI summary: the StatsCard (PR / winrate / battles / avgDamage / etc.).
 *   3. Date-range segmented control (1D / 7D / 30D / All) — filters the
 *      per-ship list below by lastBattleTime.
 *   4. Per-ship-type breakdown: battles / winrate / avgDamage by BB/CA/DD/CV/SS.
 *   5. Per-ship table: every ship played (in the selected range), sortable by
 *      battles / winrate / avgDamage, with color-coded winrate.
 *   6. Floating scroll-to-top button (appears on scroll).
 *
 * If no account is bound → centered bind prompt. Stats are fetched via the
 * stats store (account-level) + shipStats store (per-ship). Ship types are
 * resolved by joining shipId → encyclopedia.
 */
export default defineComponent({
  name: "DashboardView",
  setup() {
    const accounts = useAccountStore();
    const stats = useStatsStore();
    const shipStats = useShipStatsStore();
    const encyclopedia = useEncyclopediaStore();
    const trends = useTrendsStore();
    const ranked = useRankedStore();
    const toast = useToast();

    const showModal = ref(false);
    const dateRange = ref<DateRange>("all");

    const activeAccount = computed(() => accounts.activeAccount);
    const currentStats = computed(() => {
      if (!activeAccount.value) return null;
      return stats.cache.get(`${activeAccount.value.realm}_${activeAccount.value.accountId}`) ?? null;
    });

    // Per-ship stats for the active account.
    const playerShips = computed(() => {
      const acc = activeAccount.value;
      if (!acc) return [];
      return shipStats.cache.get(`${acc.realm}_${acc.accountId}`) ?? [];
    });

    // Ships filtered by the selected date range.
    const dateFiltered = computed(() => filterByDateRange(playerShips.value, dateRange.value));

    /** Filtered + multi-key-sorted ships and search-hit names, from
     *  ShipFilterBar (the chip drag order defines the sort priority). */
    const filterState = ref<{
      ships: typeof dateFiltered.value;
      hits: Map<number, string>;
    }>({ ships: [], hits: new Map() });
    const filteredShips = computed(() => filterState.value.ships);
    function displayShipName(s: { shipId: number; name: string }): string {
      return filterState.value.hits.get(s.shipId) ?? shipName(s.shipId, s.name);
    }

    // Per-ship-type aggregation (computed from filtered ships + encyclopedia).
    const typeSummary = computed(() =>
      aggregateByType(filteredShips.value, encyclopedia.byId),
    );

    async function refresh() {
      const acc = activeAccount.value;
      if (!acc) return;
      const toastId = toast.loading(t("dashboard.loading"));
      // Phase 1: warm the account-level cache (instant render on cold start).
      try {
        await stats.loadCached(acc.realm, acc.accountId);
      } catch {
        // cache miss — fine
      }
      // Phase 2: fetch fresh account stats. The own account refreshes
      // aggressively — every dashboard open re-pulls from the API.
      try {
        await stats.lookup(acc.nickname, acc.realm, { force: true });
      } catch {
        // surfaced via stats.error
      }
      // Phase 3: per-ship stats + encyclopedia + trends — parallel.
      await Promise.allSettled([
        shipStats.load(acc.accountId, acc.realm),
        encyclopedia.load(acc.realm),
        trends.loadPlayer(acc.accountId, acc.realm),
        ranked.load(acc.accountId, acc.realm, 5),
      ]);
      toast.remove(toastId);
    }

    // Refresh on mount + whenever the active account changes. We always
    // refresh (not just on cache miss) so per-ship stats + trends load even
    // when account-level stats are already cached from a previous session.
    watch(activeAccount, (acc) => {
      if (acc) void refresh();
    }, { immediate: true });

    function shipTypeShort(shipId: number): string {
      const info = encyclopedia.byId.get(shipId);
      return SHIP_TYPE_SHORT[info?.type ?? "Unknown"] ?? "?";
    }
    function shipName(shipId: number, fallbackName: string): string {
      return (
        encyclopedia.byId.get(shipId)?.name ??
        shipNameFromOfflineDb(shipId, "zh-CN") ??
        (fallbackName || shipNameFromModelDb(shipId) || `#${shipId}`)
      );
    }
    function formatDate(epochSec: number): string {
      if (!epochSec) return "—";
      return new Date(epochSec * 1000).toLocaleDateString();
    }

    const rangeOptions = [
      { value: "1d", label: t("dashboard.range1d") },
      { value: "7d", label: t("dashboard.range7d") },
      { value: "30d", label: t("dashboard.range30d") },
      { value: "all", label: t("dashboard.rangeAll") },
    ];

    return () => (
      <div class="dashboard-view">
        <Transition name="s-fade-slide" mode="out-in">
          {!activeAccount.value ? (
            <div class="dashboard-view__empty" key="empty">
              <div class="dashboard-view__empty-icon">
                <img src="/logo.webp" alt="WoWSP" />
              </div>
              <h2 class="dashboard-view__title">{t("dashboard.noAccount")}</h2>
              <p class="dashboard-view__hint">{t("dashboard.noAccountHint")}</p>
              <HButton onClick={() => (showModal.value = true)}>
                {t("account.search")}
              </HButton>
            </div>
          ) : currentStats.value ? (
            <div class="dashboard-view__content" key="content">
              {/* ── KPI summary ── */}
              <StatsCard stats={currentStats.value} />

              {/* ── Ranked history ── */}
              {ranked.seasons.length > 0 ? (
                <section class="dash-section">
                  <div class="dash-section__head">
                    <h3>{t("dashboard.ranked")}</h3>
                  </div>
                  <div class="dash-ranked">
                    {ranked.seasons.map((rs) => {
                      const wr = rs.battles > 0 ? (rs.wins / rs.battles) * 100 : 0;
                      return (
                        <div class="dash-ranked__card" key={rs.seasonId}>
                          <div class="dash-ranked__season">{rs.seasonName}</div>
                          {rs.bestRankDisplay ? (
                            <div class="dash-ranked__rank" title={t("dashboard.bestRank")}>
                              {rs.bestRankDisplay}
                            </div>
                          ) : null}
                          <div class="dash-ranked__stats">
                            <span>{rs.battles} {t("dashboard.battles")}</span>
                            <span style={{ color: winrateColor(wr) }}>{wr.toFixed(1)}%</span>
                            <span>{rs.damageDealt > 0 ? Math.round(rs.damageDealt / rs.battles).toLocaleString() : "—"} {t("dashboard.avgDamage")}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {/* ── Ship stats: date range + inline filter chips ── */}
              <section class="dash-section">
                <div class="dash-section__controls">
                  <HTabs
                    variant="segmented"
                    modelValue={dateRange.value}
                    onUpdate:modelValue={(v: string) => (dateRange.value = v as DateRange)}
                    tabs={rangeOptions.map((o) => ({ key: o.value, label: o.label }))}
                  />
                  <ShipFilterBar
                    ships={dateFiltered.value}
                    realm={activeAccount.value?.realm ?? ""}
                    onChange={(v) => (filterState.value = v)}
                  />
                </div>

                {/* Group summary cards (compact) */}
                {typeSummary.value.length > 0 ? (
                  <div class="dash-type-grid">
                    {typeSummary.value.map((ts) => (
                      <div class="dash-type-card" key={ts.type}>
                        <span class="dash-type-card__code">{SHIP_TYPE_SHORT[ts.type] ?? "?"}</span>
                        <span class="dash-type-card__battles">{ts.battles.toLocaleString()}</span>
                        <span style={{ color: winrateColor(ts.winrate) }}>{ts.winrate.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {/* Flat ship table — multi-key sorted by the filter chips'
                    drag order (leftmost active chip = primary key). */}
                {filteredShips.value.length === 0 ? (
                  <p class="dash-empty">{t("dashboard.noShipsInRange")}</p>
                ) : (
                  <div class="dash-ship-table">
                    {filteredShips.value.map((s) => (
                      <div class="dash-ship-table__row" key={s.shipId}>
                        <span class="dash-ship-table__col-name">
                          <HTag variant="primary" size="sm">{shipTypeShort(s.shipId)}</HTag>
                          <span class="dash-ship-table__ship-name">{displayShipName(s)}</span>
                        </span>
                        <span class="dash-ship-table__col-num">{s.battles.toLocaleString()}</span>
                        <span
                          class="dash-ship-table__col-num"
                          style={{ color: winrateColor(s.winrate), fontWeight: 600 }}
                        >
                          {s.winrate.toFixed(1)}%
                        </span>
                        <span class="dash-ship-table__col-num">{s.avgDamage.toFixed(0)}</span>
                        <span class="dash-ship-table__col-num">
                          {(s.frags / Math.max(1, s.battles)).toFixed(2)}
                        </span>
                        <span class="dash-ship-table__col-date">{formatDate(s.lastBattleTime)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : stats.error ? (
            <div class="dashboard-view__error" key="error">{stats.error}</div>
          ) : null}
        </Transition>

        {currentStats.value ? <SScrollTop /> : null}

        <AccountSwitcherModal
          modelValue={showModal.value}
          onUpdate:modelValue={(v: boolean) => (showModal.value = v)}
          onBound={() => void refresh()}
        />
      </div>
    );
  },
});
