import { computed, defineComponent } from "vue";

import STag from "@/components/base/STag";
import type { PlayerStats } from "@/api";
import { t } from "@/i18n";
import { prTier, winrateColor, winrateTier } from "@/utils/winrate";
import { useClipboard } from "@/composables/useClipboard";
import "./StatsCard.scss";

/**
 * Deep-stats card modeled on ApeRadar's layout:
 *   ┌─ identity: name + clan tag + realm + hidden badge ─
 *   ├─ PR summary bar: big PR number + tier label, color-coded
 *   ├─ KPI grid: winrate / battles / avg damage / avg XP / K-D / survival
 *   └─ division split: solo / div2 / div3 winrates (when present)
 *
 * Color coding (mirrors community convention):
 *   red < 47% → yellow 47-50% → green 50-55% → purple > 55%.
 */
export default defineComponent({
  name: "StatsCard",
  props: {
    stats: { type: Object as () => PlayerStats, required: true },
  },
  setup(props) {
    const pr = computed(() => prTier(props.stats.pr));
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

    /** Division splits: solo / div2 / div3 winrates with their battle counts.
     *  Displayed in a compact row below the main winrate. */
    const divisions = computed(() => [
      { label: t("stats.solo"), wr: props.stats.soloWr },
      { label: t("stats.div2"), wr: props.stats.div2Wr },
      { label: t("stats.div3"), wr: props.stats.div3Wr },
    ]);

    return () => (
      <div class={["stats-card", `stats-card--${wrTier.value}`]}>
        {/* identity header */}
        <header class="stats-card__head">
          <div class="stats-card__name-line">
            {props.stats.clanTag ? (
              <span class="stats-card__clan">[{props.stats.clanTag}]</span>
            ) : null}
            <h3 class="stats-card__name">{props.stats.name}</h3>
          </div>
          <div class="stats-card__badges">
            <STag variant="neutral" size="sm">{props.stats.realm.toUpperCase()}</STag>
            {props.stats.hidden ? (
              <STag variant="danger" size="sm">{t("stats.hidden")}</STag>
            ) : null}
          </div>
        </header>

        {/* ── Main winrate + PR bar ──
            Big winrate on the left, PR on the right (same row).
            Below: total battles as small text.
            Below that: 3 division winrates in a compact centered row. */}
        <div class="stats-card__hero">
          <div class="stats-card__hero-main">
            <span
              class="stats-card__wr"
              style={wrColor.value ? { color: wrColor.value } : undefined}
              onClick={() => copy(String(props.stats.winrate?.toFixed(1) ?? "—"), t("common.copied"))}
              title={`${t("stats.winrate")} (click to copy)`}
            >
              {props.stats.winrate != null ? `${props.stats.winrate.toFixed(1)}%` : "—"}
            </span>
            <span class="stats-card__wr-label">{t("stats.winrate")}</span>
            <span
              class="stats-card__battles-total"
              onClick={() => copy(String(props.stats.battles ?? "—"), t("common.copied"))}
              title={`${t("stats.battles")} (click to copy)`}
            >
              {props.stats.battles != null ? `${props.stats.battles.toLocaleString()} ${t("stats.battles")}` : "—"}
            </span>
          </div>
          <div
            class="stats-card__pr-block"
            style={{ color: pr.value.color }}
            onClick={() => copy(String(props.stats.pr ?? "—"), t("common.copied"))}
            title={`PR: ${props.stats.pr ?? "—"} (${pr.value.label}) — click to copy`}
          >
            <span class="stats-card__pr-num">
              {props.stats.pr != null ? props.stats.pr.toLocaleString() : "—"}
            </span>
            <span class="stats-card__pr-label">{pr.value.label}</span>
          </div>
        </div>

        {/* Division splits: 3 columns centered (solo / div2 / div3) */}
        {divisions.value.some((d) => d.wr != null) ? (
          <div class="stats-card__divisions">
            {divisions.value.map((d) => (
              <div class="stats-card__division" key={d.label}>
                <span
                  class="stats-card__division-wr"
                  style={d.wr != null ? { color: winrateColor(d.wr) } : undefined}
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
              title={`${k.label}: ${k.value} (click to copy)`}
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
