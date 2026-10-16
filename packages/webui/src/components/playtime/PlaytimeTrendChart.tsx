import { computed, defineComponent } from "vue";

import { fmtAxis, trendBars, type TrendBucket } from "./playtimeAgg";
import "./PlaytimeTrendChart.scss";

/**
 * The playtime trend chart — one bar per bucket (day / week / month),
 * hand-drawn as declarative Vue-rendered SVG (no chart library, same
 * convention as ShipDistCharts). Gridlines at 0 / half / a human-rounded
 * max, x labels under every bar, hover hints through the app-wide
 * data-hint hook. Ink is styled in SCSS from theme variables, so scheme
 * flips repaint without re-render.
 */
export default defineComponent({
  name: "PlaytimeTrendChart",
  props: {
    buckets: { type: Array as () => TrendBucket[], required: true },
  },
  setup(props) {
    const layout = computed(() => trendBars(props.buckets.map((b) => b.seconds)));

    return () => {
      const l = layout.value;
      return (
        <svg
          class="playtime-trend"
          viewBox={`0 0 ${l.width} ${l.height}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {l.gridlines.map((g) => (
            <g key={g.seconds}>
              <line
                class="playtime-trend__grid"
                x1={l.sidePad}
                y1={g.y}
                x2={l.width - 8}
                y2={g.y}
              />
              <text class="playtime-trend__axis" x={l.sidePad - 6} y={g.y + 3}>
                {fmtAxis(g.seconds)}
              </text>
            </g>
          ))}
          {l.bars.map((b, i) => (
            <g key={i}>
              {b.path ? (
                <path
                  class="playtime-trend__bar"
                  d={b.path}
                  data-hint={props.buckets[i].hint}
                />
              ) : null}
              <text class="playtime-trend__x" x={b.centerX} y={l.baselineY + 14}>
                {props.buckets[i].label}
              </text>
            </g>
          ))}
        </svg>
      );
    };
  },
});
