import { computed, defineComponent, onMounted, ref, watch, type VNode } from "vue";

import { api, type ExpectedPrEntry, type ShipStatsHistoryPoint } from "@/api";
import FilterCategoryChip from "@/components/ships/FilterCategoryChip";
import { useAccountStore } from "@/stores/account";
import { useShipStatsStore } from "@/stores/shipStats";
import { statsPrefsState } from "@/stores/statsPrefs";
import { useLanguage } from "@/i18n/useLanguage";
import { t } from "@/i18n";
import PrTrendChart from "./PrTrendChart";
import {
  expectedPrMap,
  prOfInterval,
  prTrendIntervals,
  prTrendShipCatalog,
  prTrendShipName,
  type PrTrendPoint,
} from "./prTrend";
import "./PrTrendSection.scss";

/** Canonical ship-type reading order for the type chip's options (BB→CV→CA→
 *  DD→SS, the dashboard filter bar's own order; only types present in the
 *  history get an option). */
const TYPE_ORDER = ["Battleship", "AirCarrier", "Cruiser", "Destroyer", "Submarine"];

/**
 * PR 趋势 — the playtime page's skill-trend section under the battle
 * heatmap: a line of per-interval wows-numbers PR derived entirely from
 * LOCALLY CACHED data (the per-ship history `lookup_player_ship_stats`
 * appends on every stats lookup, plus the 7-day expected-values table).
 * No new upstream traffic happens here beyond the (cached) expected-values
 * fetch — the points accrue as a side effect of normal water-meter use.
 *
 * The two filter chips (ship type / single ship) reuse the dashboard
 * filter bar's chip component, so the interaction and look stay the 水表
 * bar's: multi-select pills, AND across chips, 全部 resets. Selecting one
 * ship in the ship chip is the single-ship trend; the PR math aggregates
 * the selection the way the account PR does (battle-weighted expected
 * sums — see prTrend.ts).
 *
 * Bound to the ACTIVE account (the same identity the dashboard charts):
 * no active account or PR display disabled → nothing renders at all.
 */
export default defineComponent({
  name: "PrTrendSection",
  setup() {
    const account = useAccountStore();
    const shipStats = useShipStatsStore();
    const { uiLocale } = useLanguage();

    // The expected-values table is account-independent — load once.
    const expected = ref<ExpectedPrEntry[] | null>(null);
    onMounted(async () => {
      try {
        expected.value = await api.getExpectedPrTable();
      } catch {
        expected.value = [];
      }
    });

    // ── Filters (type AND ship narrow together; empty = that chip is off).
    // Declared ahead of the account watch: its immediate run and the filter
    // reset below both touch these. ──
    const typeSel = ref<string[]>([]);
    const shipSel = ref<string[]>([]);
    const openChip = ref<"type" | "ship" | null>(null);

    const activeAccount = computed(() => account.activeAccount);
    watch(
      activeAccount,
      (acc, prev) => {
        if (acc) void shipStats.loadHistory(acc.accountId, acc.realm);
        // A different account's ship ids mean nothing here — stale picks
        // would silently filter the new history down to nothing.
        if (prev) {
          typeSel.value = [];
          shipSel.value = [];
        }
      },
      { immediate: true },
    );

    // Per-account history points, read LIVE out of the ship-stats store:
    // the store's `load()` refreshes the history after every water-meter
    // lookup, so PR points land here without a remount. The watch above
    // only TRIGGERS the (local-file) read — reading through the computed
    // keeps a fast account switch from ever assigning the previous
    // account's late answer over the new one's.
    const historyPts = computed<ShipStatsHistoryPoint[] | null>(() => {
      const acc = activeAccount.value;
      return acc ? (shipStats.history.get(`${acc.realm}_${acc.accountId}`) ?? null) : null;
    });

    const intervals = computed(() =>
      historyPts.value ? prTrendIntervals(historyPts.value) : [],
    );
    const expectedMap = computed(() =>
      expected.value ? expectedPrMap(expected.value) : null,
    );

    function toggle(list: typeof typeSel, value: string) {
      list.value = list.value.includes(value)
        ? list.value.filter((v) => v !== value)
        : [...list.value, value];
    }

    const catalog = computed(() => prTrendShipCatalog(intervals.value));
    const typeOfShip = computed(() => {
      const m = new Map<number, string>();
      for (const s of catalog.value) m.set(s.shipId, s.type);
      return m;
    });

    /** t() returns the key when a message is missing — keep the raw key (or
     *  the caller's fallback) instead of leaking it into the UI (same guard
     *  as PlaytimeView). */
    function i18nOr(key: string, fallback: string): string {
      const lbl = t(key);
      return lbl === key ? fallback : lbl;
    }

    const typeOptions = computed(() => {
      const present = new Set(catalog.value.map((s) => s.type));
      return TYPE_ORDER.filter((ty) => present.has(ty)).map((ty) => ({
        value: ty,
        label: i18nOr(`dashboard.shipType.${ty}`, ty),
      }));
    });

    const shipOptions = computed(() =>
      catalog.value.map((s) => ({
        value: String(s.shipId),
        label:
          s.tier != null
            ? `T${s.tier} · ${prTrendShipName(s.shipId, uiLocale.value)}`
            : prTrendShipName(s.shipId, uiLocale.value),
      })),
    );

    function include(shipId: number): boolean {
      if (typeSel.value.length > 0) {
        const ty = typeOfShip.value.get(shipId);
        if (!ty || !typeSel.value.includes(ty)) return false;
      }
      if (shipSel.value.length > 0 && !shipSel.value.includes(String(shipId))) return false;
      return true;
    }

    const series = computed<PrTrendPoint[]>(() => {
      const table = expectedMap.value;
      if (!table) return [];
      const out: PrTrendPoint[] = [];
      for (const iv of intervals.value) {
        const p = prOfInterval(iv, table, include);
        if (p) out.push(p);
      }
      return out;
    });

    const totalBattles = computed(() => series.value.reduce((a, p) => a + p.battles, 0));

    /** `M/D` x labels — locale calendar rules without the year (the section
     *  sits under a heatmap that already carries the year context). */
    function fmtTick(ts: number): string {
      const d = new Date(ts * 1000);
      return d.toLocaleDateString(uiLocale.value, { month: "short", day: "numeric" });
    }

    function hintOf(p: PrTrendPoint): string {
      return t("playtime.prTrendPoint", {
        date: new Date(p.t * 1000).toLocaleDateString(uiLocale.value),
        pr: p.pr,
        battles: p.battles,
        wr: p.winrate.toFixed(1),
      });
    }

    return () => {
      // No bound account (or PR display off) → not this section's business.
      const acc = activeAccount.value;
      if (!acc || !statsPrefsState.value.prEnabled) return null;
      // Still loading either side — avoid an empty-state flash.
      if (!expectedMap.value || historyPts.value == null) return null;

      let body: VNode;
      if (expected.value?.length === 0) {
        body = <p class="playtime-view__note">{t("playtime.prTrendNoExpected")}</p>;
      } else if (historyPts.value.length === 0) {
        body = <p class="playtime-view__note">{t("playtime.prTrendEmpty")}</p>;
      } else if (series.value.length === 0) {
        body = <p class="playtime-view__note">{t("playtime.prTrendNoData")}</p>;
      } else {
        body = (
          <>
            <PrTrendChart points={series.value} fmtTick={fmtTick} hintOf={hintOf} />
            <p class="playtime-view__note">{t("playtime.prTrendHint")}</p>
          </>
        );
      }

      return (
        <section class="play-section pr-trend-section">
          <div class="play-section__head">
            <h3>{t("playtime.prTrendTitle")}</h3>
            <div class="play-section__controls">
              <FilterCategoryChip
                title={t("ships.filter.typeTitle")}
                allLabel={t("ships.filter.typeAll")}
                options={typeOptions.value}
                selected={new Set(typeSel.value)}
                open={openChip.value === "type"}
                onUpdate:open={(v: boolean) => (openChip.value = v ? "type" : null)}
                onAll={() => (typeSel.value = [])}
                onToggle={(v: string) => toggle(typeSel, v)}
              />
              <FilterCategoryChip
                title={t("playtime.prTrendShipChip")}
                allLabel={t("playtime.prTrendShipAll")}
                options={shipOptions.value}
                selected={new Set(shipSel.value)}
                open={openChip.value === "ship"}
                edge
                onUpdate:open={(v: boolean) => (openChip.value = v ? "ship" : null)}
                onAll={() => (shipSel.value = [])}
                onToggle={(v: string) => toggle(shipSel, v)}
              />
              {series.value.length > 0 ? (
                <span class="play-section__total">
                  {t("playtime.prTrendTotal", { n: totalBattles.value })}
                </span>
              ) : null}
            </div>
          </div>
          {body}
        </section>
      );
    };
  },
});
