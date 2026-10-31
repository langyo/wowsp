/**
 * One breakdown donut — the 游玩时间 view's per-group battle share (ship
 * type / nation / tier / mode). Same-source migration: the ring, the
 * chunked DOM legend and the paired hover focus now render hikari's
 * HkDonutChart (upstreamed from this very family); this wrapper keeps
 * the view-facing props contract (aggregation + palettes + the optional
 * flag glyph rows live in battleBreakdown / the view) and supplies
 * - the hint string ("label · 24 场 · 17%", value-then-unit — the view's
 *   measure-word order), and
 * - the legendIcon slot bridging legendIconOf (NationFlag's contract:
 *   the glyph rides the row's full hint).
 *
 * Placement: four blocks share one row, so the block column stacks the
 * title over the chart; hikari's own flex row wraps the legend under
 * the ring at this width — the same shape the hand-rolled version had.
 */
import { computed, defineComponent, type PropType, type VNode } from "vue";
import { HkDonutChart, type HkDonutSlice } from "@celestia-island/hikari";

import type { BreakdownEntry } from "@/components/playtime/battleBreakdown";

export default defineComponent({
  name: "PlaytimeBreakdownPie",
  props: {
    title: { type: String, required: true },
    entries: { type: Array as PropType<BreakdownEntry[]>, required: true },
    labelOf: { type: Function as PropType<(key: string) => string>, required: true },
    colorOf: { type: Function as PropType<(key: string) => string>, required: true },
    /** Optional per-key legend glyph: a node renders IN PLACE of the row's
     * text label (the stats donuts' flag rows), null keeps the text; the
     * slice-color dot always stays. Label and hint ride along so the glyph
     * can carry the row's full hint — NationFlag's contract for flag rows. */
    legendIconOf: {
      type: Function as PropType<(key: string, label: string, hint: string) => VNode | null>,
      required: false,
    },
    /** The localized unit word in hover hints ("场" — battles). */
    unitLabel: { type: String, required: true },
  },
  setup(props) {
    const entries = computed(() =>
      props.entries.map((e) => ({
        key: e.key,
        label: props.labelOf(e.key),
        value: e.count,
        color: props.colorOf(e.key),
      })),
    );
    /** "label · 24 场 · 17%" — word order deliberately inverts the stats
     * page's "场次 24": this view's unit word is a measure word ("场"),
     * which reads naturally after the number in every locale. */
    const hintOf = (s: HkDonutSlice): string =>
      `${s.label} · ${s.value} ${props.unitLabel} · ${s.percentInt}%`;

    return () => (
      <div class="playtime-breakdown-pie">
        <div class="playtime-breakdown-pie__title">{props.title}</div>
        <HkDonutChart
          entries={entries.value}
          hintOf={hintOf}
          legendRows={5}
          v-slots={{
            // Vue normalizes a slot call's return into an array, so a
            // null glyph can NEVER fall through to the chart's own
            // label — the ADAPTER must fall back to the label text here
            // (returning a string is a valid slot payload).
            legendIcon: props.legendIconOf
              ? (s: HkDonutSlice) => props.legendIconOf!(s.key, s.label, hintOf(s)) ?? s.label
              : undefined,
          }}
        />
      </div>
    );
  },
});
