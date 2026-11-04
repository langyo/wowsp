/**
 * Ship-distribution charts: tier histogram (bar) + class donut + nation
 * donut, hand-drawn as declarative Vue-rendered SVG (no chart library).
 * Three blocks side by side on wide layouts, wrapped on narrow ones, so
 * they never overlap. Shared by the replay player-detail modal and the
 * lookup screen. The `forcedRow` prop opts a host out of the narrow
 * stacking: the three blocks stay on one row at ANY container width and
 * the row scrolls horizontally once the blocks hit their size floors.
 *
 * The donuts render hikari's HkDonutChart and the tier histogram hikari's
 * HkBarChart — both dependency-free declarative SVG (no chart library),
 * so the computeds below only shape the DATA: donutSlices() for the rings
 * (unit-tested in ShipDistCharts.test.ts) and one bar entry per tier for
 * the histogram. Ink (text, gridlines, bar fill) is styled from the
 * components' own theme-token sheets — light/dark and brand-theme flips
 * need NO re-render logic, the DOM restyles itself. Slice fills stay
 * inline attributes because they come from the reactive palettes, not
 * theme variables; the computeds read those palettes (and t()), so locale
 * switches and palette edits repaint the charts live with zero watches.
 */
import { computed, defineComponent, ref, watch } from "vue";
import { Star } from "@lucide/vue";
import { HkBarChart, HkDonutChart, HkScrollContainer } from "@celestia-island/hikari";
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
import type { DonutSlice } from "./donutGeometry";
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
 *  numeral for the lucide Star mark (passed to hikari's HkBarChart as the
 *  bar's icon, which sizes/positions the nested <svg> itself) — the same
 *  ★ convention the ship table, picker and tech-tree view already use for
 *  tier 11. */
const SUPERSHIP_TIER = 11;

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
// The donut ring helpers (polar / ringSegment / fullRing / donutSlices)
// and the legend chunking live in donutGeometry.ts, shared with
// PlaytimeBreakdownPie; the tier histogram's geometry is hikari's own
// barChart.ts (HkBarChart's pure layout). Angles are degrees in the screen
// coordinate system: -90 = 12 o'clock, increasing clockwise.
// ---------------------------------------------------------------------------


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

function barHint(tier: number, value: number): string {
  return `${t("ships.tier")} ${tier} · ${t("stats.dist.battles")} ${value}`;
}

export default defineComponent({
  name: "ShipDistCharts",
  props: {
    ships: { type: Array as () => DistDatum[], default: () => [] },
    /** Only render the tier histogram (compact mode). */
    tiersOnly: { type: Boolean, default: false },
    /** Keep all three blocks on ONE row regardless of container width:
     *  the row flexes down to the blocks' min-width floors, then the
     *  host scrolls horizontally (hikari's HkScrollContainer overlay
     *  bar) instead of stacking vertically — the named-container
     *  collapse in ShipDistCharts.scss cannot reach the row, which
     *  lives inside the scroll viewport. Designed for the full
     *  three-block host — with tiersOnly only the histogram renders
     *  and it just fills the row. */
    forcedRow: { type: Boolean, default: false },
  },
  setup(props) {
    // One aggregation shared by the SVGs and the DOM legends, so the slice
    // data and the legend percents can never drift apart. Reactive in
    // props.ships (deep); the computeds below additionally track locale
    // (t) / data-language (nation DB) / the ship-type palette ref, so
    // locale switches and palette edits repaint everything live.
    const dist = computed(() => aggregate(props.ships));
    // Slice colors keyed by the aggregated code itself (not data order):
    // each fill resolves the palette from theme/shipTypeColors, so a class
    // keeps its color across players, filters and locale switches — and
    // scheme-editor palette edits repaint live (the lookup reads the
    // store ref against the effective mode, so dark/light switches do
    // too).
    // Same-source donuts: both blocks render hikari's HkDonutChart
    // (upstreamed from this component's own geometry), fed the aggregated
    // entries directly — colors keyed by the aggregated code itself (not
    // data order), so a class keeps its color across players, filters and
    // locale switches, and scheme-editor palette edits repaint live.
    const typeEntries = computed(() =>
      positiveEntries(dist.value.types).map(([code, value]) => ({
        key: code,
        label: typeLabel(code),
        value,
        color: shipTypeCssColor(shipTypeChartColor(code)),
      })),
    );
    // Nation composition — same donut shape, but a fixed component-local
    // palette (nations are not user-tintable). The legend rows render the
    // in-game faction flag through the component's legendIcon slot
    // (NationFlag's contract: the glyph rides the row's full hint).
    const nationEntries = computed(() =>
      positiveEntries(dist.value.nations).map(([code, value]) => ({
        key: code,
        label: nationLabel(code),
        value,
        color: NATION_COLORS[code] ?? NATION_COLORS.other!,
      })),
    );
    // Legend rows derive from the slices — each row's hover hint IS the
    // slice's hint string, so the two views of one aggregation can never
    // disagree. The rows themselves carry no percent text; percents show
    // only on hover.
    // The tier histogram keeps its own hover focus (its value labels
    // dim with it); the donut blocks' focus lives inside HkDonutChart
    // now. The stale-hover reset below survives for the tier keys: a
    // hover key lives on a DOM element, and when the data swaps under a
    // held pointer the element can unmount WITHOUT firing mouseleave.
    const hoverTier = ref<number | null>(null);
    watch(dist, () => {
      hoverTier.value = null;
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
    // One donut block: hikari's HkDonutChart owns the ring, the chunked
    // legend and the paired hover focus. `flags` swaps the legend rows'
    // text labels for the nation flags via the legendIcon slot; hints
    // stay the exported sliceHint string, so the two views of one
    // aggregation can never disagree.
    const donutBlock = (
      entries: { key: string; label: string; value: number; color: string }[],
      flags: boolean,
    ) => (
      <HkDonutChart
        entries={entries}
        size={DONUT_VIEWBOX}
        legendRows={LEGEND_ROWS_PER_COLUMN}
        hintOf={(sl) => sliceHint(sl as unknown as DonutSlice)}
        v-slots={{
          legendIcon: flags
            ? (sl: { key: string; label: string }) => (
                <NationFlag
                  nation={sl.key}
                  label={sl.label}
                  hint={sliceHint(sl as never)}
                  variant="flag"
                  size="sm"
                />
              )
            : undefined,
        }}
      />
    );

    return () => {
      // The three chart blocks, shared by both hosts below (only the
      // forcedRow prop changes who owns the row: a plain wrapped row, or
      // the one-row scroll region).
      const blocks = (
        <>
          {/* ALL eleven tier bins always render — an unplayed tier stays
              an empty gap on the axis instead of the neighbours
              stretching over it: HkBarChart keeps zero-value slots on
              the axis (label only, no bar path). showValues restores
              the above-bar battle counts (empty slots carry none — the
              old labelY-null behavior); the supership slot's axis mark
              is the lucide Star passed as the bar's icon — an icon
              component, never a text ★ glyph; the hover hint keeps the
              numeric tier so the mark stays self-explanatory. The
              hover event + activeIndex recreate the hot/dim pair
              through hikari's own data-hot/data-dim classes. */}
          <HkBarChart
            bars={dist.value.tiers.slice(1).map((battles, index) => ({
              label: String(index + 1),
              value: battles,
              hint: barHint(index + 1, battles),
              icon: index + 1 === SUPERSHIP_TIER ? Star : undefined,
            }))}
            width={BAR_VIEWBOX.width}
            height={BAR_VIEWBOX.height}
            showValues
            activeIndex={hoverTier.value == null ? null : hoverTier.value - 1}
            onHover={(index: number | null) => {
              hoverTier.value = index == null ? null : index + 1;
            }}
            formatValue={(v: number) => String(Math.round(v))}
          />

          {!props.tiersOnly ? (
            <div class="ship-dist-charts__piewrap">
              <div class="ship-dist-charts__pie-title">{t("stats.dist.pieTitle")}</div>
              <div class="ship-dist-charts__pie-body">
                {donutBlock(typeEntries.value, false)}
              </div>
            </div>
          ) : null}
          {!props.tiersOnly ? (
            <div class="ship-dist-charts__piewrap">
              <div class="ship-dist-charts__pie-title">{t("stats.dist.nationPieTitle")}</div>
              <div class="ship-dist-charts__pie-body">
                {donutBlock(nationEntries.value, true)}
              </div>
            </div>
          ) : null}
        </>
      );
      // Forced one-row hosts swap the wrapping div for hikari's horizontal
      // scroll container (auto-hiding overlay bar below the row); the row
      // rhythm lives on __row inside the viewport. The wrapped default
      // below stays a plain div — the named-container collapse query in
      // ShipDistCharts.scss keeps targeting it untouched.
      if (props.forcedRow) {
        return (
          <HkScrollContainer class="ship-dist-charts ship-dist-charts--forced-row" axis="horizontal">
            <div class="ship-dist-charts__row">{blocks}</div>
          </HkScrollContainer>
        );
      }
      return <div class="ship-dist-charts">{blocks}</div>;
    };
  },
});
