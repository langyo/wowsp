/**
 * Ship-distribution charts: tier histogram (bar) + class pie, rendered with
 * ECharts as TWO independent chart instances (side by side on wide layouts,
 * stacked on narrow ones) so they never overlap. Shared by the replay
 * player-detail modal and the lookup screen.
 */
import { defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { shipOfflineEntry } from "@/features/holographic/modelLoader";
import "./ShipDistCharts.scss";

const TYPE_LABELS: Record<string, string> = {
  battleship: "战列",
  aircarrier: "航母",
  cruiser: "巡洋",
  destroyer: "驱逐",
  submarine: "潜艇",
};

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

    function render() {
      const { tiers, types, total } = aggregate(props.ships);
      if (total === 0) return;
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
              axisLabel: { color: "rgba(255,255,255,0.6)", fontSize: 9 },
              axisLine: { lineStyle: { color: "rgba(255,255,255,0.15)" } },
            },
            yAxis: { type: "value", show: false },
            series: [
              {
                name: "场次",
                type: "bar",
                barWidth: "55%",
                data: tierData.map((d) => d.value),
                itemStyle: { borderRadius: [2, 2, 0, 0] },
                label: {
                  show: true,
                  position: "top",
                  fontSize: 9,
                  color: "rgba(255,255,255,0.75)",
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
          .map(([k, v]) => ({ name: TYPE_LABELS[k] ?? k, value: v }));
        pieChart.setOption(
          {
            animation: false,
            color: ["#4ade80", "#ff6b6b", "#ffd93d", "#78d2ff", "#c084fc"],
            tooltip: { trigger: "item" },
            series: [
              {
                name: "舰种",
                type: "pie",
                radius: ["38%", "66%"],
                label: {
                  color: "rgba(255,255,255,0.75)",
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
      const ro = new ResizeObserver(() => {
        barChart?.resize();
        pieChart?.resize();
      });
      if (barEl.value) ro.observe(barEl.value);
      if (pieEl.value) ro.observe(pieEl.value);
    });
    watch(() => props.ships, render, { deep: true });
    onBeforeUnmount(() => {
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
            <div class="ship-dist-charts__pie-title">舰种构成</div>
            <div ref={pieEl} class="ship-dist-charts__pie" style="height: 150px" />
          </div>
        ) : null}
      </div>
    );
  },
});
