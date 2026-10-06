import { computed, defineComponent, type PropType } from "vue";

import { t } from "@/i18n";
import { buildHeatGrid, type HeatPoint } from "./playtimeAgg";
import "./PlaytimeHeatmap.scss";

/** Heatmap cell metrics — the SVG's whole geometry derives from these.
 *  The week count is NOT a constant: the grid's columns carry it (the
 *  window is adaptive — see playtimeAgg.heatWeeks). */
const CELL = 12;
const GAP = 3;
const LEFT = 34;
const TOP = 2;

/**
 * The playtime heatmap — GitHub-style calendar (Monday-first rows, ending
 * with the current partial week), Starward-style month labels UNDER the
 * grid and weekday markers (周一 / 周日) on the left edge. The window
 * spans every week back to the earliest point (heatWeeks: ≥ one year, ≤
 * three), so the canvas width follows the grid's column count. Hand-drawn
 * SVG; cell fills ride the theme's primary color at four opacity levels
 * (SCSS). Value-agnostic: the view feeds it `points` plus a `hintOf`
 * formatter (today: battles per local day — see battlesDaily), so hover
 * hints carry the exact day + the caller's phrasing. Empty days render a
 * blank cell with no hint at all.
 */
export default defineComponent({
  name: "PlaytimeHeatmap",
  props: {
    points: { type: Array as PropType<HeatPoint[]>, required: true },
    hintOf: { type: Function as PropType<(value: number) => string>, required: true },
    now: { type: Object as () => Date, required: true },
    locale: { type: String, required: true },
  },
  setup(props) {
    const grid = computed(() => buildHeatGrid(props.points, props.now, props.locale));

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
            {g.columns.map((column, w) => (
              <g key={w}>
                {column.map((cell, r) => {
                  if (cell.future || !cell.key) return null;
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
