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
import "./ShipDistCharts.scss";

/** Localized short class label ("stats.dist.<type>"); falls back to the raw
 *  type key for unknown classes. Resolved at call time so a locale switch
 *  re-renders. */
function typeLabel(typeKey: string): string {
  const i18nKey = `stats.dist.${typeKey}`;
  const lbl = t(i18nKey);
  return lbl === i18nKey ? typeKey : lbl;
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
        const tierData = tiers
          .slice(1)
          .map((n, i) => ({ tier: i + 1, value: n }))
          .filter((d) => d.value > 0);
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
                barWidth: "55%",
                data: tierData.map((d) => d.value),
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
        const typeData = Object.entries(types)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => ({ name: typeLabel(k), value: v }));
        pieChart.setOption(
          {
            animation: false,
            color: ["#4ade80", "#ff6b6b", "#ffd93d", "#78d2ff", "#c084fc"],
            tooltip: { trigger: "item" },
            series: [
              {
                name: t("stats.dist.shipType"),
                type: "pie",
                radius: ["38%", "66%"],
                label: {
                  color: ink.label,
                  fontSize: 9,
                  formatter: "{b} {d}%",
                },
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
    // them (DOM text needs no help; it follows the vars directly).
    const theme = useTheme();
    watch([theme.effectiveMode, theme.currentTheme], render);
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
