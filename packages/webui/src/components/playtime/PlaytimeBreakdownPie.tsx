import { computed, defineComponent, type PropType } from "vue";

import type { BreakdownEntry } from "@/components/playtime/battleBreakdown";

/** Donut frame — the SVG's whole geometry derives from these (shared with
 *  the tests so they can never drift apart). */
export const DONUT = {
  /** SVG viewBox side; the ring centers at size/2, size/2. */
  size: 120,
  radius: 48,
  strokeWidth: 16,
  /** Hairline seam between adjacent slices, in stroke units. */
  pad: 1.5,
} as const;

/** 2πr — the full stroke's dash cycle (one circle turn). */
export const CIRCUMFERENCE = 2 * Math.PI * DONUT.radius;

export interface PieSliceGeom {
  /** `stroke-dasharray` of the slice's <circle> stroke. */
  dasharray: string;
  /** `stroke-dashoffset` of the slice's <circle> stroke. */
  dashoffset: number;
}

/** Trim float noise so the SVG attributes stay short and deterministic. */
function fmtN(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Dasharray/dashoffset for one donut slice: a stroke segment covering
 * [startC, startC + arcC) of the circle. Slices draw as <circle> strokes
 * (dasharray = arc, rest gap) over a rotate(-90) so arc position 0 sits at
 * 12 o'clock; the dashoffset shifts each slice's start pad/2 forward so
 * the seam lands centered on the slice boundary. Two degenerate shapes
 * special-case: a ring-filling slice AT THE PATH ORIGIN draws closed (the
 * seam pad would cut a hairline out of a lone 100% slice) and a sliver
 * thinner than the pad draws unpadded (the pad would collapse it to zero
 * length). The origin gate matters: a ~99.9% dominant slice that is NOT
 * first (tier sorts T1..T11, so a dominant mid bucket comes last) must
 * keep the padded path — the closed ring would paint over the tiny
 * slivers drawn before it. Pure — unit-tested.
 */
export function pieSliceGeom(
  arcC: number,
  startC: number,
  circumference: number,
  pad: number,
): PieSliceGeom {
  if (startC < 1e-9 && circumference - arcC < pad) {
    return { dasharray: `${fmtN(circumference)} 0`, dashoffset: 0 };
  }
  if (arcC <= pad) {
    return {
      dasharray: `${fmtN(arcC)} ${fmtN(circumference - arcC)}`,
      dashoffset: -fmtN(startC),
    };
  }
  return {
    dasharray: `${fmtN(arcC - pad)} ${fmtN(circumference - arcC + pad)}`,
    dashoffset: -fmtN(startC + pad / 2),
  };
}

/**
 * One breakdown donut card — the 游玩时间 view's per-group battle share
 * (ship type / nation / tier / mode) as a ring: slices in the entries'
 * order (count desc, the grouping fns' sort), colors via the view's
 * `colorOf` (battleBreakdown's per-group palettes), total + unit word in
 * the hole, and a count/share legend underneath. Pure props: grouping and
 * palettes live in battleBreakdown, this only draws.
 */
export default defineComponent({
  name: "PlaytimeBreakdownPie",
  props: {
    title: { type: String, required: true },
    entries: { type: Array as PropType<BreakdownEntry[]>, required: true },
    labelOf: { type: Function as PropType<(key: string) => string>, required: true },
    colorOf: { type: Function as PropType<(key: string) => string>, required: true },
    /** The unit word under the total (the localized "battles"). */
    centerLabel: { type: String, required: true },
  },
  setup(props) {
    const total = computed(() => props.entries.reduce((a, e) => a + e.count, 0));

    // Slice geometry per entry, in entry order; the accumulated arc start
    // rides the same shares the slices draw (sum ≈ the full turn).
    const slices = computed<PieSliceGeom[]>(() => {
      let accC = 0;
      return props.entries.map((e) => {
        const geom = pieSliceGeom(e.share * CIRCUMFERENCE, accC, CIRCUMFERENCE, DONUT.pad);
        accC += e.share * CIRCUMFERENCE;
        return geom;
      });
    });

    return () => {
      const cx = DONUT.size / 2;
      return (
        <div class="playtime-pie">
          <h4 class="playtime-pie__title">{props.title}</h4>
          <svg class="playtime-pie__svg" viewBox={`0 0 ${DONUT.size} ${DONUT.size}`}>
            {props.entries.map((e, i) => (
              <circle
                key={e.key}
                class="playtime-pie__slice"
                cx={cx}
                cy={cx}
                r={DONUT.radius}
                fill="none"
                stroke={props.colorOf(e.key)}
                stroke-width={DONUT.strokeWidth}
                stroke-linecap="butt"
                stroke-dasharray={slices.value[i].dasharray}
                stroke-dashoffset={slices.value[i].dashoffset}
                transform={`rotate(-90 ${cx} ${cx})`}
              >
                <title>{`${props.labelOf(e.key)} · ${e.count} · ${Math.round(e.share * 100)}%`}</title>
              </circle>
            ))}
            <text class="playtime-pie__total" x={cx} y="58">
              {total.value}
            </text>
            <text class="playtime-pie__unit" x={cx} y="74">
              {props.centerLabel}
            </text>
          </svg>
          <ul class="playtime-pie__legend">
            {props.entries.map((e) => (
              <li key={e.key} class="playtime-pie__row">
                <span
                  class="playtime-pie__dot"
                  style={{ background: props.colorOf(e.key) }}
                />
                <span class="playtime-pie__label">{props.labelOf(e.key)}</span>
                <span class="playtime-pie__count">{e.count}</span>
                <span class="playtime-pie__pct">{Math.round(e.share * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      );
    };
  },
});
