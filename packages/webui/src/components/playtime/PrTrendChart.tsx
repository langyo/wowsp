import { computed, defineComponent, type PropType } from "vue";

import { prTier } from "@/utils/winrate";
import { prTrendLayout, type PrTrendPoint } from "./prTrend";
import "./PrTrendChart.scss";

/**
 * The PR trend line chart — one vertex per history interval, hand-drawn as
 * declarative Vue-rendered SVG (no chart library, same convention as
 * PlaytimeTrendChart). Faint horizontal guides sit at the PR tier
 * thresholds inside the plotted domain (reading progress against the
 * community scale); each dot is inked with its prTier color so tier moves
 * read at a glance, hover hints ride the app-wide data-hint hook, and ink
 * beyond the dots is styled in SCSS from theme variables so scheme flips
 * repaint without re-render.
 */
export default defineComponent({
  name: "PrTrendChart",
  props: {
    points: { type: Array as () => PrTrendPoint[], required: true },
    /** X tick label (the caller owns locale). */
    fmtTick: { type: Function as PropType<(t: number) => string>, required: true },
    /** A vertex's hover hint text. */
    hintOf: { type: Function as PropType<(p: PrTrendPoint) => string>, required: true },
  },
  setup(props) {
    const layout = computed(() => prTrendLayout(props.points));

    return () => {
      const l = layout.value;
      const yOf = (pr: number) =>
        l.baselineY - ((pr - l.yMin) / (l.yMax - l.yMin)) * (l.baselineY - l.topPad);
      const yMid = (l.yMin + l.yMax) / 2;
      return (
        <svg
          class="pr-trend"
          viewBox={`0 0 ${l.width} ${l.height}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Domain gridlines: floor / mid / ceiling with their PR values. */}
          {[
            { pr: l.yMin, y: l.baselineY },
            { pr: yMid, y: yOf(yMid) },
            { pr: l.yMax, y: yOf(l.yMax) },
          ].map((g) => (
            <g key={g.pr}>
              <line class="pr-trend__grid" x1={l.sidePad} y1={g.y} x2={l.width - 8} y2={g.y} />
              <text class="pr-trend__axis" x={l.sidePad - 6} y={g.y + 3}>
                {g.pr}
              </text>
            </g>
          ))}
          {/* Tier thresholds inside the domain — dashed and labeled by their
              value so a segment's band reads without a legend. */}
          {l.guides.map((g) => (
            <line
              key={g.pr}
              class="pr-trend__guide"
              x1={l.sidePad}
              y1={g.y}
              x2={l.width - 8}
              y2={g.y}
              data-hint={String(g.pr)}
            />
          ))}
          {l.path ? <path class="pr-trend__line" d={l.path} /> : null}
          {l.vertices.map((v, i) => (
            <circle
              key={i}
              class="pr-trend__dot"
              cx={v.x}
              cy={v.y}
              r={3.5}
              fill={prTier(props.points[i].pr).color}
              data-hint={props.hintOf(props.points[i])}
            />
          ))}
          {l.xTicks.map((tk, i) => (
            <text class="pr-trend__x" key={i} x={tk.x} y={l.baselineY + 16}>
              {props.fmtTick(tk.t)}
            </text>
          ))}
        </svg>
      );
    };
  },
});
