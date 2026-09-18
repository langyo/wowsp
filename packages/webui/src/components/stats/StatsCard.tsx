import { computed, defineComponent, type PropType } from "vue";

import { HTag } from "@celestia-island/hikari";
import IdentityHead from "@/components/stats/IdentityHead";
import PlayerBadge from "@/components/base/PlayerBadge";
import RatingStamp from "@/components/base/RatingStamp";
import type { PlayerStats } from "@/api";
import { t } from "@/i18n";
import { careerStamp, prTier, winrateColor, winrateTier } from "@/utils/winrate";
import { useClipboard } from "@/composables/useClipboard";
import "./StatsCard.scss";

/**
 * Deep-stats card modeled on ApeRadar's layout:
 *   ┌─ identity: name + clan tag + realm + hidden badge ─
 *   ├─ PR summary bar: big PR number + tier label, color-coded
 *   ├─ KPI grid: winrate / battles / avg damage / avg XP / K-D / survival
 *   └─ division split: solo / div2 / div3 / ranked winrates (when present)
 *
 * Color coding (mirrors community convention):
 *   red < 47% → yellow 47-50% → green 50-55% → purple > 55%.
 */
export default defineComponent({
  name: "StatsCard",
  props: {
    stats: { type: Object as () => PlayerStats, required: true },
    /** Combined ranked winrate across the loaded seasons (null = unknown). */
    rankedWr: { type: Number as PropType<number | null>, default: null },
    /** Clan tag clicked → jump to the clan view. Rendered as a link only
     *  when the stats carry a clan id. */
    onClanClick: Function as PropType<() => void>,
  },
  setup(props) {
    const pr = computed(() => prTier(props.stats.pr));
    const prLabel = computed(() =>
      pr.value.key === "unknown" ? "—" : t(`stats.${pr.value.key}`),
    );
    const stamp = computed(() => careerStamp(props.stats.pr, props.stats.battles));
    const wrTier = computed(() => winrateTier(props.stats.winrate));
    const wrColor = computed(() => winrateColor(props.stats.winrate));
    const { copy } = useClipboard();

    const kpis = computed(() => [
      {
        label: t("stats.battles"),
        value: props.stats.battles != null ? props.stats.battles.toLocaleString() : "—",
      },
      {
        label: t("stats.avgDamage"),
        value: props.stats.avgDamage != null ? Math.round(props.stats.avgDamage).toLocaleString() : "—",
      },
      {
        label: t("stats.avgExp"),
        value: props.stats.avgXp != null ? Math.round(props.stats.avgXp).toLocaleString() : "—",
      },
      {
        label: t("stats.kdRatio"),
        value: props.stats.kdRatio != null ? props.stats.kdRatio.toFixed(2) : "—",
      },
      {
        label: t("stats.survivalRate"),
        value: props.stats.survivalRate != null ? `${props.stats.survivalRate.toFixed(0)}%` : "—",
      },
      {
        label: t("stats.hitRate"),
        value: props.stats.hitRate != null ? `${props.stats.hitRate.toFixed(0)}%` : "—",
      },
    ]);

    /** Division splits: solo / div2 / div3 / ranked winrates. Ranked is fed
     *  from the ranked store via the `rankedWr` prop (null = no data).
     *  Displayed in a compact row below the main winrate. */
    const divisions = computed<{ label: string; wr: number | null; hint?: string }[]>(() => [
      { label: t("stats.solo"), wr: props.stats.soloWr ?? null },
      { label: t("stats.div2"), wr: props.stats.div2Wr ?? null },
      { label: t("stats.div3"), wr: props.stats.div3Wr ?? null },
      { label: t("stats.ranked"), wr: props.rankedWr, hint: t("stats.rankedHint") },
    ]);

    return () => (
      <div class={["stats-card", `stats-card--${wrTier.value}`]}>
        {/* identity header */}
        <IdentityHead
          name={props.stats.name}
          tag={props.stats.clanTag}
          onTagClick={
            props.onClanClick && props.stats.clanId != null
              ? () => props.onClanClick?.()
              : undefined
          }
          v-slots={{
            avatar: () => (
              <PlayerBadge
                tier={props.stats.levelingTier ?? 0}
                dogTag={props.stats.dogTag ?? null}
                size={36}
              />
            ),
            badges: () => (
              <>
                <HTag variant="default" size="sm">{props.stats.realm.toUpperCase()}</HTag>
                {props.stats.hidden ? (
                  <HTag variant="danger" size="sm">{t("stats.hidden")}</HTag>
                ) : null}
              </>
            ),
          }}
        />

        {/* ── Main winrate + PR bar ──
            Big winrate on the left, PR on the right (same row).
            Below: total battles as small text.
            Below that: 4 division winrates in a compact centered row. */}
        <div class="stats-card__hero">
          <div class="stats-card__hero-main">
            <span
              class="stats-card__wr"
              style={wrColor.value ? { color: wrColor.value } : undefined}
              onClick={() => copy(String(props.stats.winrate?.toFixed(1) ?? "—"), t("common.copied"))}
              data-hint={`${t("stats.winrate")} · ${t("common.clickToCopy")}`}
            >
              {props.stats.winrate != null ? `${props.stats.winrate.toFixed(1)}%` : "—"}
            </span>
            <span class="stats-card__wr-label">{t("stats.winrate")}</span>
            <span
              class="stats-card__battles-total"
              onClick={() => copy(String(props.stats.battles ?? "—"), t("common.copied"))}
              data-hint={`${t("stats.battles")} · ${t("common.clickToCopy")}`}
            >
              {props.stats.battles != null ? `${props.stats.battles.toLocaleString()} ${t("stats.battles")}` : "—"}
            </span>
          </div>
          {stamp.value ? (
            <RatingStamp class="stats-card__stamp" kind={stamp.value} size={58} />
          ) : null}
          <div
            class={["stats-card__pr-block", pr.value.rainbow ? "rainbow-text" : null]}
            style={pr.value.rainbow ? undefined : { color: pr.value.color }}
            onClick={() => copy(String(props.stats.pr ?? "—"), t("common.copied"))}
            data-hint={`PR: ${props.stats.pr ?? "—"} (${prLabel.value}) · ${t("common.clickToCopy")}`}
          >
            <span class="stats-card__pr-num">
              {props.stats.pr != null ? props.stats.pr.toLocaleString() : "—"}
            </span>
            <span class="stats-card__pr-label">{prLabel.value}</span>
          </div>
        </div>

        {/* Division splits: 4 columns centered (solo / div2 / div3 / ranked) */}
        {divisions.value.some((d) => d.wr != null) ? (
          <div class="stats-card__divisions">
            {divisions.value.map((d) => (
              <div class="stats-card__division" key={d.label}>
                <span
                  class="stats-card__division-wr"
                  style={d.wr != null ? { color: winrateColor(d.wr) } : undefined}
                  data-hint={d.hint}
                >
                  {d.wr != null ? `${d.wr.toFixed(1)}%` : "—"}
                </span>
                <span class="stats-card__division-label">{d.label}</span>
              </div>
            ))}
          </div>
        ) : null}

        {/* KPI grid (battles/damage/exp/kd/survival/hitRate — no WR or PR,
            those are in the hero bar above) */}
        <div class="stats-card__kpis">
          {kpis.value.map((k) => (
            <div
              class={["stats-card__kpi", "stats-card__kpi--copyable"]}
              onClick={() => copy(String(k.value), t("common.copied"))}
              data-hint={`${k.label}: ${k.value} · ${t("common.clickToCopy")}`}
            >
              <span class="stats-card__kpi-label">{k.label}</span>
              <span class="stats-card__kpi-value">{k.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  },
});
