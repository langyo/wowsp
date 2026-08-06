/**
 * Ship-distribution charts: tier histogram (bar) + class pie, rendered with
 * ECharts. Shared by the replay player-detail modal and the lookup screen.
 */
import { defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { shipOfflineEntry } from "@/features/holographic/modelLoader";

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

export default defineComponent({
  name: "ShipDistCharts",
  props: {
    ships: { type: Array as () => DistDatum[], default: () => [] },
    /** Only render the tier histogram (compact mode). */
    tiersOnly: { type: Boolean, default: false },
  },
  setup(props) {
    const el = ref<HTMLElement | null>(null);
    let chart: echarts.ECharts | null = null;

    function render() {
      if (!el.value || !chart) return;
      const tiers = new Array(11).fill(0);
      const types: Record<string, number> = {};
      let total = 0;
      for (const s of props.ships) {
        const off = shipOfflineEntry(s.shipId);
        const tier = off?.tier ?? 0;
        if (tier >= 1 && tier <= 10) tiers[tier] += s.battles;
        const t = (off?.type ?? "").toLowerCase();
        if (t) types[t] = (types[t] ?? 0) + s.battles;
        total += s.battles;
      }
      if (total === 0) return;
      const tierData = tiers
        .slice(1)
        .map((n, i) => ({ tier: i + 1, value: n }))
        .filter((d) => d.value > 0);
      const typeData = Object.entries(types)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => ({ name: TYPE_LABELS[k] ?? k, value: v }));
      const options: echarts.EChartsOption = {
        animation: false,
        color: ["#4ade80", "#ff6b6b", "#ffd93d", "#78d2ff", "#c084fc"],
        grid: { left: 8, right: 8, top: 18, bottom: 4, containLabel: true },
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "category",
          data: tierData.map((d) => `${d.tier}`),
          axisLabel: { color: "rgba(255,255,255,0.6)", fontSize: 9 },
          axisLine: { lineStyle: { color: "rgba(255,255,255,0.15)" } },
        },
        yAxis: {
          type: "value",
          show: false,
        },
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
      };
      if (!props.tiersOnly) {
        options.series = [
          options.series![0],
          {
            name: "舰种",
            type: "pie",
            radius: ["35%", "62%"],
            center: ["72%", "52%"],
            label: {
              color: "rgba(255,255,255,0.75)",
              fontSize: 9,
              formatter: "{b} {d}%",
            },
            data: typeData,
          },
        ];
      }
      chart.setOption(options, true);
    }

    onMounted(() => {
      if (!el.value) return;
      chart = echarts.init(el.value);
      render();
      const ro = new ResizeObserver(() => chart?.resize());
      ro.observe(el.value);
    });
    watch(() => props.ships, render, { deep: true });
    onBeforeUnmount(() => {
      chart?.dispose();
      chart = null;
    });

    return () => (
      <div
        ref={el}
        class="ship-dist-charts"
        style={{ height: props.tiersOnly ? "90px" : "150px", width: "100%" }}
      />
    );
  },
});
