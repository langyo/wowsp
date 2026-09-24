import { computed, defineComponent } from "vue";

import { HkSpinner } from "@celestia-island/hikari";

import RatingStamp from "@/components/base/RatingStamp";
import { useShipStatsStore } from "@/stores/shipStats";
import { useStatsStore } from "@/stores/stats";
import { useRankedStore } from "@/stores/ranked";
import type { PlayerShipStats } from "@/api";
import { t } from "@/i18n";
import {
  careerStamp,
  damageColor,
  prTier,
  prTierLabel,
  winrateColor,
  type StampKind,
} from "@/utils/winrate";
import { useStatsPrefsStore } from "@/stores/statsPrefs";
import { dateRangeCutoff, shipRecentDelta, type DateRange } from "@/utils/shipAggregation";
import { useClipboard } from "@/composables/useClipboard";
import "./ShipMyStatsPanel.scss";

/**
 * "My Stats" tab of the ship detail modal — the water-table header (StatsCard)
 * re-cut for a single ship, mirroring the account card's layout: centered hero
 * winrate with the PR block behind a divider, the per-ship 神了/海猴/蛆 PR
 * verdict stamp, the account-wide four-division winrate row, the KPI strip,
 * and the 1/7/30-day recent windows against the locally recorded per-ship
 * history baselines. Works for any viewed player (the modal passes the
 * accountId of whoever's water table opened it), not just the bound account.
 */
export default defineComponent({
  name: "ShipMyStatsPanel",
  props: {
    stats: { type: Object as () => PlayerShipStats | null, default: null },
    /** Whose stats these are (history lookup key). Null = no player context. */
    accountId: { type: Number as () => number | null, default: null },
    realm: { type: String as () => string | null, default: null },
    /** True while the per-ship fetch is in flight (spinner instead of the
     *  "no stats" dead end). */
    loading: { type: Boolean, default: false },
  },
  setup(props) {
    const shipStats = useShipStatsStore();
    const stats = useStatsStore();
    const ranked = useRankedStore();
    const prefs = useStatsPrefsStore();
    const { copy } = useClipboard();

    const history = computed(() => {
      if (props.accountId == null || !props.realm) return [];
      return shipStats.history.get(`${props.realm}_${props.accountId}`) ?? [];
    });

    /** The viewed player's account-level card (feeds the division row). */
    const accountStats = computed(() => {
      if (props.accountId == null || !props.realm) return null;
      return stats.cache.get(`${props.realm}_${props.accountId}`) ?? null;
    });

    /** Ranked WR only when the shared ranked slot actually holds this
     *  player's seasons (the store is a single slot across views). */
    const rankedWr = computed(() =>
      ranked.accountId != null && ranked.accountId === props.accountId ? ranked.winrate : null,
    );

    /** Ranked battles, under the same slot-ownership guard as `rankedWr`. */
    const rankedBattles = computed(() =>
      ranked.accountId != null && ranked.accountId === props.accountId ? ranked.battles : null,
    );

    /** Stamp: the ship's own PR verdict (神了 / 海猴 / 蛆). The career composition
     *  tags (空中小人 / 水下小人) stay on the account card — they describe the
     *  player's career, not this ship, and read as a ship verdict here. */
    const stamps = computed<StampKind[]>(() => {
      const career = careerStamp(
        props.stats?.pr ?? null,
        props.stats?.battles ?? null,
        props.stats?.winrate ?? null,
      );
      return career ? [career] : [];
    });

    const pr = computed(() => prTier(props.stats?.pr ?? null));

    /** "场次: 12,345" tooltip body for a split (null = count unknown — the
     *  slot then falls back to the shared context hint in the JSX). */
    const battlesHint = (battles: number | null | undefined) =>
      battles != null ? `${t("stats.battles")}: ${battles.toLocaleString()}` : null;

    /** The account-wide four-division winrates (same numbers as the account
     *  card). WG's per-ship endpoint serves no battle-type split, so this row
     *  is context, not per-ship — hinted as such. */
    const divisions = computed<{ label: string; wr: number | null; hint: string | null }[]>(() => [
      {
        label: t("stats.solo"),
        wr: accountStats.value?.soloWr ?? null,
        hint: battlesHint(accountStats.value?.soloBattles),
      },
      {
        label: t("stats.div2"),
        wr: accountStats.value?.div2Wr ?? null,
        hint: battlesHint(accountStats.value?.div2Battles),
      },
      {
        label: t("stats.div3"),
        wr: accountStats.value?.div3Wr ?? null,
        hint: battlesHint(accountStats.value?.div3Battles),
      },
      {
        label: t("stats.ranked"),
        wr: rankedWr.value,
        hint: [t("stats.rankedHint"), battlesHint(rankedBattles.value)]
          .filter(Boolean)
          .join(" · "),
      },
    ]);

    /** Career KPIs — the per-ship slice of the account card's KPI strip. */
    const kpis = computed(() => {
      const s = props.stats;
      if (!s) return [];
      const kdr = s.battles - s.survivedBattles > 0
        ? (s.frags / (s.battles - s.survivedBattles)).toFixed(2)
        : "—";
      return [
        { label: t("stats.battles"), value: s.battles.toLocaleString() },
        {
          label: t("stats.avgDamage"),
          // Any real battle deals damage — a zero here means the snapshot
          // slice is broken, so flag it instead of showing a red 0.
          value:
            s.battles > 0 && s.avgDamage <= 0
              ? t("stats.dataAnomaly")
              : Math.round(s.avgDamage).toLocaleString(),
          color: damageColor(s.avgDamage),
        },
        {
          label: t("stats.avgExp"),
          value: s.avgXp != null ? Math.round(s.avgXp).toLocaleString() : "—",
        },
        { label: t("stats.kdRatio"), value: kdr },
        {
          label: t("stats.survivalRate"),
          value: `${((s.survivedBattles / Math.max(1, s.battles)) * 100).toFixed(0)}%`,
        },
      ];
    });

    /** Recent windows: career totals minus the latest baseline at or before
     *  each range cutoff (single-ship `computeRecentDelta`). */
    const ranges = computed(() => {
      const s = props.stats;
      if (!s) return [];
      return (["1d", "7d", "30d"] as const).map((r: DateRange) => ({
        key: r,
        label: t(`ships.detail.my.range${r}`),
        delta: shipRecentDelta(s, history.value, dateRangeCutoff(r)),
      }));
    });

    return () => {
      const s = props.stats;
      if (!s) {
        return props.loading ? (
          <div class="ship-my-stats ship-my-stats--loading">
            <HkSpinner center size="md" />
          </div>
        ) : (
          <p class="ship-detail__empty">{t("ships.detail.noMyStats")}</p>
        );
      }
      return (
        <div class="ship-my-stats">
          {/* ── Career (全体成绩): hero winrate + PR, like the water-table
              header ── */}
          <section class="ship-my-stats__section">
            <h4 class="ship-my-stats__title">{t("ships.detail.my.career")}</h4>
            <div class="ship-my-stats__hero">
              <div class="ship-my-stats__hero-main">
                <span
                  class="ship-my-stats__wr"
                  style={{ color: winrateColor(s.winrate) }}
                  data-hint={`${t("stats.winrate")} · ${t("common.clickToCopy")}`}
                  onClick={() => copy(s.winrate.toFixed(1), t("common.copied"))}
                >
                  {s.winrate.toFixed(1)}%
                </span>
                <span class="ship-my-stats__wr-label">{t("stats.overallWr")}</span>
                <span
                  class="ship-my-stats__battles"
                  onClick={() => copy(s.battles.toLocaleString(), t("common.copied"))}
                >
                  {s.battles.toLocaleString()} {t("stats.battles")}
                </span>
              </div>
              {stamps.value.length > 0 &&
              prefs.prefs.prEnabled &&
              prefs.prefs.sealsEnabled ? (
                <div class="ship-my-stats__stamps">
                  {stamps.value.map((kind) => (
                    <RatingStamp key={kind} kind={kind} size={46} />
                  ))}
                </div>
              ) : null}
              {/* Per-ship PR block — hidden while the rating is off; the
                  hero keeps winrate (+ seals) without collapsing. */}
              {prefs.prefs.prEnabled ? (
                <div
                  class={["ship-my-stats__pr", pr.value.rainbow ? "rainbow-text" : null]}
                  style={pr.value.rainbow ? undefined : { color: pr.value.color }}
                  data-hint={`PR: ${s.pr ?? "—"} · ${t("common.clickToCopy")}`}
                  onClick={() => copy(String(s.pr ?? "—"), t("common.copied"))}
                >
                  <span class="ship-my-stats__pr-num">
                    {s.pr != null ? s.pr.toLocaleString() : "—"}
                  </span>
                  <span class="ship-my-stats__pr-label">{prTierLabel(pr.value.key)}</span>
                </div>
              ) : null}
            </div>

            {/* Account-wide division winrates — always four slots to mirror
                the account card (per-ship mode splits aren't served by WG). */}
            <div class="ship-my-stats__divisions">
              {divisions.value.map((d) => (
                <div
                  class="ship-my-stats__division"
                  key={d.label}
                  data-hint={d.hint ?? t("ships.detail.my.divisionsHint")}
                >
                  <span
                    class="ship-my-stats__division-wr"
                    style={d.wr != null ? { color: winrateColor(d.wr) } : undefined}
                  >
                    {d.wr != null ? `${d.wr.toFixed(1)}%` : "—"}
                  </span>
                  <span class="ship-my-stats__division-label">{d.label}</span>
                </div>
              ))}
            </div>

            {/* KPI strip */}
            <div class="ship-my-stats__kpis">
              {kpis.value.map((k) => (
                <div class="ship-my-stats__kpi" key={k.label}>
                  <span class="ship-my-stats__kpi-label">{k.label}</span>
                  <span
                    class="ship-my-stats__kpi-value"
                    style={k.color ? { color: k.color } : undefined}
                  >
                    {k.value}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* ── Recent windows (近1/7/30天) — hidden entirely until at least
              one window has a history baseline; a row of "no baseline"
              placeholders says nothing. ── */}
          {ranges.value.some((r) => r.delta) ? (
            <section class="ship-my-stats__section">
              <h4 class="ship-my-stats__title">{t("ships.detail.my.recent")}</h4>
              <div class="ship-my-stats__ranges">
                {ranges.value.map((r) => (
                  <div class="ship-my-stats__range" key={r.key}>
                    <div class="ship-my-stats__range-head">
                      <span class="ship-my-stats__range-label">{r.label}</span>
                      {r.delta ? (
                        <span
                          class="ship-my-stats__range-wr"
                          style={{ color: winrateColor(r.delta.winrate) }}
                        >
                          {r.delta.winrate.toFixed(1)}%
                        </span>
                      ) : null}
                    </div>
                    {r.delta ? (
                      <div class="ship-my-stats__range-rows">
                        <span>{`${r.delta.battles.toLocaleString()} ${t("stats.battles")}`}</span>
                        <span>{`${t("stats.avgDamage")} ${Math.round(r.delta.avgDamage).toLocaleString()}`}</span>
                        <span>{`${t("ships.detail.my.avgFrags")} ${r.delta.avgFrags.toFixed(2)}`}</span>
                      </div>
                    ) : (
                      <div class="ship-my-stats__range-empty">
                        {t("ships.detail.my.noBaseline")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <p class="ship-my-stats__note">{t("dashboard.rangeNoHistory")}</p>
            </section>
          ) : null}
        </div>
      );
    };
  },
});
