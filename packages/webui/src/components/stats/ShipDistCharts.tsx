/**
 * Ship-distribution charts: tier histogram (bar) + class pie + nation pie,
 * rendered with ECharts as THREE independent chart instances (side by side
 * on wide layouts, wrapped on narrow ones) so they never overlap. Shared by
 * the replay player-detail modal and the lookup screen.
 */
import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import {
  nationNameFromDb,
  shipOfflineEntry,
} from "@/features/holographic/modelLoader";
import { canonicalNation } from "@/utils/nationFlags";
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

/** Localized nation label — the app-wide chain (素材翻译 DB first, then
 *  ships.nation.<code>, then the raw code). The aggregated "other" bucket
 *  (event/rental ships with no canonical nation) has its own stats key. */
function nationLabel(code: string): string {
  if (code === "other") return t("stats.dist.other");
  const db = nationNameFromDb(code, useLanguage().dataLanguage.value);
  if (db) return db;
  const i18nKey = `ships.nation.${code}`;
  const lbl = t(i18nKey);
  return lbl === i18nKey ? code : lbl;
}

/** Fixed nation slice colors for the nation donut — component-local and
 *  deliberately NOT user-editable (only ship types carry that setting). */
const NATION_COLORS: Record<string, string> = {
  japan: "rgb(224, 82, 99)", // #e05263
  usa: "rgb(78, 143, 217)", // #4e8fd9
  ussr: "rgb(224, 138, 60)", // #e08a3c
  germany: "rgb(143, 163, 176)", // #8fa3b0
  uk: "rgb(125, 120, 217)", // #7d78d9
  france: "rgb(91, 200, 220)", // #5bc8dc
  pan_asia: "rgb(227, 200, 78)", // #e3c84e
  italy: "rgb(109, 193, 120)", // #6dc178
  netherlands: "rgb(217, 127, 176)", // #d97fb0
  commonwealth: "rgb(154, 134, 201)", // #9a86c9
  pan_america: "rgb(102, 194, 165)", // #66c2a5
  spain: "rgb(184, 151, 90)", // #b8975a
  europe: "rgb(147, 183, 224)", // #93b7e0
  other: "rgb(148, 163, 184)", // #94a3b8
};

/** Rows per legend column (WG-site style: items stack top-to-bottom, then
 *  overflow continues in the next column to the right). 5 rows make a full
 *  column visually match the 150px donut height: 6 ship types split 5+1
 *  over two columns, 14 nations split 5+5+4 over three. */
const LEGEND_ROWS_PER_COLUMN = 5;

/** Split items into fixed-height columns: each column holds up to `size`
 *  items (filled top-to-bottom in input order), overflow continues in the
 *  next column to the right. Pure and order-preserving, so the column
 *  layout is fully deterministic. */
export function chunkLegendItems<T>(items: readonly T[], size: number): T[][] {
  const rows = Math.max(1, Math.floor(size));
  const columns: T[][] = [];
  for (let i = 0; i < items.length; i += rows) {
    columns.push(items.slice(i, i + rows));
  }
  return columns;
}

/** One DOM legend row: colored dot + "<localized name> <integer>%". The
 *  percentage base is the SUM OF SHOWN SLICES, not aggregate.total: battles
 *  of ships with no type/nation entry never reach a slice, and the donut
 *  tooltip's own {d}% divides by the shown sum — this way the legend
 *  percents always add up to 100 like the tooltips. */
interface LegendItem {
  color: string;
  text: string;
}

function toLegendItems(
  entries: [string, number][],
  colorOf: (key: string) => string,
  labelOf: (key: string) => string,
): LegendItem[] {
  const shown = entries.reduce((a, [, v]) => a + v, 0);
  return entries.map(([k, v]) => ({
    color: colorOf(k),
    text: `${labelOf(k)} ${shown > 0 ? Math.round((v / shown) * 100) : 0}%`,
  }));
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
  const nations: Record<string, number> = {};
  let total = 0;
  for (const s of ships) {
    const off = shipOfflineEntry(s.shipId);
    const tier = off?.tier ?? 0;
    if (tier >= 1 && tier <= 10) tiers[tier] += s.battles;
    const t = (off?.type ?? "").toLowerCase();
    if (t) types[t] = (types[t] ?? 0) + s.battles;
    // Canonical nation code (uk/ussr/europe …); event/rental ships and
    // unknown codes carry none and fall into the "other" bucket.
    const n = canonicalNation(off?.nation ?? "");
    const nk = n || "other";
    nations[nk] = (nations[nk] ?? 0) + s.battles;
    total += s.battles;
  }
  return { tiers, types, nations, total };
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
    const nationEl = ref<HTMLElement | null>(null);
    let barChart: echarts.ECharts | null = null;
    let pieChart: echarts.ECharts | null = null;
    let nationChart: echarts.ECharts | null = null;
    let resizeObserver: ResizeObserver | null = null;

    // One aggregation shared by the canvases and the DOM legends, so the
    // slice data and the legend percents can never drift apart. Reactive in
    // props.ships (deep), and the legend computeds below additionally track
    // locale (t) / data-language (nation DB) / the ship-type palette ref.
    const dist = computed(() => aggregate(props.ships));
    const typeLegend = computed(() =>
      toLegendItems(
        Object.entries(dist.value.types).sort((a, b) => b[1] - a[1]),
        (k) => shipTypeCssColor(shipTypeChartColor(k)),
        typeLabel,
      ),
    );
    const nationLegend = computed(() =>
      toLegendItems(
        Object.entries(dist.value.nations).sort((a, b) => b[1] - a[1]),
        (k) => NATION_COLORS[k] ?? NATION_COLORS.other!,
        nationLabel,
      ),
    );

    function render() {
      const { tiers, types, nations, total } = dist.value;
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
      // Donut option factory — both pies (class + nation) share the WG-page
      // presentation: no callout labels or leader lines, the donut dead
      // center, and NO in-canvas legend — the legend is DOM (see the JSX
      // below) so it can lay out as dot+text columns beside the donut.
      const donutOption = (data: { name: string; value: number; itemStyle: { color: string } }[], seriesName: string) => ({
        animation: false,
        tooltip: { trigger: "item" },
        series: [
          {
            name: seriesName,
            type: "pie",
            radius: ["40%", "68%"],
            center: ["50%", "50%"],
            label: { show: false },
            labelLine: { show: false },
            data,
          },
        ],
      });
      if (!props.tiersOnly && pieEl.value && pieChart) {
        // Per-slice colors keyed by the ship type itself (not data order):
        // each itemStyle resolves the fixed palette from
        // theme/shipTypeColors, so a class keeps its color across players,
        // filters and locale switches — and user edits repaint live via the
        // shipTypeColors watch below.
        const typeData = Object.entries(types)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => ({
            name: typeLabel(k),
            value: v,
            itemStyle: { color: shipTypeCssColor(shipTypeChartColor(k)) },
          }));
        pieChart.setOption(donutOption(typeData, t("stats.dist.shipType")), true);
      }
      if (!props.tiersOnly && nationEl.value && nationChart) {
        // Nation composition — same donut shape, but a fixed component-local
        // palette (nations are not user-tintable).
        const nationData = Object.entries(nations)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => ({
            name: nationLabel(k),
            value: v,
            itemStyle: { color: NATION_COLORS[k] ?? NATION_COLORS.other! },
          }));
        nationChart.setOption(donutOption(nationData, t("stats.dist.nationPieTitle")), true);
      }
    }

    onMounted(() => {
      if (barEl.value) {
        barChart = echarts.init(barEl.value);
      }
      if (!props.tiersOnly && pieEl.value) {
        pieChart = echarts.init(pieEl.value);
      }
      if (!props.tiersOnly && nationEl.value) {
        nationChart = echarts.init(nationEl.value);
      }
      render();
      resizeObserver = new ResizeObserver(() => {
        barChart?.resize();
        pieChart?.resize();
        nationChart?.resize();
      });
      if (barEl.value) resizeObserver.observe(barEl.value);
      if (pieEl.value) resizeObserver.observe(pieEl.value);
      if (nationEl.value) resizeObserver.observe(nationEl.value);
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
      nationChart?.dispose();
      barChart = null;
      pieChart = null;
      nationChart = null;
    });

    // DOM legend for a donut — WG-site style: each row is a small colored
    // dot followed by "<name> <percent>", rows stack vertically in columns
    // of LEGEND_ROWS_PER_COLUMN, extra columns continue to the right.
    // Rendered beside the canvas inside __pie-body (tiersOnly compact mode
    // never reaches here — the whole piewrap block is gated).
    const legendNode = (items: LegendItem[]) => (
      <div class="ship-dist-charts__legend">
        {chunkLegendItems(items, LEGEND_ROWS_PER_COLUMN).map((column, ci) => (
          <div class="ship-dist-charts__legend-col" key={ci}>
            {column.map((it) => (
              <span class="ship-dist-charts__legend-item" key={it.text}>
                <span class="ship-dist-charts__legend-dot" style={{ background: it.color }} />
                <span class="ship-dist-charts__legend-text">{it.text}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    );

    return () => (
      <div class="ship-dist-charts">
        <div ref={barEl} class="ship-dist-charts__bar" style="height: 150px" />
        {!props.tiersOnly ? (
          <div class="ship-dist-charts__piewrap">
            <div class="ship-dist-charts__pie-title">{t("stats.dist.pieTitle")}</div>
            <div class="ship-dist-charts__pie-body">
              <div ref={pieEl} class="ship-dist-charts__pie" style="height: 150px" />
              {legendNode(typeLegend.value)}
            </div>
          </div>
        ) : null}
        {!props.tiersOnly ? (
          <div class="ship-dist-charts__piewrap">
            <div class="ship-dist-charts__pie-title">{t("stats.dist.nationPieTitle")}</div>
            <div class="ship-dist-charts__pie-body">
              <div ref={nationEl} class="ship-dist-charts__pie" style="height: 150px" />
              {legendNode(nationLegend.value)}
            </div>
          </div>
        ) : null}
      </div>
    );
  },
});
