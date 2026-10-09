/**
 * Ship-distribution charts: tier histogram (bar) + class donut + nation
 * donut, hand-drawn as declarative Vue-rendered SVG (no chart library).
 * Three blocks side by side on wide layouts, wrapped on narrow ones, so
 * they never overlap. Shared by the replay player-detail modal and the
 * lookup screen. The `forcedRow` prop opts a host out of the narrow
 * stacking: the three blocks stay on one row at ANY container width and
 * the row scrolls horizontally once the blocks hit their size floors.
 *
 * Everything is computed -> SVG: geometry comes from the PURE helpers
 * donutSlices() / tierBars() (unit-tested in ShipDistCharts.test.ts),
 * and ink (text, axis line, bar fill) is styled from SCSS through CSS
 * variables — light/dark and brand-theme flips need NO re-render logic,
 * the DOM restyles itself. Slice fills stay inline attributes because
 * they come from the reactive palettes, not theme variables; the
 * computeds below read those palettes (and t()), so locale switches and
 * palette edits repaint the SVG live with zero watches.
 */
import { computed, defineComponent, ref, watch, type Ref } from "vue";
import { Star } from "@lucide/vue";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import NationFlag from "@/components/base/NationFlag";
import {
  nationNameFromDb,
  shipOfflineEntry,
} from "@/features/holographic/modelLoader";
import { canonicalNation } from "@/utils/nationFlags";
import {
  shipTypeChartColor,
  shipTypeCssColor,
} from "@/theme/shipTypeColors";
import {
  chunkLegendItems,
  donutSlices,
  focusState,
  fmt,
  type DonutSlice,
} from "./donutGeometry";
import "./ShipDistCharts.scss";

// Re-exported for the existing test/back-compat surface: the pure geometry
// now lives in donutGeometry.ts (shared with PlaytimeBreakdownPie, which
// must not import this module — the modelLoader import above drags three.js
// into whichever chunk pulls it in).
export { chunkLegendItems, donutSlices, type DonutSlice } from "./donutGeometry";

/** Localized short class label ("stats.dist.<type>"); falls back to the raw
 *  type key for unknown classes. Resolved at call time inside a computed so
 *  a locale switch re-renders. */
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
 *  overflow continues in the next column to the right). A full 5-row
 *  column measures ≈ 104px (five ~15px 2xs lines + 4 × 0.45rem gaps) —
 *  matching the donut RING (68% outer radius on the 150px canvas ≈ 102px
 *  diameter), not the full canvas height: 6 ship types split 5+1 over two
 *  columns, 14 nations split 5+5+4 over three. */
const LEGEND_ROWS_PER_COLUMN = 5;

/** One DOM legend row, keyed by the RAW aggregation code — two nations can
 *  share a display name (and an equal rounded percent), so neither the
 *  text nor the flag is unique enough to key on. `text` is the bare
 *  localized name (or the NationFlag label): percents are NOT row text —
 *  they live only in `hint`, shown on hover, exactly the string the slice
 *  tooltip renders. */
interface LegendItem {
  code: string;
  color: string;
  text: string;
  hint: string;
}

/** Legend rows built FROM the donut slices — each row's hover hint is
 *  sliceHint(s), the exact string the slice tooltip renders, so the two
 *  views of one aggregation can never disagree. The share base is the SUM
 *  OF SHOWN SLICES, not aggregate.total: battles of ships with no type/
 *  nation entry never reach a slice. Independent integer rounding can
 *  still leave a whole legend summing to 99 or 101 (three equal thirds) —
 *  expected display rounding, not drift. */
export function toLegendItems(slices: readonly DonutSlice[]): LegendItem[] {
  return slices.map((s) => ({
    code: s.code,
    color: s.fill,
    text: s.label,
    hint: sliceHint(s),
  }));
}

/** Aggregation-record → battles-desc entries with zero-battle keys dropped:
 *  a zero slice is invisible in the donut and would paint a misleading
 *  "<name> 0%" legend row, so all-zero data renders blank charts with no
 *  legend rows. Shared by the donuts and the DOM legends so the two views
 *  of one aggregation can never drift apart. */
function positiveEntries(record: Record<string, number>): [string, number][] {
  return Object.entries(record)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
}

export interface DistDatum {
  shipId: number;
  battles: number;
}

/** Supership tier: WG's post-X tier. Its histogram slot swaps the axis
 *  numeral for the lucide Star mark — the same ★ convention the ship
 *  table, picker and tech-tree view already use for tier 11. */
const SUPERSHIP_TIER = 11;

/** Star glyph box in bar-viewBox units: the numerals' 10-unit optical box
 *  (baseline y=144, digits span ≈137–144), so the mark reads as one of
 *  the axis labels, not an ornament. `x`/`y` position the nested <svg>
 *  the icon renders; ink (stroke via currentColor, solid fill) lives in
 *  SCSS with the other theme-variable-styled chart ink. */
const TIER_STAR = { size: 10, dy: -8.5 };

function aggregate(ships: DistDatum[]) {
  // Bin 0 unused; bins 1..11 — tier 11 is the supership tier the offline
  // DB carries, so supership battles land in their own star-marked slot.
  const tiers = new Array(SUPERSHIP_TIER + 1).fill(0);
  const types: Record<string, number> = {};
  const nations: Record<string, number> = {};
  let total = 0;
  for (const s of ships) {
    const off = shipOfflineEntry(s.shipId);
    const tier = off?.tier ?? 0;
    if (tier >= 1 && tier <= SUPERSHIP_TIER) tiers[tier] += s.battles;
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

// ---------------------------------------------------------------------------
// Pure SVG geometry: the donut ring helpers (polar / ringSegment / fullRing
// / donutSlices) and the legend chunking live in donutGeometry.ts, shared
// with PlaytimeBreakdownPie. What stays here is the tier histogram's own
// geometry (tierBars). Angles are degrees in the screen coordinate system:
// -90 = 12 o'clock, increasing clockwise.
// ---------------------------------------------------------------------------

/** One tier slot: the bar's path ("" for an empty bin — no invisible
 *  hit-target sliver), its value-label anchor (null when there is no
 *  label to show), and the always-rendered tier number position. */
export interface TierBarSlot {
  tier: number;
  value: number;
  centerX: number;
  barWidth: number;
  barHeight: number;
  /** Empty string when the bin has no battles. */
  path: string;
  /** Text baseline above the bar top, null for zero bins. */
  labelY: number | null;
}

/** Static frame parts the template draws once (axis baseline spans the
 *  plot; tier numbers hang below every slot). */
export interface TierBarLayout {
  width: number;
  height: number;
  baselineY: number;
  axisFrom: number;
  axisTo: number;
  tierLabelY: number;
  bars: TierBarSlot[];
}

/** Tier histogram bins (index 0 = tier 1) → per-slot geometry. Equal
 *  slots across the plot (eleven with the supership bin), each bar
 *  centered in its slot (as the retired ECharts category axis did),
 *  height proportional to the bin's share of the maximum, top corners
 *  rounded rx≈2 only (ECharts borderRadius [2,2,0,0]). Pure and
 *  length-agnostic; the default 320×150 viewBox and the 12-unit bar
 *  width reproduce the old fixed-pixel look at 1:1. */
export function tierBars(
  tiers: readonly number[],
  opts: {
    width?: number;
    height?: number;
    barWidth?: number;
  } = {},
): TierBarLayout {
  const width = opts.width ?? 320;
  const height = opts.height ?? 150;
  // Grid mirrors the old ECharts option: left/right 8, top 22 (room for
  // the value label above the tallest bar), bottom reserved for the tier
  // numbers (baseline at height-18, number baseline 6 above the edge).
  // The top pad keeps the 10-unit label font inside the box: the tallest
  // bar's label baseline is y=17 and a 10-unit ascent ≈ 8 → glyph top 9.
  const sidePad = 8;
  const topPad = 22;
  const baselineY = height - 18;
  const tierLabelY = height - 6;
  const slotW = (width - 2 * sidePad) / Math.max(1, tiers.length);
  const barW = Math.min(opts.barWidth ?? 12, slotW);
  const max = tiers.reduce((a, v) => Math.max(a, v), 0);
  const plotH = baselineY - topPad;
  const bars = tiers.map((value, i) => {
    const centerX = fmt(sidePad + slotW * (i + 0.5));
    // `!(… > 0)` (not `<= 0`) so a NaN bin — which also poisons the max
    // reduce — renders an empty slot instead of NaN geometry.
    if (!(value > 0) || !(max > 0)) {
      return {
        tier: i + 1,
        value,
        centerX,
        barWidth: barW,
        barHeight: 0,
        path: "",
        labelY: null,
      };
    }
    const barHeight = (value / max) * plotH;
    const top = baselineY - barHeight;
    const x0 = centerX - barW / 2;
    const x1 = centerX + barW / 2;
    // Top-only corner rounding: up the left side, two quadratic corners
    // across the top, down the right side, straight close along the
    // baseline (rx clamped so a squat bar never inverts its corners).
    const rx = Math.min(2, barW / 2, barHeight / 2);
    const path = [
      `M ${fmt(x0)} ${fmt(baselineY)}`,
      `L ${fmt(x0)} ${fmt(top + rx)}`,
      `Q ${fmt(x0)} ${fmt(top)} ${fmt(x0 + rx)} ${fmt(top)}`,
      `L ${fmt(x1 - rx)} ${fmt(top)}`,
      `Q ${fmt(x1)} ${fmt(top)} ${fmt(x1)} ${fmt(top + rx)}`,
      `L ${fmt(x1)} ${fmt(baselineY)}`,
      "Z",
    ].join(" ");
    return {
      tier: i + 1,
      value,
      centerX,
      barWidth: barW,
      barHeight: fmt(barHeight),
      path,
      labelY: fmt(top - 5),
    };
  });
  return {
    width,
    height,
    baselineY,
    axisFrom: sidePad,
    axisTo: width - sidePad,
    tierLabelY,
    bars,
  };
}

// ViewBox constants shared by the template below (donuts are square).
const BAR_VIEWBOX = { width: 320, height: 150 };
const DONUT_VIEWBOX = 150;

// Tooltips ride the app-wide delegated hint hook
// (composables/globalTooltip.ts): data-hint on each slice/bar path gets
// the hikari-styled hover popup — viewport clamped, zero per-component
// wiring. (The hook also shows hints on keyboard focus, but these paths
// carry no tabindex, so in practice they are hover-only.) That hook's
// charter is to RETIRE native title tooltips app-wide, and every other
// webui surface already speaks data-hint, so plain SVG <title> would
// fight the app convention (the only in-repo <title>, RatingStamp,
// predates it). Slice hints render DonutSlice.percentInt, and the DOM
// legend rows reuse sliceHint itself as their own hint, so the two views
// of one aggregation can never disagree.
export function sliceHint(s: DonutSlice): string {
  return `${s.label} · ${t("stats.dist.battles")} ${s.value} · ${s.percentInt}%`;
}

function barHint(b: TierBarSlot): string {
  return `${t("ships.tier")} ${b.tier} · ${t("stats.dist.battles")} ${b.value}`;
}

export default defineComponent({
  name: "ShipDistCharts",
  props: {
    ships: { type: Array as () => DistDatum[], default: () => [] },
    /** Only render the tier histogram (compact mode). */
    tiersOnly: { type: Boolean, default: false },
    /** Keep all three blocks on ONE row regardless of container width:
     *  the row flexes down to the blocks' min-width floors, then the
     *  host grows a horizontal scrollbar instead of stacking vertically
     *  (the named-container collapse in ShipDistCharts.scss). Designed
     *  for the full three-block host — with tiersOnly only the
     *  histogram renders and it just fills the row. */
    forcedRow: { type: Boolean, default: false },
  },
  setup(props) {
    // One aggregation shared by the SVGs and the DOM legends, so the slice
    // data and the legend percents can never drift apart. Reactive in
    // props.ships (deep); the computeds below additionally track locale
    // (t) / data-language (nation DB) / the ship-type palette ref, so
    // locale switches and palette edits repaint everything live.
    const dist = computed(() => aggregate(props.ships));
    const tierLayout = computed(() => tierBars(dist.value.tiers.slice(1)));
    // Slice colors keyed by the aggregated code itself (not data order):
    // each fill resolves the palette from theme/shipTypeColors, so a class
    // keeps its color across players, filters and locale switches — and
    // scheme-editor palette edits repaint live (the lookup reads the
    // store ref against the effective mode, so dark/light switches do
    // too).
    const typeSlices = computed(() =>
      donutSlices(positiveEntries(dist.value.types), {
        labelOf: typeLabel,
        colorOf: (k) => shipTypeCssColor(shipTypeChartColor(k)),
      }),
    );
    // Nation composition — same donut shape, but a fixed component-local
    // palette (nations are not user-tintable).
    const nationSlices = computed(() =>
      donutSlices(positiveEntries(dist.value.nations), {
        labelOf: nationLabel,
        colorOf: (k) => NATION_COLORS[k] ?? NATION_COLORS.other!,
      }),
    );
    // Legend rows derive from the slices — each row's hover hint IS the
    // slice's hint string, so the two views of one aggregation can never
    // disagree. The rows themselves carry no percent text; percents show
    // only on hover.
    const typeLegend = computed(() => toLegendItems(typeSlices.value));
    const nationLegend = computed(() => toLegendItems(nationSlices.value));

    // Hover focus keys — one per block (tier histogram / type donut /
    // nation donut) so a highlight never leaks across blocks. A donut's
    // slice and its legend row share the block's ref: hovering EITHER
    // side lifts both and dims the rest of that block, tying the ring to
    // its legend. Purely presentational (classes in, classes out).
    const hoverTier = ref<number | null>(null);
    const hoverType = ref<string | null>(null);
    const hoverNation = ref<string | null>(null);
    // A hover key lives on a DOM element; when the data swaps under a held
    // pointer, the hovered element can unmount WITHOUT firing mouseleave
    // (browsers skip removed nodes) — a dead key would then dim the whole
    // block until the pointer deliberately re-entered it. Resetting on
    // every aggregation repaint costs nothing (a resting pointer only
    // ever clears nulls) and can never stick.
    watch(dist, () => {
      hoverTier.value = null;
      hoverType.value = null;
      hoverNation.value = null;
    });

    // DOM legend for a donut — rows stack vertically in columns of
    // LEGEND_ROWS_PER_COLUMN, extra columns continue to the right. Every
    // row leads with the slice-color dot: without it the flag rows give
    // no cue which ring slice a nation owns. After the dot ship types
    // render the localized name, nations the in-game faction flag
    // instead of a (truncation-prone) name — the flag speaks for the row
    // and its data-hint carries the full "name · battles · percent"
    // string, so the percent shows only on hover. Rows also drive the
    // block's hover focus (hovered = the block's ref): entering a row
    // lifts it AND its ring slice, dimming the rest of the block.
    const legendNode = (items: LegendItem[], flags: boolean, hovered: Ref<string | null>) => (
      <div class="ship-dist-charts__legend">
        {chunkLegendItems(items, LEGEND_ROWS_PER_COLUMN).map((column, ci) => (
          <div class="ship-dist-charts__legend-col" key={ci}>
            {column.map((it) => (
              <span
                class={{
                  "ship-dist-charts__legend-item": true,
                  ...focusState(hovered.value, it.code),
                }}
                key={it.code}
                data-hint={it.hint}
                onMouseenter={() => {
                  hovered.value = it.code;
                }}
                onMouseleave={() => {
                  hovered.value = null;
                }}
              >
                <span class="ship-dist-charts__legend-dot" style={{ background: it.color }} />
                {flags ? (
                  <NationFlag
                    nation={it.code}
                    label={it.text}
                    hint={it.hint}
                    variant="flag"
                    size="sm"
                  />
                ) : (
                  <span class="ship-dist-charts__legend-text">{it.text}</span>
                )}
              </span>
            ))}
          </div>
        ))}
      </div>
    );

    // One donut: dead-center ring, no in-canvas labels or legend (the
    // legend is DOM, see legendNode) — the WG-page presentation the old
    // ECharts pies kept. `hovered` is the block's focus ref so entering
    // a slice lifts it (brightness/saturation only, never a scale) and
    // dims its sibling slices.
    const donutNode = (slices: DonutSlice[], hovered: Ref<string | null>) => (
      <svg
        class="ship-dist-charts__pie"
        viewBox={`0 0 ${DONUT_VIEWBOX} ${DONUT_VIEWBOX}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {slices.map((s) => (
          <path
            key={s.code}
            class={{
              "ship-dist-charts__slice": true,
              ...focusState(hovered.value, s.code),
            }}
            d={s.path}
            fill={s.fill}
            data-hint={sliceHint(s)}
            onMouseenter={() => {
              hovered.value = s.code;
            }}
            onMouseleave={() => {
              hovered.value = null;
            }}
          />
        ))}
      </svg>
    );

    return () => {
      const layout = tierLayout.value;
      return (
        <div
          class={{
            "ship-dist-charts": true,
            "ship-dist-charts--forced-row": props.forcedRow,
          }}
        >
          {/* ALL eleven tier bins always render — an unplayed tier stays
              an empty gap on the axis instead of the neighbours
              stretching over it, and the fixed bar width keeps bars
              identical no matter how many tiers carry battles. Zero bins
              hide only their top value label (and their bar path). */}
          <svg
            class="ship-dist-charts__bar"
            viewBox={`0 0 ${BAR_VIEWBOX.width} ${BAR_VIEWBOX.height}`}
            preserveAspectRatio="xMidYMid meet"
          >
            <line
              class="ship-dist-charts__axis"
              x1={layout.axisFrom}
              y1={layout.baselineY}
              x2={layout.axisTo}
              y2={layout.baselineY}
            />
            {layout.bars.map((b) => (
              <g key={b.tier}>
                {b.path ? (
                  <path
                    class={{
                      "ship-dist-charts__bar-rect": true,
                      ...focusState(hoverTier.value, b.tier),
                    }}
                    d={b.path}
                    data-hint={barHint(b)}
                    onMouseenter={() => {
                      hoverTier.value = b.tier;
                    }}
                    onMouseleave={() => {
                      hoverTier.value = null;
                    }}
                  />
                ) : null}
                {b.labelY != null ? (
                  <text
                    class={{
                      "ship-dist-charts__bar-value": true,
                      "is-dim": hoverTier.value != null && hoverTier.value !== b.tier,
                    }}
                    x={b.centerX}
                    y={b.labelY}
                  >
                    {b.value}
                  </text>
                ) : null}
                {b.tier === SUPERSHIP_TIER ? (
                  // The supership slot's axis mark: the lucide Star as a
                  // nested <svg> positioned over the slot center — an
                  // icon component, never a text ★ glyph. The hover hint
                  // keeps the numeric tier, so the mark stays
                  // self-explanatory.
                  <Star
                    class="ship-dist-charts__tier-star"
                    size={TIER_STAR.size}
                    x={fmt(b.centerX - TIER_STAR.size / 2)}
                    y={layout.tierLabelY + TIER_STAR.dy}
                  />
                ) : (
                  <text class="ship-dist-charts__tier-num" x={b.centerX} y={layout.tierLabelY}>
                    {b.tier}
                  </text>
                )}
              </g>
            ))}
          </svg>
          {!props.tiersOnly ? (
            <div class="ship-dist-charts__piewrap">
              <div class="ship-dist-charts__pie-title">{t("stats.dist.pieTitle")}</div>
              <div class="ship-dist-charts__pie-body">
                {donutNode(typeSlices.value, hoverType)}
                {legendNode(typeLegend.value, false, hoverType)}
              </div>
            </div>
          ) : null}
          {!props.tiersOnly ? (
            <div class="ship-dist-charts__piewrap">
              <div class="ship-dist-charts__pie-title">{t("stats.dist.nationPieTitle")}</div>
              <div class="ship-dist-charts__pie-body">
                {donutNode(nationSlices.value, hoverNation)}
                {legendNode(nationLegend.value, true, hoverNation)}
              </div>
            </div>
          ) : null}
        </div>
      );
    };
  },
});
