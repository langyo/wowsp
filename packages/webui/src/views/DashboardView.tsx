import { computed, defineComponent, ref, watch } from "vue";

import StatsCard from "@/components/stats/StatsCard";
import AccountSwitcherModal from "@/components/account/AccountSwitcherModal";
import SSpinner from "@/components/base/SSpinner";
import SSegmented from "@/components/base/SSegmented";
import STag from "@/components/base/STag";
import SScrollTop from "@/components/base/SScrollTop";
import PlayerBadge from "@/components/base/PlayerBadge";
import { useAccountStore } from "@/stores/account";
import { useStatsStore } from "@/stores/stats";
import { useShipStatsStore } from "@/stores/shipStats";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useTrendsStore } from "@/stores/trends";
import { useRankedStore } from "@/stores/ranked";
import { winrateColor } from "@/utils/winrate";
import {
  filterByDateRange,
  aggregateByType,
  SHIP_TYPE_SHORT,
  type DateRange,
} from "@/utils/shipAggregation";
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

    const showModal = ref(false);
    const dateRange = ref<DateRange>("all");
    /** Sort column for the ship table. */
    const sortBy = ref<"battles" | "winrate" | "avgDamage">("battles");
    /** Group mode for the ship table: by type, nation, or tier bracket. */
    const groupMode = ref<"type" | "nation" | "tier">("type");

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
    const filteredShips = computed(() =>
      filterByDateRange(playerShips.value, dateRange.value),
    );

    /** Group ships by the selected dimension (type/nation/tier bracket). */
    interface ShipGroup {
      key: string;
      label: string;
      ships: typeof filteredShips.value;
    }
    const groupedShips = computed<ShipGroup[]>(() => {
      const ships = sortedShips.value;
      if (groupMode.value === "type") {
        const m = new Map<string, ShipGroup>();
        for (const s of ships) {
          const type = encyclopedia.byId.get(s.shipId)?.type ?? "Unknown";
          let g = m.get(type);
          if (!g) {
            g = { key: type, label: t(`dashboard.shipType.${type}`, {}), ships: [] };
            m.set(type, g);
          }
          g.ships.push(s);
        }
        return [...m.values()];
      }
      if (groupMode.value === "nation") {
        const m = new Map<string, ShipGroup>();
        for (const s of ships) {
          const nation = encyclopedia.byId.get(s.shipId)?.nation ?? "unknown";
          let g = m.get(nation);
          if (!g) {
            g = { key: nation, label: t(`ships.nation.${nation}`, {}), ships: [] };
            m.set(nation, g);
          }
          g.ships.push(s);
        }
        return [...m.values()];
      }
      // tier bracket: I-V, VI-VII, VIII-IX, X-*
      const brackets: [string, string, number[]][] = [
        ["I-V", "I \u2013 V", [1, 2, 3, 4, 5]],
        ["VI-VII", "VI \u2013 VII", [6, 7]],
        ["VIII-IX", "VIII \u2013 IX", [8, 9]],
        ["X-star", "X \u2013 \u2605", [10, 11]],
      ];
      return brackets
        .map(([key, label, tiers]) => ({
          key,
          label,
          ships: ships.filter((s) => tiers.includes(encyclopedia.byId.get(s.shipId)?.tier ?? 0)),
        }))
        .filter((g) => g.ships.length > 0);
    });

    // Per-ship-type aggregation (computed from filtered ships + encyclopedia).
    const typeSummary = computed(() =>
      aggregateByType(filteredShips.value, encyclopedia.byId),
    );

    // Sorted ship list for the table.
    const sortedShips = computed(() => {
      const list = [...filteredShips.value];
      list.sort((a, b) => {
        if (sortBy.value === "battles") return b.battles - a.battles;
        if (sortBy.value === "winrate") return b.winrate - a.winrate;
        return b.avgDamage - a.avgDamage;
      });
      return list;
    });

    async function refresh() {
      const acc = activeAccount.value;
      if (!acc) return;
      // Phase 1: warm the account-level cache (instant render on cold start).
      try {
        await stats.loadCached(acc.realm, acc.accountId);
      } catch {
        // cache miss — fine
      }
      // Phase 2: fetch fresh account stats (this populates avgDamage, PR, etc.
      // via the WG account/info endpoint).
      try {
        await stats.lookup(acc.nickname, acc.realm);
      } catch {
        // surfaced via stats.error
      }
      // Phase 3: per-ship stats + encyclopedia + trends — each independent.
      // Use allSettled so a failure in one (e.g. trends) doesn't block the
      // others (e.g. shipStats). Each store surfaces its own error.
      await Promise.allSettled([
        shipStats.load(acc.accountId, acc.realm),
        encyclopedia.load(acc.realm),
        trends.loadPlayer(acc.accountId, acc.realm),
        ranked.load(acc.accountId, acc.realm, 5),
      ]);
    }

    // Refresh on mount + whenever the active account changes. We always
    // refresh (not just on cache miss) so per-ship stats + trends load even
    // when account-level stats are already cached from a previous session.
    watch(activeAccount, (acc) => {
      if (acc) void refresh();
    }, { immediate: true });

    function shipTypeName(shipId: number): string {
      const info = encyclopedia.byId.get(shipId);
      const code = info?.type ?? "Unknown";
      return t(`dashboard.shipType.${code}`, {});
    }
    function shipTypeShort(shipId: number): string {
      const info = encyclopedia.byId.get(shipId);
      return SHIP_TYPE_SHORT[info?.type ?? "Unknown"] ?? "?";
    }
    function shipName(shipId: number, fallbackName: string): string {
      return encyclopedia.byId.get(shipId)?.name ?? fallbackName ?? `#${shipId}`;
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
              <button class="dashboard-view__bind" onClick={() => (showModal.value = true)}>
                {t("account.search")}
              </button>
            </div>
          ) : stats.loading && !currentStats.value ? (
            <div class="dashboard-view__loading" key="loading">
              <SSpinner center size="lg" text={t("dashboard.loading")} />
            </div>
          ) : currentStats.value ? (
            <div class="dashboard-view__content" key="content">
              {/* ── Identity header (centered) ── */}
              <header class="dash-identity">
                <PlayerBadge tier={currentStats.value.levelingTier ?? 0} dogTag={currentStats.value.dogTag ?? null} size={56} />
                <div class="dash-identity__info">
                  <h1 class="dash-identity__name">
                    {currentStats.value.clanTag ? (
                      <span class="dash-identity__clan">[{currentStats.value.clanTag}]</span>
                    ) : null}
                    {currentStats.value.name}
                  </h1>
                  <div class="dash-identity__tags">
                    <STag variant="neutral" size="sm">{currentStats.value.realm.toUpperCase()}</STag>
                    {currentStats.value.hidden ? (
                      <STag variant="danger" size="sm">{t("stats.hidden")}</STag>
                    ) : null}
                  </div>
                </div>
              </header>

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

              {/* ── Ship stats: group mode + date range + sort (no text titles,
                   the button groups ARE the section headers) ── */}
              <section class="dash-section">
                {/* Row 1: group mode + sort */}
                <div class="dash-section__controls">
                  <SSegmented
                    modelValue={groupMode.value}
                    onUpdate:modelValue={(v: string) => (groupMode.value = v as typeof groupMode.value)}
                    options={[
                      { value: "type", label: t("dashboard.byType") },
                      { value: "nation", label: t("dashboard.byNation") },
                      { value: "tier", label: t("dashboard.byTier") },
                    ]}
                  />
                  <SSegmented
                    modelValue={sortBy.value}
                    onUpdate:modelValue={(v: string) => (sortBy.value = v as typeof sortBy.value)}
                    options={[
                      { value: "battles", label: t("dashboard.battles") },
                      { value: "winrate", label: t("dashboard.winrate") },
                      { value: "avgDamage", label: t("dashboard.avgDamage") },
                    ]}
                  />
                </div>
                {/* Row 2: date range */}
                <SSegmented
                  modelValue={dateRange.value}
                  onUpdate:modelValue={(v: string) => (dateRange.value = v as DateRange)}
                  options={rangeOptions}
                  block
                />

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

                {/* Grouped ship table */}
                {groupedShips.value.length === 0 ? (
                  <p class="dash-empty">{t("dashboard.noShipsInRange")}</p>
                ) : (
                  groupedShips.value.map((group) => (
                    <div class="dash-ship-group" key={group.key}>
                      <h4 class="dash-ship-group__title">{group.label} <span class="dash-ship-group__count">({group.ships.length})</span></h4>
                      <div class="dash-ship-table">
                        {group.ships.map((s) => (
                          <div class="dash-ship-table__row" key={s.shipId}>
                            <span class="dash-ship-table__col-name">
                              <STag variant="primary" size="sm">{shipTypeShort(s.shipId)}</STag>
                              <span class="dash-ship-table__ship-name">{shipName(s.shipId, s.name)}</span>
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
                    </div>
                  ))
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
