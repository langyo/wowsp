/**
 * Pure data shaping for the 游玩时间 view: compact duration formatting, the
 * trend buckets (最近 15 天 / 12 周 / 12 月) and the GitHub-style heatmap
 * grid. Every helper takes `now` explicitly — the view pins the clock once
 * per poll and the tests pin their own, so nothing here can hide a
 * Date.now() and every output stays deterministic for a given input.
 *
 * All calendar math runs on LOCAL dates at NOON (12:00) — noon can never
 * sit on a DST edge, so add-day/month arithmetic on Date stays exact
 * without pulling in a date library.
 */
import type { PlaytimeDay } from "@/api";

export type TrendRange = "15d" | "12w" | "12m";

/** One trend bar (or one heatmap cell's) display record. */
export interface TrendBucket {
  /** Short axis label, e.g. "09-21" / "10月". */
  label: string;
  /** Hover hint: the exact covered span plus the formatted duration. */
  hint: string;
  seconds: number;
}

/** "284h 19m" / "42m" / "0m" — minutes-rounded compact duration, the same
 *  shape Starward's stats sheet reads. */
export function fmtDuration(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** Axis tick label: whole hours as "4h", otherwise whole minutes ("30m"). */
export function fmtAxis(seconds: number): string {
  if (seconds > 0 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

/** `YYYY-MM-DD` for a local-noon Date. */
export function dayKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Parse a ledger date key into a local-noon Date (null for junk keys —
 *  a hand-edited file must not throw). */
export function parseDayKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

/** "MM-DD" short label of a local-noon Date. */
function shortDay(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

/** Seconds of `daily` falling in [from, to) (local-noon Dates). */
function sumRange(map: Map<string, number>, from: Date, to: Date): number {
  let total = 0;
  const cursor = new Date(from);
  while (cursor < to) {
    total += map.get(dayKey(cursor)) ?? 0;
    cursor.setDate(cursor.getDate() + 1);
  }
  return total;
}

/** The trend buckets for one range. Missing days are zero-filled so the
 *  chart never resorts its axis: 15 daily bars, 12 Monday-start weeks,
 *  12 calendar months (current one included, partial). */
export function bucketDaily(
  daily: PlaytimeDay[],
  range: TrendRange,
  now: Date,
  locale: string,
): TrendBucket[] {
  const map = new Map(daily.map((d) => [d.date, d.seconds]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const monthLabel = (d: Date): string =>
    new Intl.DateTimeFormat(locale, { month: "short" }).format(d);

  if (range === "15d") {
    const out: TrendBucket[] = [];
    for (let i = 14; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const seconds = map.get(dayKey(d)) ?? 0;
      out.push({
        label: shortDay(d),
        hint: `${shortDay(d)} · ${fmtDuration(seconds)}`,
        seconds,
      });
    }
    return out;
  }

  if (range === "12w") {
    // Monday-start weeks, the same week the heatmap grid uses.
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const out: TrendBucket[] = [];
    for (let w = 11; w >= 0; w--) {
      const from = new Date(monday);
      from.setDate(monday.getDate() - 7 * w);
      const to = new Date(from);
      to.setDate(from.getDate() + 7);
      const end = new Date(to);
      end.setDate(to.getDate() - 1);
      const seconds = sumRange(map, from, to);
      out.push({
        label: shortDay(from),
        hint: `${shortDay(from)} ~ ${shortDay(end)} · ${fmtDuration(seconds)}`,
        seconds,
      });
    }
    return out;
  }

  // 12m: calendar months, oldest first, the current (partial) month last.
  const out: TrendBucket[] = [];
  for (let i = 11; i >= 0; i--) {
    const from = new Date(today.getFullYear(), today.getMonth() - i, 1, 12);
    const to = new Date(today.getFullYear(), today.getMonth() - i + 1, 1, 12);
    let seconds = 0;
    for (const [key, value] of map) {
      const day = parseDayKey(key);
      if (day && day >= from && day < to) seconds += value;
    }
    out.push({
      label: monthLabel(from),
      hint: `${monthLabel(from)} · ${fmtDuration(seconds)}`,
      seconds,
    });
  }
  return out;
}

/** A heat level 0..4 from a day's value against the window's max —
 *  quartiles of the max, clamped so any positive value reads ≥ 1. Value
 *  semantics (tracked seconds, battle count) are the caller's business. */
export function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as 1 | 2 | 3 | 4;
}

export interface HeatCell {
  /** `YYYY-MM-DD`, or "" for a padded cell outside the calendar. */
  key: string;
  value: number;
  level: 0 | 1 | 2 | 3 | 4;
  /** True for cells after today (rendered blank, never hovered). */
  future: boolean;
}

export interface HeatGrid {
  /** Column-major weeks; each column holds 7 cells, Monday first. */
  columns: HeatCell[][];
  /** One label per month: the column that contains its day 1. */
  months: { col: number; label: string }[];
  /** The window's busiest day (the level scale's 4). */
  maxValue: number;
}

/** One heatmap point: a local day key ("YYYY-MM-DD", the shape dayKey and
 *  battleDayKey emit) and the value to plot on it. */
export interface HeatPoint {
  date: string;
  value: number;
}

/** The heatmap window selection: `null` = the rolling past year (a fixed
 *  53 weeks), a number = that calendar year (Jan..Dec, the current year
 *  ending today), `"all"` = every week back to the earliest point (the
 *  old adaptive window, capped at HEAT_MAX_WEEKS). The view's year tabs
 *  carry these. */
export type HeatYear = number | "all" | null;

/** The heatmap window's week count for the `"all"` selection: enough
 *  Monday-start weeks to reach back to the earliest point, floored at
 *  HEAT_MIN_WEEKS (a fresh history keeps the GitHub-year shape instead of
 *  a stubby grid) and capped at HEAT_MAX_WEEKS (three years — past that
 *  the 12px cells render too small to read at the view's column width,
 *  and replay archives that old are rare). Junk day keys are ignored; no
 *  parsable point (or a future-only set) falls back to the floor. Pure —
 *  `now` pins the current week the same way buildHeatGrid does. */
export const HEAT_MIN_WEEKS = 53;
export const HEAT_MAX_WEEKS = 156;

export function heatWeeks(points: HeatPoint[], now: Date): number {
  let earliest: Date | null = null;
  for (const p of points) {
    const d = parseDayKey(p.date);
    if (d && (!earliest || d < earliest)) earliest = d;
  }
  if (!earliest) return HEAT_MIN_WEEKS;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const firstMonday = new Date(earliest);
  firstMonday.setDate(earliest.getDate() - ((earliest.getDay() + 6) % 7));
  // Local-noon to local-noon across a DST edge is off a whole-week ms
  // count by an hour — round, don't floor.
  const span =
    Math.round((thisMonday.getTime() - firstMonday.getTime()) / (7 * 86_400_000)) + 1;
  return Math.min(HEAT_MAX_WEEKS, Math.max(HEAT_MIN_WEEKS, span));
}

/** The Monday on or before `d`, local noon like every other anchor here. */
function mondayOnOrBefore(d: Date): Date {
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return monday;
}

/** GitHub-style heatmap grid: Monday-start weeks, weekday rows
 *  Monday..Sunday. The window rides the `year` selection — `null` shows
 *  the rolling past year (a fixed 53-week GitHub year), a number shows
 *  that calendar year (the current year's window ends today; future
 *  cells render blank), and `"all"` spans every week back to the
 *  earliest point (heatWeeks: at least a year, at most three). `points`
 *  may be the time ledger's days or battle counts per day — only
 *  `date` / `value` are read. `locale` formats the month labels. */
export function buildHeatGrid(
  points: HeatPoint[],
  now: Date,
  locale: string,
  year: HeatYear,
): HeatGrid {
  const map = new Map(points.map((p) => [p.date, p.value]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  let weeks: number;
  let monday: Date;
  if (year === "all") {
    weeks = heatWeeks(points, now);
    monday = mondayOnOrBefore(today);
    monday.setDate(monday.getDate() - (weeks - 1) * 7);
  } else if (year === null) {
    weeks = HEAT_MIN_WEEKS;
    monday = mondayOnOrBefore(today);
    monday.setDate(monday.getDate() - (weeks - 1) * 7);
  } else {
    const start = new Date(year, 0, 1, 12);
    const endCandidate = new Date(year, 11, 31, 12);
    const end = endCandidate > today ? today : endCandidate;
    if (start > today) {
      // A future selection can't happen through the view's tabs — fall
      // back to the rolling year rather than rendering an empty canvas.
      weeks = HEAT_MIN_WEEKS;
      monday = mondayOnOrBefore(today);
      monday.setDate(monday.getDate() - (weeks - 1) * 7);
    } else {
      const startMonday = mondayOnOrBefore(start);
      weeks =
        Math.round((mondayOnOrBefore(end).getTime() - startMonday.getTime()) / (7 * 86_400_000)) +
        1;
      monday = startMonday;
    }
  }

  // Pass 1: each cell's date + value, the window's max, and the month
  // anchors — a month's day 1 falls in exactly one column, which pins its
  // label.
  const cells: { date: Date; value: number; future: boolean }[][] = [];
  const months: { col: number; label: string }[] = [];
  let maxValue = 0;
  let labeledMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const column: { date: Date; value: number; future: boolean }[] = [];
    for (let r = 0; r < 7; r++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + w * 7 + r);
      const future = date > today;
      const value = future ? 0 : (map.get(dayKey(date)) ?? 0);
      if (value > maxValue) maxValue = value;
      if (date.getDate() === 1 && date.getMonth() !== labeledMonth) {
        labeledMonth = date.getMonth();
        months.push({
          col: w,
          label: new Intl.DateTimeFormat(locale, { month: "short" }).format(date),
        });
      }
      column.push({ date, value, future });
    }
    cells.push(column);
  }
  // Pass 2: levels against the settled max.
  const columns: HeatCell[][] = cells.map((column) =>
    column.map((cell) => ({
      key: cell.future ? "" : dayKey(cell.date),
      value: cell.value,
      level: heatLevel(cell.value, maxValue),
      future: cell.future,
    })),
  );
  return { columns, months, maxValue };
}

// ── trend bar chart geometry (same pure-geometry pattern as
//    ShipDistCharts.tierBars, but the bars fill their slot the way
//    Starward's duration chart reads) ────────────────────────────────────────

/** The trend SVG's viewBox + plot insets. Exported so the component and the
 *  geometry can never drift apart on the label gutters. */
export const TREND_FRAME = {
  width: 640,
  height: 220,
  sidePad: 44,
  topPad: 14,
  bottomPad: 24,
} as const;

/** Round the window max up to a human tick so the axis reads "4h", not
 *  "3.7h". The steps skip 1.5h/3h deliberately — their HALF-tick would be
 *  an awkward "90m"/"1h 30m" on the middle gridline. Sub-hour windows start
 *  at 30m; multi-day windows round to whole days. */
export function niceMaxSeconds(max: number): number {
  if (max <= 0) return 3600;
  const hours = max / 3600;
  for (const h of [0.5, 1, 2, 4, 6, 8, 12, 16, 24]) {
    if (hours <= h) return Math.round(h * 3600);
  }
  return Math.ceil(hours / 24) * 86_400;
}

export interface TrendBarSlot {
  centerX: number;
  barWidth: number;
  /** Empty string for a zero bucket — no invisible sliver to hover. */
  path: string;
  value: number;
}

export interface TrendBarLayout {
  width: number;
  height: number;
  baselineY: number;
  sidePad: number;
  /** Three horizontal guides: 0, half and the (nice) max. */
  gridlines: { y: number; seconds: number }[];
  bars: TrendBarSlot[];
}

/** Buckets' seconds → per-slot geometry. Equal slots, each bar centered
 *  with a 62%-of-slot width (36px cap), rounded top corners. Pure and
 *  unit-tested like tierBars. */
export function trendBars(
  seconds: readonly number[],
  opts: { width?: number; height?: number } = {},
): TrendBarLayout {
  const width = opts.width ?? TREND_FRAME.width;
  const height = opts.height ?? TREND_FRAME.height;
  const sidePad = TREND_FRAME.sidePad;
  const topPad = TREND_FRAME.topPad;
  const baselineY = height - TREND_FRAME.bottomPad;
  const plotH = baselineY - topPad;
  const scale = niceMaxSeconds(seconds.reduce((a, v) => Math.max(a, v), 0));
  const slotW = (width - 2 * sidePad) / Math.max(1, seconds.length);
  const barW = Math.min(slotW * 0.62, 36);
  const bars: TrendBarSlot[] = seconds.map((value, i) => {
    const centerX = sidePad + slotW * (i + 0.5);
    if (!(value > 0)) {
      return { centerX, barWidth: barW, path: "", value };
    }
    const h = (value / scale) * plotH;
    const top = baselineY - h;
    const x0 = centerX - barW / 2;
    const x1 = centerX + barW / 2;
    // Top-only rounding, clamped so a squat bar never inverts its corners.
    const rx = Math.min(3, barW / 2, h / 2);
    const path =
      `M ${fmtN(x0)} ${fmtN(baselineY)} ` +
      `L ${fmtN(x0)} ${fmtN(top + rx)} ` +
      `Q ${fmtN(x0)} ${fmtN(top)} ${fmtN(x0 + rx)} ${fmtN(top)} ` +
      `L ${fmtN(x1 - rx)} ${fmtN(top)} ` +
      `Q ${fmtN(x1)} ${fmtN(top)} ${fmtN(x1)} ${fmtN(top + rx)} ` +
      `L ${fmtN(x1)} ${fmtN(baselineY)} Z`;
    return { centerX, barWidth: barW, path, value };
  });
  const gridlines = [0, 0.5, 1].map((f) => ({
    y: Math.round((baselineY - f * plotH) * 100) / 100,
    seconds: Math.round(scale * f),
  }));
  return { width, height, baselineY, sidePad, gridlines, bars };
}

/** Trim float noise so path strings stay short and deterministic. */
function fmtN(n: number): number {
  return Math.round(n * 100) / 100;
}
