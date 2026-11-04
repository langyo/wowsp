import { computed, defineComponent, type PropType } from "vue";
import { HkTrendChart, useBreakpoint } from "@celestia-island/hikari";

import { prTier, prTierLabel } from "@/utils/winrate";
import { PR_TREND_GUIDES, type PrTrendPoint } from "./prTrend";
import "./PrTrendChart.scss";

/** Phone frame width — the default 640-unit viewBox scaled into a ~369px
 *  column renders the 10px axis numbers and x ticks at ~5.5px, past
 *  legibility. 420 keeps them ≥ ~8.8px effective while the tier-name
 *  labels and the five x ticks still clear each other (plot width 288).
 *  hikari's isMobile (<768) matches the SCSS phone blocks exactly. */
const PR_TREND_PHONE_FRAME_WIDTH = 420;

/** A mid/ceiling axis number whose gridline sits within this many viewBox
 *  px of a tier guide's line is dropped (the tier name carries more
 *  meaning, and both share the left edge) — the retired hand-drawn SVG's
 *  PR_TREND_AXIS_TIER_CLEARANCE role, now fed to hikari's
 *  yAxisClearancePx. */
const PR_TREND_AXIS_CLEARANCE_PX = 9;

/** The stepped y extent (the retired prTrendLayout rule): the span pads UP
 *  to a 250 multiple, never shows narrower than 500, and anchors the floor
 *  at 0 so the community scale reads from the bottom. */
const PR_TREND_Y_DOMAIN = { padToMultiple: 250, minSpan: 500, floorAtZero: true };

/**
 * The PR trend line chart — one vertex per history interval, drawn by
 * hikari's dependency-free HkTrendChart (the wowsp-migration extension
 * hikari#1060 grew exactly for this chart). Faint dashed tier guides sit
 * at the PR tier thresholds inside the plotted domain, each named in its
 * tier color by the band that starts there (wording per the
 * localized-tiers pref; hikari escapes every consumer string); each dot
 * is inked with its prTier color and carries the hover hint through the
 * app-wide data-hint hook; the stepped domain keeps a flat line readable.
 *
 * The x axis stays linear in time over the plotted series' own span (the
 * old prTrendLayout domain): the rolling window ends at the newest sample
 * and starts at the oldest, so the line spans the full plot; a lone point
 * pads a day on either side so it centers as the old layout centered it.
 * The caller keeps owning locale (fmtTick takes unix seconds — the
 * same contract PrTrendSection and its test stub have always used).
 */
export default defineComponent({
  name: "PrTrendChart",
  props: {
    points: { type: Array as () => PrTrendPoint[], required: true },
    /** X tick label, unix SECONDS in (the caller owns locale). */
    fmtTick: { type: Function as PropType<(t: number) => string>, required: true },
    /** A vertex's hover hint text. */
    hintOf: { type: Function as PropType<(p: PrTrendPoint) => string>, required: true },
  },
  setup(props) {
    const { isMobile } = useBreakpoint();

    // One pen: every vertex inks its own dot (prTier color) and carries
    // its hover hint. (hikari renders no pen label into the markup; the
    // name only feeds the component's series plumbing.)
    const pens = computed(() => [
      {
        label: "pr",
        data: props.points.map((p) => ({
          time: p.t * 1000,
          value: p.pr,
          fill: prTier(p.pr).color,
          hint: props.hintOf(p),
        })),
      },
    ]);

    // The plotted time window: exactly the series' own span (points are
    // timestamp-sorted — prTrendIntervals guarantees it). A lone point has
    // a zero span, which would park it on the plot's left edge; a day of
    // padding on both sides centers it as the old layout did.
    const nowMs = computed(() => {
      const pts = props.points;
      if (pts.length === 0) return undefined;
      return pts[pts.length - 1]!.t * 1000 + (pts.length === 1 ? 86_400_000 : 0);
    });
    const windowMs = computed(() => {
      const pts = props.points;
      if (pts.length === 0) return 0;
      return (pts[pts.length - 1]!.t - pts[0]!.t) * 1000 + (pts.length === 1 ? 2 * 86_400_000 : 0);
    });

    // The named tier guides: one dashed line per threshold inside the
    // shown domain (hikari clips the rest), named by the band that STARTS
    // there in that band's own ink — the wording follows the
    // localized-tiers pref through prTierLabel. The value rides data-hint
    // like the old gutter carried it. Dash "3 4" keeps the retired
    // .pr-trend__guide rhythm (hikari's default "6 4" is the alarm
    // flavor, not this chart's).
    const guides = computed(() =>
      PR_TREND_GUIDES.map((g) => ({
        value: g,
        label: prTierLabel(prTier(g).key),
        color: prTier(g).color,
        dash: "3 4",
        hint: String(g),
      })),
    );

    return () => (
      <HkTrendChart
        class="pr-trend"
        pens={pens.value}
        height="220px"
        width={isMobile.value ? PR_TREND_PHONE_FRAME_WIDTH : 640}
        preserveAspectRatio="xMidYMid meet"
        now={nowMs.value}
        timeWindowMs={windowMs.value}
        guides={guides.value}
        yAxisFormat={(v: number) => String(Math.round(v))}
        yAxisClearancePx={PR_TREND_AXIS_CLEARANCE_PX}
        yDomain={PR_TREND_Y_DOMAIN}
        xTickCount={5}
        xTickFormat={(tMs: number) => props.fmtTick(Math.round(tMs / 1000))}
      />
    );
  },
});
