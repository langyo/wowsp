import { computed, defineComponent, type PropType } from "vue";

import { prTier, prTierLabel } from "@/utils/winrate";
import { prTrendLayout, type PrTrendPoint } from "./prTrend";
import "./PrTrendChart.scss";

/**
 * The PR trend line chart — one vertex per history interval, hand-drawn as
 * declarative Vue-rendered SVG (no chart library, same convention as
 * PlaytimeTrendChart). Faint horizontal guides sit at the PR tier
 * thresholds inside the plotted domain (reading progress against the
 * community scale), each named at its left end by the tier that starts
 * there (prTier color, wording per the localized-tiers pref — a number too
 * close to a tier name gives way; prTrendLayout decides which survive);
 * each dot is inked with its prTier color so tier moves read at a glance,
 * hover hints ride the app-wide data-hint hook, and ink beyond the dots is
 * styled in SCSS from theme variables so scheme flips repaint without
 * re-render.
 */
/** Rough advance width (px) of a tier name at the 9px label size — CJK
 *  glyphs render full-width, Latin/Cyrillic average ~0.6em. Only used to
 *  decide whether a localized band name needs textLength compression into
 *  the left gutter (ru-RU's unicom tier outruns it at 9px and would clip
 *  past the viewBox edge — SVG text has no CSS-side overflow options). */
function estTierLabelWidth(name: string): number {
  let w = 0;
  for (const ch of name) w += ch.charCodeAt(0) > 0x2e80 ? 9 : 5.5;
  return w;
}

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
      return (
        <svg
          class="pr-trend"
          viewBox={`0 0 ${l.width} ${l.height}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Domain gridlines: floor / mid / ceiling with their PR values.
              A number within a tier label's clearance drops (a.label false)
              — the gridline itself still draws. */}
          {l.axis.map((a) => (
            <g key={a.pr}>
              <line class="pr-trend__grid" x1={l.sidePad} y1={a.y} x2={l.width - 8} y2={a.y} />
              {a.label ? (
                <text class="pr-trend__axis" x={l.sidePad - 6} y={a.y + 3}>
                  {a.pr}
                </text>
              ) : null}
            </g>
          ))}
          {/* Tier thresholds inside the domain — dashed, named at their left
              end by the tier that starts there, so a segment's band reads
              without a legend; the threshold value rides the data-hint. */}
          {l.guides.map((g) => {
            const tier = prTier(g.pr);
            const name = prTierLabel(tier.key);
            const gutter = l.sidePad - 8;
            const clamp = estTierLabelWidth(name) > gutter ? gutter : undefined;
            return (
              <g key={g.pr}>
                <line
                  class="pr-trend__guide"
                  x1={l.sidePad}
                  y1={g.y}
                  x2={l.width - 8}
                  y2={g.y}
                  data-hint={String(g.pr)}
                />
                <text
                  class="pr-trend__tier"
                  x={l.sidePad - 6}
                  y={g.y + 3}
                  fill={tier.color}
                  {...(clamp ? { textLength: clamp, lengthAdjust: "spacingAndGlyphs" } : {})}
                >
                  {name}
                </text>
              </g>
            );
          })}
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
