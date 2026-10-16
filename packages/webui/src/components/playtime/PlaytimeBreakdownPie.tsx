import { computed, defineComponent, ref, watch, type PropType } from "vue";

import type { BreakdownEntry } from "@/components/playtime/battleBreakdown";
import {
  chunkLegendItems,
  donutSlices,
  focusState,
  type DonutSlice,
} from "@/components/stats/donutGeometry";

/** Rows per legend column — the stats donuts' (ShipDistCharts) constant,
 *  so both donut families chunk their legends identically. */
const LEGEND_ROWS_PER_COLUMN = 5;

/**
 * One breakdown donut — the 游玩时间 view's per-group battle share (ship
 * type / nation / tier / mode) drawn EXACTLY like the water-meter page's
 * distribution donuts (ShipDistCharts): the same shared ring geometry
 * (donutGeometry: path segments, radius 40%–68% of the 150 square, 12
 * o'clock start, clockwise), the same DOM legend (dot + label rows that
 * stack in 5-row columns, percents ONLY on hover) and the same hover
 * focus (hovering a slice or its legend row lifts the pair and dims the
 * block's siblings). Differences from the stats original are placement
 * only: four blocks share one row here, so the legend sits UNDER the ring
 * instead of beside it, and the ring carries no center text — the battles
 * card already counts the total.
 *
 * Hints ride the app-wide delegated tooltip (data-hint), never native
 * <title> — the same convention ShipDistCharts' comment documents. Pure
 * props: grouping and palettes live in battleBreakdown / the view; this
 * component only draws.
 */
export default defineComponent({
  name: "PlaytimeBreakdownPie",
  props: {
    title: { type: String, required: true },
    entries: { type: Array as PropType<BreakdownEntry[]>, required: true },
    labelOf: { type: Function as PropType<(key: string) => string>, required: true },
    colorOf: { type: Function as PropType<(key: string) => string>, required: true },
    /** The localized unit word in hover hints ("场" — battles). */
    unitLabel: { type: String, required: true },
  },
  setup(props) {
    // The ring's slices — same shape/share math as the stats donuts, so
    // the legend rows and the slice hints below can never disagree.
    const slices = computed<DonutSlice[]>(() =>
      donutSlices(
        props.entries.map((e) => [e.key, e.count] as const),
        { labelOf: props.labelOf, colorOf: props.colorOf },
      ),
    );

    /** Hover hint — the exact string the slice and its legend row both
     *  render (ShipDistCharts' sliceHint contract, with this view's unit
     *  word): "label · 24 场 · 17%". Word order deliberately inverts the
     *  stats page's "场次 24" (unit then value) to "24 场" (value then
     *  unit) — this view's unit word is a measure word ("场"), which reads
     *  naturally after the number in every locale. */
    function hintOf(s: DonutSlice): string {
      return `${s.label} · ${s.value} ${props.unitLabel} · ${s.percentInt}%`;
    }

    // The block's hover key: a slice and its legend row share it, so
    // hovering either side lifts the pair and dims the rest of the block.
    const hovered = ref<string | null>(null);
    // A hover key lives on a DOM element; when the data swaps under a held
    // pointer (scope change, refetch), the element can unmount WITHOUT
    // firing mouseleave — a dead key would dim the whole block until the
    // pointer re-entered. Resetting on every entries repaint costs nothing
    // (ShipDistCharts' data-swap reset, same rationale).
    watch(slices, () => {
      hovered.value = null;
    });

    return () => (
      <div class="playtime-pie">
        <div class="playtime-pie__title">{props.title}</div>
        <svg
          class="playtime-pie__ring"
          viewBox="0 0 150 150"
          preserveAspectRatio="xMidYMid meet"
        >
          {slices.value.map((s) => (
            <path
              key={s.code}
              class={{
                "playtime-pie__slice": true,
                ...focusState(hovered.value, s.code),
              }}
              d={s.path}
              fill={s.fill}
              data-hint={hintOf(s)}
              onMouseenter={() => {
                hovered.value = s.code;
              }}
              onMouseleave={() => {
                hovered.value = null;
              }}
            />
          ))}
        </svg>
        <div class="playtime-pie__legend">
          {chunkLegendItems(slices.value, LEGEND_ROWS_PER_COLUMN).map((column, ci) => (
            <div class="playtime-pie__legend-col" key={ci}>
              {column.map((s) => (
                <span
                  class={{
                    "playtime-pie__legend-item": true,
                    ...focusState(hovered.value, s.code),
                  }}
                  key={s.code}
                  data-hint={hintOf(s)}
                  onMouseenter={() => {
                    hovered.value = s.code;
                  }}
                  onMouseleave={() => {
                    hovered.value = null;
                  }}
                >
                  <span class="playtime-pie__legend-dot" style={{ background: s.fill }} />
                  <span class="playtime-pie__legend-text">{s.label}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  },
});
