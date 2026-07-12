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
        label: t("stats.winrate"),
        value: props.stats.winrate != null ? `${props.stats.winrate.toFixed(1)}%` : "—",
        color: wrColor.value,
        big: true,
      },
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
      {
        label: "PR",
        value: props.stats.pr != null ? props.stats.pr.toLocaleString() : "—",
        color: pr.value.color,
      },
    ]);

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

        {/* PR summary bar */}
        <div class="stats-card__pr-bar" style={{ color: pr.value.color }}>
          <div class="stats-card__pr-num">
            {props.stats.pr != null ? props.stats.pr.toLocaleString() : "—"}
          </div>
          <div class="stats-card__pr-label">{pr.value.label}</div>
          <div class="stats-card__pr-meta">
            {props.stats.winrate != null
              ? `${props.stats.winrate.toFixed(1)}% WR`
              : "no WR data"}
          </div>
        </div>

        {/* KPI grid */}
        <div class="stats-card__kpis">
          {kpis.value.map((k) => (
            <div
              class={[
                "stats-card__kpi",
                k.big ? "stats-card__kpi--big" : "",
                "stats-card__kpi--copyable",
              ]}
              onClick={() => copy(String(k.value), t("common.copied"))}
              title={`${k.label}: ${k.value} (click to copy)`}
            >
              <span class="stats-card__kpi-label">{k.label}</span>
              <span
                class="stats-card__kpi-value"
                style={k.color ? { color: k.color } : undefined}
              >
                {k.value}
              </span>
            </div>
          ))}
        </div>

        {/* division split (only if any present) */}
        {divisions.value.some((d) => d.wr != null) ? (
          <div class="stats-card__divisions">
            {divisions.value.map((d) => (
              <div class="stats-card__division">
                <span class="stats-card__division-label">{d.label}</span>
                <span
                  class="stats-card__division-wr"
                  style={d.wr != null ? { color: winrateColor(d.wr) } : undefined}
                >
                  {d.wr != null ? `${d.wr.toFixed(1)}%` : "—"}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  },
});
