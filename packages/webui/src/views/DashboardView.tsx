import { computed, defineComponent, ref, Transition, watch } from "vue";
import { useRouter } from "vue-router";

import StatsCard from "@/components/stats/StatsCard";
import RankedSeasonModal from "@/components/stats/RankedSeasonModal";
import RefreshStatsButton from "@/components/stats/RefreshStatsButton";
import AccountSwitcherModal from "@/components/account/AccountSwitcherModal";
import { HkTag, HkTabs, HkButton } from "@celestia-island/hikari";

import ShipFilterBar from "@/components/ships/ShipFilterBar";
import ShipDetailModal from "@/components/ships/ShipDetailModal";
import ShipDistCharts from "@/components/stats/ShipDistCharts";
import SScrollTop from "@/components/base/SScrollTop";
import { useShipDetail } from "@/composables/useShipDetail";
import { useAccountStore } from "@/stores/account";
import { useStatsStore } from "@/stores/stats";
import { useLoadingTasksStore } from "@/stores/loadingTasks";
import { useShipStatsStore } from "@/stores/shipStats";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useTrendsStore } from "@/stores/trends";
import { useRankedStore } from "@/stores/ranked";
import { useStatsPrefsStore } from "@/stores/statsPrefs";
import { useLanguage } from "@/i18n/useLanguage";
import { useCareerStamp } from "@/composables/useCareerStamp";
import { useCompositionStamps } from "@/composables/useCompositionStamps";
import ShareShotButton from "@/features/share/ShareShotButton";
import { renderStatsShot, type StatsShotModel } from "@/features/share/statsShot";
import { useShareImage } from "@/features/share/useShareImage";
import { damageColor, prTier, prTierLabel, winrateColor } from "@/utils/winrate";
import {
  computeRecentDelta,
  dateRangeCutoff,
  filterByDateRange,
  aggregateByType,
  SHIP_TYPE_SHORT,
  type DateRange,
} from "@/utils/shipAggregation";
import { shipNameFromModelDb, shipNameFromOfflineDb } from "@/features/holographic/modelLoader";
import { t } from "@/i18n";
import "./DashboardView.scss";

/** Revisit window for the dashboard's WG API queries. Opening or switching
 *  back to the dashboard within this span serves the cached snapshot —
 *  account stats, per-ship stats and ranked alike — instead of re-querying
 *  every leg; past the window the next open pulls fresh, and the stats
 *  card's refresh pill always forces a pull. Battles outlast the window,
 *  so stats that could actually have changed still reload. */
const DASHBOARD_STATS_TTL_MS = 5 * 60_000;

/**
 * "My stats" dashboard — a rich personal stats page.
 *
 * Layout (top to bottom):
 *   1. Identity row: avatar + clan tag + nickname + realm, rendered at the
 *      top of the StatsCard (not a standalone block).
 *   2. KPI summary: the same StatsCard (PR / winrate / battles / avgDamage / etc.).
 *   3. Ship-distribution charts (tier histogram + class/nation donuts) —
 *      fed the UNFILTERED career ship list; like the lookup page they
 *      never react to the date-range tabs or the filter chips below.
 *   4. Ranked history: NOT listed inline — the StatsCard's ranked split
 *      opens the season-timeline modal (RankedSeasonModal) on click.
 *   5. Date-range segmented control (1D / 7D / 30D / All) — filters the
 *      per-ship list below by lastBattleTime.
 *   6. Per-ship-type breakdown: battles / winrate / avgDamage by BB/CA/DD/CV/SS.
 *   7. Per-ship table: every ship played (in the selected range), sortable by
 *      battles / winrate / avgDamage, with color-coded winrate.
 *   8. Floating scroll-to-top button (appears on scroll).
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
    const loadingTasks = useLoadingTasksStore();
    const router = useRouter();
    const prefs = useStatsPrefsStore();
    const { uiLocale } = useLanguage();
    // Root element feeds the share shot's live theme palette.
    const root = ref<HTMLElement | null>(null);

    const showModal = ref(false);
    // Which account's refresh is currently running (null = idle) — drives
    // the refresh pill's spinner and drops same-account double-fires.
    const refreshingFor = ref<string | null>(null);
    const refreshing = computed(() => refreshingFor.value != null);
    // Ranked season-timeline modal — opened from the StatsCard's ranked
    // split (the inline season cards are gone from this page).
    const rankedModal = ref(false);
    const dateRange = ref<DateRange>("all");

    // Ship detail modal (opened by clicking a row in the per-ship table).
    const shipDetail = useShipDetail();

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

    // Real "recent N days" view — current career totals minus the latest
    // locally recorded history point at or before the range cutoff (WG has
    // no per-battle data). Null until an old-enough baseline exists, i.e.
    // for the first lookups of an account on this install.
    const recentDelta = computed(() => {
      if (dateRange.value === "all") return null;
      const acc = activeAccount.value;
      if (!acc) return null;
      const hist = shipStats.history.get(`${acc.realm}_${acc.accountId}`) ?? [];
      return computeRecentDelta(playerShips.value, hist, dateRangeCutoff(dateRange.value));
    });

    // Ships shown for the selected range: true deltas when a baseline
    // exists, otherwise the labeled career fallback (recently-played ships
    // carrying career totals — see the range note below).
    const dateFiltered = computed(
      () => recentDelta.value?.ships ?? filterByDateRange(playerShips.value, dateRange.value),
    );

    /** Filtered + multi-key-sorted ships and search-hit names, from
     *  ShipFilterBar (the fixed canonical chip order defines the sort priority). */
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

    async function refresh(force = false) {
      const acc = activeAccount.value;
      if (!acc) return;
      // The mount watcher, the refresh pill and account binding all funnel
      // here — drop only same-account double-fires (a route flip during a
      // running load); an account switch must refresh immediately.
      const runKey = `${acc.realm}_${acc.accountId}`;
      if (refreshingFor.value === runKey) return;
      refreshingFor.value = runKey;
      // Persistent progress now rides the title-bar chip (left of the
      // settings gear) instead of a top-right toast slot.
      const taskId = loadingTasks.begin(t("dashboard.loading"));
      try {
        // Phase 1: warm the account-level cache (instant render on cold
        // start).
        try {
          await stats.loadCached(acc.realm, acc.accountId);
        } catch {
          // cache miss — fine
        }
        // Phase 2: account-level stats. Forced on the refresh pill; account
        // binding asks for force too, though that run is usually dropped by
        // the same-account guard above (the account-change watcher's
        // non-force refresh is already in flight — harmless, since the
        // bind flow itself just force-queried the account). Otherwise a
        // snapshot younger than the revisit TTL serves from cache, so
        // hopping between views doesn't re-query the WG API on every
        // dashboard open.
        try {
          await stats.lookup(
            acc.nickname,
            acc.realm,
            force ? { force: true } : { ttlMs: DASHBOARD_STATS_TTL_MS },
          );
        } catch {
          // surfaced via stats.error
        }
        // Phase 3: per-ship stats + encyclopedia + trends — parallel; the
        // same TTL gates per-ship and ranked, so a revisit inside the
        // window is fully network-free.
        const ttlOpts = force ? undefined : { ttlMs: DASHBOARD_STATS_TTL_MS };
        await Promise.allSettled([
          shipStats.load(acc.accountId, acc.realm, ttlOpts),
          encyclopedia.load(acc.realm),
          trends.loadPlayer(acc.accountId, acc.realm),
          ranked.load(acc.accountId, acc.realm, undefined, ttlOpts),
        ]);
      } finally {
        loadingTasks.end(taskId);
        if (refreshingFor.value === runKey) refreshingFor.value = null;
      }
    }

    // Refresh on mount + whenever the active account changes. The revisit
    // TTL above keeps route flips network-free; per-ship stats + trends
    // still load whenever the caches are cold (a session's first open).
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

    // ── Share shot ────────────────────────────────────────────────────
    // Career + composition seals for the shot, the same gates the live
    // card applies (zh locale + PR master + seals toggle); the career
    // verdict's clan gate lives in the shared composable.
    const stampKind = useCareerStamp(() => currentStats.value);
    const composition = useCompositionStamps(
      () => activeAccount.value?.accountId ?? null,
      () => activeAccount.value?.realm ?? "",
    );
    const SHOT_SHIP_LIMIT = 8;

    function buildShotModel(): StatsShotModel {
      const s = currentStats.value;
      if (!s) throw new Error("no stats loaded for the share shot");
      const rangeText = {
        "1d": t("dashboard.range1d"),
        "7d": t("dashboard.range7d"),
        "30d": t("dashboard.range30d"),
        all: t("dashboard.rangeAll"),
      }[dateRange.value];
      const rangeLabel =
        dateRange.value !== "all" && recentDelta.value
          ? `${rangeText} · ${new Date(recentDelta.value.sinceTs * 1000).toLocaleDateString()}`
          : rangeText;
      const pr = prTier(s.pr);
      // Same anomaly flag the card's KPI strip uses — battles with zero
      // damage are broken snapshot data.
      const damageAnomaly =
        s.battles != null && s.battles > 0 && s.avgDamage != null && s.avgDamage <= 0;
      const sealsOn =
        uiLocale.value.startsWith("zh") &&
        prefs.prefs.prEnabled &&
        prefs.prefs.sealsEnabled;
      const fmtWr = (wr: number | null | undefined) =>
        wr != null ? `${wr.toFixed(1)}%` : "—";
      const ships = filteredShips.value.slice(0, SHOT_SHIP_LIMIT);
      return {
        title: t("nav.dashboard"),
        rangeLabel,
        realm: s.realm,
        name: s.name,
        clanTag: s.clanTag,
        hidden: !!s.hidden,
        hiddenLabel: t("stats.hidden"),
        stamp: sealsOn ? stampKind.value : null,
        airSub: sealsOn ? composition.value : null,
        prOn: prefs.prefs.prEnabled,
        hero: {
          winrate: s.winrate != null ? `${s.winrate.toFixed(1)}%` : "—",
          winrateColor: winrateColor(s.winrate),
          winrateLabel: t("stats.winrate"),
          battlesText:
            s.battles != null ? `${s.battles.toLocaleString()} ${t("stats.battles")}` : "—",
          pr: s.pr != null ? s.pr.toLocaleString() : null,
          prColor: pr.rainbow ? undefined : pr.color,
          prRainbow: pr.rainbow,
          prLabel: prTierLabel(pr.key),
        },
        // The live card hides the strip when every split is unknown —
        // the shot keeps the same gate.
        divisions:
          [s.soloWr, s.div2Wr, s.div3Wr, ranked.winrate].some((wr) => wr != null)
            ? [
                { label: t("stats.solo"), value: fmtWr(s.soloWr), color: winrateColor(s.soloWr) },
                { label: t("stats.div2"), value: fmtWr(s.div2Wr), color: winrateColor(s.div2Wr) },
                { label: t("stats.div3"), value: fmtWr(s.div3Wr), color: winrateColor(s.div3Wr) },
                { label: t("stats.ranked"), value: fmtWr(ranked.winrate), color: winrateColor(ranked.winrate) },
              ]
            : [],
        kpis: [
          { label: t("stats.battles"), value: s.battles != null ? s.battles.toLocaleString() : "—" },
          {
            label: t("stats.avgDamage"),
            value: damageAnomaly
              ? t("stats.dataAnomaly")
              : s.avgDamage != null
                ? Math.round(s.avgDamage).toLocaleString()
                : "—",
            color: damageAnomaly ? damageColor(0) : undefined,
          },
          { label: t("stats.avgExp"), value: s.avgXp != null ? Math.round(s.avgXp).toLocaleString() : "—" },
          { label: t("stats.kdRatio"), value: s.kdRatio != null ? s.kdRatio.toFixed(2) : "—" },
          { label: t("stats.survivalRate"), value: s.survivalRate != null ? `${s.survivalRate.toFixed(0)}%` : "—" },
          { label: t("stats.hitRate"), value: s.hitRate != null ? `${s.hitRate.toFixed(0)}%` : "—" },
        ],
        typeChips: typeSummary.value.map((ts) => ({
          code: SHIP_TYPE_SHORT[ts.type] ?? "?",
          battles: ts.battles.toLocaleString(),
          value: `${ts.winrate.toFixed(1)}%`,
          color: winrateColor(ts.winrate),
        })),
        shipsTitle: t("share.topShips"),
        shipsHead: [
          t("stats.battles"),
          t("stats.winrate"),
          t("stats.avgDamage"),
          t("stats.kdRatio"),
        ],
        ships: ships.map((ship) => ({
          name: displayShipName(ship),
          shipType: encyclopedia.byId.get(ship.shipId)?.type ?? null,
          cells: [
            { text: ship.battles.toLocaleString() },
            { text: `${ship.winrate.toFixed(1)}%`, color: winrateColor(ship.winrate) },
            {
              text:
                ship.battles > 0 && ship.avgDamage <= 0
                  ? t("stats.dataAnomaly")
                  : ship.avgDamage.toFixed(0),
            },
            { text: (ship.frags / Math.max(1, ship.battles)).toFixed(2) },
          ],
        })),
        moreShips:
          filteredShips.value.length > SHOT_SHIP_LIMIT
            ? t("share.moreShips", { n: filteredShips.value.length - SHOT_SHIP_LIMIT })
            : null,
      };
    }

    const shot = useShareImage(() => renderStatsShot(buildShotModel(), { el: root.value }));

    return () => (
      <div class="dashboard-view" ref={root}>
        <Transition name="s-fade-slide" mode="out-in">
          {!activeAccount.value ? (
            <div class="dashboard-view__empty" key="empty">
              <div class="dashboard-view__empty-icon">
                <img src="/logo.webp" alt="WoWSP" />
              </div>
              <h2 class="dashboard-view__title">{t("dashboard.noAccount")}</h2>
              <p class="dashboard-view__hint">{t("dashboard.noAccountHint")}</p>
              <HkButton onClick={() => (showModal.value = true)}>
                {t("account.search")}
              </HkButton>
            </div>
          ) : currentStats.value ? (
            <div class="dashboard-view__content" key="content">
              {/* ── KPI summary (clan tag jumps to the lookup's clan mode) ── */}
              <StatsCard
                stats={currentStats.value}
                rankedWr={ranked.winrate}
                rankedBattles={ranked.battles}
                onRankedClick={() => (rankedModal.value = true)}
                onClanClick={
                  currentStats.value.clanId != null
                    ? () =>
                        router.push({
                          path: "/lookup",
                          query: {
                            clan: String(currentStats.value!.clanId!),
                            realm: activeAccount.value?.realm ?? "",
                          },
                        })
                    : undefined
                }
                v-slots={{
                  actions: () => (
                    <>
                      <RefreshStatsButton
                        busy={refreshing.value}
                        onRefresh={() => void refresh(true)}
                      />
                      <ShareShotButton
                        busy={shot.busy.value}
                        onShot={() => void shot.copyShot()}
                      />
                    </>
                  ),
                }}
              />

              {/* ── Ship distribution charts — fed the UNFILTERED career
                  list (playerShips): like the lookup page, the tier
                  histogram and both donuts must never react to the
                  date-range tabs or the filter chips below. ── */}
              {playerShips.value.length > 0 ? (
                <section class="dash-section">
                  <div class="dash-section__head">
                    <h3>{t("dashboard.distTitle")}</h3>
                  </div>
                  <div class="dashboard-view__dist">
                    <ShipDistCharts
                      ships={playerShips.value.map((s) => ({ shipId: s.shipId, battles: s.battles }))}
                    />
                  </div>
                </section>
              ) : null}

              {/* ── Ranked history lives in the season-timeline modal —
                  opened from the StatsCard's ranked split above. ── */}

              {/* ── Ship stats: date range + inline filter chips ── */}
              <section class="dash-section">
                <div class="dash-section__controls">
                  <HkTabs
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

                {/* What the selected range actually covers — WG only serves
                    career totals, so deltas need a local baseline. */}
                {dateRange.value !== "all" ? (
                  <p class="dash-range-note">
                    {recentDelta.value
                      ? t("dashboard.rangeSince", {
                          date: new Date(recentDelta.value.sinceTs * 1000).toLocaleDateString(),
                        })
                      : t("dashboard.rangeNoHistory")}
                  </p>
                ) : null}

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
                    fixed canonical order (earlier sorting category = primary key). Two
                    empty states: the range itself played nothing vs. the
                    range has ships that the filters/search all exclude. */}
                {filteredShips.value.length === 0 ? (
                  <p class="dash-empty">
                    {dateFiltered.value.length === 0
                      ? t("dashboard.noShipsInRange")
                      : t("dashboard.noShipsMatchFilter")}
                  </p>
                ) : (
                  <div class="dash-ship-table">
                    {filteredShips.value.map((s) => (
                      <div
                        class="dash-ship-table__row dash-ship-table__row--link"
                        key={s.shipId}
                        role="button"
                        tabindex={0}
                        data-hint={t("ships.detail.openHint")}
                        onClick={() =>
                          activeAccount.value &&
                          shipDetail.openShip(s.shipId, displayShipName(s), activeAccount.value.realm)
                        }
                        onKeydown={(e: KeyboardEvent) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          if (activeAccount.value) {
                            shipDetail.openShip(s.shipId, displayShipName(s), activeAccount.value.realm);
                          }
                        }}
                      >
                        <span class="dash-ship-table__col-name">
                          <HkTag variant="primary" size="sm">{shipTypeShort(s.shipId)}</HkTag>
                          <span class="dash-ship-table__ship-name">{displayShipName(s)}</span>
                        </span>
                        <span class="dash-ship-table__col-num">{s.battles.toLocaleString()}</span>
                        <span
                          class="dash-ship-table__col-num"
                          style={{ color: winrateColor(s.winrate), fontWeight: 600 }}
                        >
                          {s.winrate.toFixed(1)}%
                        </span>
                        <span class="dash-ship-table__col-num">
                          {/* Battles with zero damage are broken snapshot
                              data — same anomaly flag as the ship modal. */}
                          {s.battles > 0 && s.avgDamage <= 0
                            ? t("stats.dataAnomaly")
                            : s.avgDamage.toFixed(0)}
                        </span>
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

        {/* Ship detail popup — water-table context: defaults to the My Stats
            tab with the holographic stage collapsed. */}
        <ShipDetailModal
          ship={shipDetail.selectedShip.value}
          source="water"
          accountId={activeAccount.value?.accountId ?? null}
          realm={activeAccount.value?.realm ?? null}
          gameRoot={shipDetail.gameRoot.value}
          onClose={() => shipDetail.closeShip()}
        />

        <AccountSwitcherModal
          modelValue={showModal.value}
          onUpdate:modelValue={(v: boolean) => (showModal.value = v)}
          onBound={() => void refresh(true)}
        />

        {/* Ranked season timeline — the store already holds this account's
            seasons (loaded in refresh()); the modal only presents them. */}
        <RankedSeasonModal
          modelValue={rankedModal.value}
          onUpdate:modelValue={(v: boolean) => (rankedModal.value = v)}
          playerName={currentStats.value?.name ?? ""}
        />
      </div>
    );
  },
});
