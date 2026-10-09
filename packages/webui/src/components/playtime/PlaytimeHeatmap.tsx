import { computed, defineComponent, type PropType } from "vue";

import { t } from "@/i18n";
import { buildHeatGrid, type HeatPoint, type HeatYear } from "./playtimeAgg";
import "./PlaytimeHeatmap.scss";

/** Heatmap cell metrics — the SVG's whole geometry derives from these.
 *  The week count is NOT a constant: the grid's columns carry it (the
 *  window rides the `year` selection — see playtimeAgg.buildHeatGrid). */
const CELL = 12;
const GAP = 3;
const LEFT = 34;
const TOP = 2;

/**
 * The playtime heatmap — GitHub-style calendar (Monday-first rows),
 * Starward-style month labels UNDER the grid and weekday markers (周一 /
 * 周日) on the left edge. The window rides the view's year switcher
 * (`year`: null = the rolling past year, a number = that calendar year,
 * "all" = the adaptive full window), so the canvas width follows the
 * grid's column count. Hand-drawn SVG; cell fills ride the theme's
 * primary color at four opacity levels (SCSS). Value-agnostic: the view
 * feeds it `points` plus a `hintOf` formatter (today: battles per local
 * day — see battlesDaily), so hover hints carry the exact day + the
 * caller's phrasing. Empty days render a blank cell with no hint at all;
 * days that haven't arrived yet (a whole in-progress year's tail) hatch
 * gray instead — the year grid stays whole, the mask reads "not yet". */
export default defineComponent({
  name: "PlaytimeHeatmap",
  props: {
    points: { type: Array as PropType<HeatPoint[]>, required: true },
    hintOf: { type: Function as PropType<(value: number) => string>, required: true },
    now: { type: Object as () => Date, required: true },
    locale: { type: String, required: true },
    year: { type: [Number, String] as unknown as PropType<HeatYear>, default: null },
  },
  setup(props) {
    const grid = computed(() =>
      buildHeatGrid(props.points, props.now, props.locale, props.year),
    );

    return () => {
      const g = grid.value;
      const width = LEFT + g.columns.length * (CELL + GAP);
      const height = TOP + 7 * (CELL + GAP) + 18;
      return (
        <div class="playtime-heat">
          <svg
            class="playtime-heat__svg"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              {/* The not-yet days' mask: a 45° stripe per 4px tile over a
                  faint base. Colors live in the SCSS (theme text tint) —
                  the pattern here is pure geometry. */}
              <pattern
                id="playtime-heat-hatch"
                width={4}
                height={4}
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width={4} height={4} class="playtime-heat__hatch-bg" />
                {/* Centered in the tile so the 1.2px stroke survives the
                    tile-edge clip whole. */}
                <line x1={2} y1={0} x2={2} y2={4} class="playtime-heat__hatch-line" />
              </pattern>
            </defs>
            {g.columns.map((column, w) => (
              <g key={w}>
                {column.map((cell, r) => {
                  if (cell.future) {
                    return (
                      <rect
                        key={`f${w}-${r}`}
                        class="playtime-heat__cell is-future"
                        x={LEFT + w * (CELL + GAP)}
                        y={TOP + r * (CELL + GAP)}
                        width={CELL}
                        height={CELL}
                        rx={2.5}
                      />
                    );
                  }
                  if (!cell.key) return null;
                  return (
                    <rect
                      key={cell.key}
                      class={`playtime-heat__cell is-${cell.level}`}
                      x={LEFT + w * (CELL + GAP)}
                      y={TOP + r * (CELL + GAP)}
                      width={CELL}
                      height={CELL}
                      rx={2.5}
                      data-hint={
                        cell.value > 0 ? `${cell.key} · ${props.hintOf(cell.value)}` : undefined
                      }
                    />
                  );
                })}
              </g>
            ))}
            {/* Weekday markers: only the top (周一) and bottom (周日) rows,
                like the reference sheet — seven labels read as clutter. */}
            <text class="playtime-heat__weekday" x={LEFT - 6} y={TOP + CELL - 2}>
              {t("playtime.weekdayFirst")}
            </text>
            <text
              class="playtime-heat__weekday"
              x={LEFT - 6}
              y={TOP + 6 * (CELL + GAP) + CELL - 2}
            >
              {t("playtime.weekdayLast")}
            </text>
            {g.months.map((m) => (
              <text
                key={m.col}
                class="playtime-heat__month"
                x={LEFT + m.col * (CELL + GAP)}
                y={height - 4}
              >
                {m.label}
              </text>
            ))}
          </svg>
        </div>
      );
    };
  },
});
