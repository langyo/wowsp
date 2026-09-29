/**
 * Ship-distribution charts: tier histogram (bar) + class pie, rendered with
 * ECharts as TWO independent chart instances (side by side on wide layouts,
 * stacked on narrow ones) so they never overlap. Shared by the replay
 * player-detail modal and the lookup screen.
 */
import { defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { t } from "@/i18n";
import { shipOfflineEntry } from "@/features/holographic/modelLoader";
import { useTheme } from "@/theme";
import {
  shipTypeChartColor,
  shipTypeColors,
  shipTypeCssColor,
} from "@/theme/shipTypeColors";
import "./ShipDistCharts.scss";

/** Localized short class label ("stats.dist.<type>"); falls back to the raw
 *  type key for unknown classes. Resolved at call time so a locale switch
 *  re-renders. */
function typeLabel(typeKey: string): string {
  const i18nKey = `stats.dist.${typeKey}`;
  const lbl = t(i18nKey);
  return lbl === i18nKey ? typeKey : lbl;
}

/** Legend row text "战列 43%" — ECharts hands the legend formatter only the
 *  slice NAME, so the value→percent mapping closes over the current data. */
function legendPercentFormatter(data: { name: string; value: number }[], total: number) {
  const byName = new Map(data.map((d) => [d.name, d.value]));
  return (name: string): string => {
    const v = byName.get(name) ?? 0;
    return `${name} ${Math.round((v / total) * 100)}%`;
  };
}

/** Theme-aware chart ink. ECharts paints on canvas, so it cannot follow CSS
 *  variables — resolve the text-channel triplet from the document element and
 *  derive rgba() strings. Called on every render(); the mode/theme watches
 *  below re-run render() so charts track light/dark and brand switches. */
function chartInk(): { label: string; soft: string; axis: string } {
  const parts = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-text")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const channels = parts.length === 3 ? parts.join(",") : "128,128,128";
  return {
    label: `rgba(${channels},0.75)`,
    soft: `rgba(${channels},0.6)`,
    axis: `rgba(${channels},0.15)`,
  };
}

export interface DistDatum {
  shipId: number;
  battles: number;
}

function aggregate(ships: DistDatum[]) {
  const tiers = new Array(11).fill(0);
  const types: Record<string, number> = {};
  let total = 0;
  for (const s of ships) {
    const off = shipOfflineEntry(s.shipId);
    const tier = off?.tier ?? 0;
    if (tier >= 1 && tier <= 10) tiers[tier] += s.battles;
    const t = (off?.type ?? "").toLowerCase();
    if (t) types[t] = (types[t] ?? 0) + s.battles;
    total += s.battles;
  }
  return { tiers, types, total };
}

export default defineComponent({
  name: "ShipDistCharts",
  props: {
    ships: { type: Array as () => DistDatum[], default: () => [] },
    /** Only render the tier histogram (compact mode). */
    tiersOnly: { type: Boolean, default: false },
  },
  setup(props) {
    const barEl = ref<HTMLElement | null>(null);
    const pieEl = ref<HTMLElement | null>(null);
    let barChart: echarts.ECharts | null = null;
    let pieChart: echarts.ECharts | null = null;
    let resizeObserver: ResizeObserver | null = null;

    function render() {
      const { tiers, types, total } = aggregate(props.ships);
      if (total === 0) return;
      const ink = chartInk();
      if (barEl.value && barChart) {
        // ALL ten tier bins always render — an unplayed tier stays an empty
        // gap on the axis instead of the neighbours stretching over it, and
        // the fixed pixel bar width keeps bars identical no matter how many
        // tiers carry battles. Zero bins hide only their top value label.
        const tierData = tiers.slice(1).map((n, i) => ({ tier: i + 1, value: n }));
        barChart.setOption(
          {
            animation: false,
            grid: { left: 8, right: 8, top: 22, bottom: 4, containLabel: true },
            tooltip: { trigger: "axis" },
            xAxis: {
              type: "category",
              data: tierData.map((d) => `${d.tier}`),
              axisLabel: { color: ink.soft, fontSize: 9 },
              axisLine: { lineStyle: { color: ink.axis } },
            },
            yAxis: { type: "value", show: false },
            series: [
              {
                name: t("stats.dist.battles"),
                type: "bar",
                barWidth: 12,
                data: tierData.map((d) => ({ value: d.value, label: { show: d.value > 0 } })),
                itemStyle: { borderRadius: [2, 2, 0, 0] },
                label: {
                  show: true,
                  position: "top",
                  fontSize: 9,
                  color: ink.label,
                },
              },
            ],
          },
          true,
        );
      }
      if (!props.tiersOnly && pieEl.value && pieChart) {
        // Per-slice colors keyed by the ship type itself (not data order):
        // each itemStyle resolves the fixed palette from
        // theme/shipTypeColors, so a class keeps its color across players,
        // filters and locale switches — and user edits repaint live via the
        // shipTypeColors watch below. Presentation follows the WG profile
        // page: no callout labels or leader lines, a scrollable legend
        // strip at the bottom carrying the per-slice percent, and the
        // donut lifted off center to make room for that legend.
        const typeData = Object.entries(types)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => ({
            name: typeLabel(k),
            value: v,
            itemStyle: { color: shipTypeCssColor(shipTypeChartColor(k)) },
          }));
        pieChart.setOption(
          {
            animation: false,
            tooltip: { trigger: "item" },
            legend: {
              type: "scroll",
              bottom: 0,
              left: "center",
              itemWidth: 8,
              itemHeight: 8,
              itemGap: 6,
              textStyle: { color: ink.label, fontSize: 9 },
              formatter: legendPercentFormatter(typeData, total),
            },
            series: [
              {
                name: t("stats.dist.shipType"),
                type: "pie",
                radius: ["34%", "60%"],
                center: ["50%", "42%"],
                label: { show: false },
                labelLine: { show: false },
                data: typeData,
              },
            ],
          },
          true,
        );
      }
    }

    onMounted(() => {
      if (barEl.value) {
        barChart = echarts.init(barEl.value);
      }
      if (!props.tiersOnly && pieEl.value) {
        pieChart = echarts.init(pieEl.value);
      }
      render();
      resizeObserver = new ResizeObserver(() => {
        barChart?.resize();
        pieChart?.resize();
      });
      if (barEl.value) resizeObserver.observe(barEl.value);
      if (pieEl.value) resizeObserver.observe(pieEl.value);
    });
    watch(() => props.ships, render, { deep: true });
    // Light/dark flips and brand-theme switches rewrite the CSS-variable ink
    // this component samples at render time — re-render so canvas text tracks
    // them (DOM text needs no help; it follows the vars directly). The
    // ship-type palette ref joins them so settings-picker edits repaint the
    // pie live (writers replace the whole record object, so plain watch
    // sources fire).
    const theme = useTheme();
    watch([theme.effectiveMode, theme.currentTheme, shipTypeColors], render);
    onBeforeUnmount(() => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      barChart?.dispose();
      pieChart?.dispose();
      barChart = null;
      pieChart = null;
    });

    return () => (
      <div class="ship-dist-charts">
        <div ref={barEl} class="ship-dist-charts__bar" style="height: 150px" />
        {!props.tiersOnly ? (
          <div class="ship-dist-charts__piewrap">
            <div class="ship-dist-charts__pie-title">{t("stats.dist.pieTitle")}</div>
            <div ref={pieEl} class="ship-dist-charts__pie" style="height: 150px" />
          </div>
        ) : null}
      </div>
    );
  },
});
