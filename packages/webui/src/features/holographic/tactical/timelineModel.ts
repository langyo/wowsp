/**
 * Timeline window/ruler/marker-layout math for the tactical timeline. Pure
 * functions so the video-editor behaviours (zoom clamp, adaptive ruler,
 * collision-row assignment) are unit-testable without a canvas.
 */
import type { ShipAction } from "./actions";

/** Zoom-in floor: the widest battle time one screen may ever show. */
export const TIMELINE_MIN_SPAN_S = 15;

export interface TimeWindow {
  start: number;
  end: number;
}

/** Clamp a window into [0, duration], never narrower than the 15 s zoom
 *  floor and never wider than the battle itself. */
export function clampWindow(w: TimeWindow, duration: number): TimeWindow {
  const dur = Math.max(0, duration);
  const minSpan = Math.min(TIMELINE_MIN_SPAN_S, Math.max(1, dur));
  const span = Math.max(minSpan, Math.min(w.end - w.start, dur));
  let start = w.start;
  start = Math.max(0, Math.min(start, dur - span));
  return { start, end: start + span };
}

/** Zoom by `factor` (>1 = in) keeping `anchor` (battle seconds) fixed under
 *  the cursor. */
export function zoomWindow(
  cur: TimeWindow,
  duration: number,
  factor: number,
  anchor: number,
): TimeWindow {
  const span = (cur.end - cur.start) / factor;
  const k = (anchor - cur.start) / Math.max(1e-6, cur.end - cur.start);
  return clampWindow({ start: anchor - k * span, end: anchor + (1 - k) * span }, duration);
}

/** Window that shows the whole battle. */
export function fullWindow(duration: number): TimeWindow {
  return clampWindow({ start: 0, end: Math.max(1, duration) }, duration);
}

export interface RulerTick {
  t: number;
  label: string;
  major: boolean;
}

const TICK_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Adaptive ruler ticks: pick the largest step whose labels stay at least
 *  `minLabelPx` apart; minor ticks subdivide. `fmt` renders the label. */
export function rulerTicks(
  start: number,
  end: number,
  widthPx: number,
  minLabelPx: number,
  fmt: (t: number) => string,
): RulerTick[] {
  const span = Math.max(1e-6, end - start);
  const pxPerS = widthPx / span;
  let step = TICK_STEPS_S[TICK_STEPS_S.length - 1];
  for (const cand of TICK_STEPS_S) {
    if (cand * pxPerS >= minLabelPx) {
      step = cand;
      break;
    }
  }
  const ticks: RulerTick[] = [];
  const first = Math.ceil(start / step) * step;
  for (let t = first; t <= end + 1e-6; t += step) {
    ticks.push({ t, label: fmt(t), major: true });
    const minor = step / 5;
    for (let m = 1; m < 5; m++) {
      const mt = t - step + m * minor;
      if (mt > start && mt < end) ticks.push({ t: mt, label: "", major: false });
    }
  }
  return ticks;
}

/** "M:SS" battle clock (hours roll over as M>59 — battles never get there). */
export function fmtClock(t: number): string {
  const s = Math.max(0, Math.round(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One marker laid out on the timeline: x is the ICON CENTER in px, row the
 *  collision lane (0 = top). */
export interface LaidMarker {
  action: ShipAction;
  x: number;
  row: number;
}

/** Greedy row assignment (no filtering): each item takes the first lane
 *  whose previous marker ends a gap before it; lane count is capped —
 *  overflow markers share the last lane (density-mode rendering kicks in
 *  before that matters). Returns x/y per input index. */
export function assignRows(
  times: number[],
  start: number,
  end: number,
  widthPx: number,
  iconPx: number,
  maxRows: number,
): { x: number; row: number }[] {
  const span = Math.max(1e-6, end - start);
  const pxPerS = widthPx / span;
  const gapPx = iconPx + 3;
  const rowFree: number[] = new Array(maxRows).fill(-Infinity);
  return times.map((t) => {
    const x = (t - start) * pxPerS;
    let row = 0;
    for (; row < maxRows; row++) {
      if (x - rowFree[row] >= gapPx) break;
    }
    if (row === maxRows) row = maxRows - 1;
    rowFree[row] = x;
    return { x, row };
  });
}

/** In-window actions laid out as timeline markers. */
export function layoutMarkers(
  actions: ShipAction[],
  start: number,
  end: number,
  widthPx: number,
  iconPx: number,
  maxRows: number,
): LaidMarker[] {
  const laid = assignRows(
    actions.map((a) => a.time),
    start,
    end,
    widthPx,
    iconPx,
    maxRows,
  );
  const out: LaidMarker[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.time < start || a.time > end) continue;
    out.push({ action: a, x: laid[i].x, row: laid[i].row });
  }
  return out;
}

// ── Plan tracks (accordion rows) ───────────────────────────────────────────

/** Header height of one unit row (its label chip / collapse caret). */
export const TRACK_HEADER_H = 15;
/** Expanded body floor/ceiling — the band the keyframes and tween arrows
 *  live in. The ceiling keeps a single-unit plan from stretching into a wall
 *  of empty space. */
export const TRACK_BODY_MIN_H = 10;
export const TRACK_BODY_MAX_H = 34;

/** One laid-out unit row: `top` is relative to the lanes band. */
export interface PlanRowLayout {
  key: string;
  top: number;
  headerH: number;
  bodyH: number;
  collapsed: boolean;
}

/** Accordion layout for the plan tracks: every unit gets a header, expanded
 *  units additionally a body sized from the leftover height. Headers shrink
 *  (never the bodies) once a plan has more units than the band can host, so
 *  a row never escapes the band and nothing is silently clipped away. */
export function layoutPlanRows(
  keys: string[],
  collapsedKeys: ReadonlySet<string>,
  lanesH: number,
): PlanRowLayout[] {
  if (keys.length === 0) return [];
  const collapsed: boolean[] = keys.map((k) => collapsedKeys.has(k));
  const expandedCount = collapsed.filter((c) => !c).length;
  // Headers give way first (down to a 7px floor); expanded bodies keep their
  // floor so keyframes never collapse into an unreadable stripe.
  const headerH = Math.max(
    7,
    Math.min(TRACK_HEADER_H, (lanesH - expandedCount * TRACK_BODY_MIN_H) / keys.length),
  );
  const bodyH = expandedCount
    ? Math.max(
        TRACK_BODY_MIN_H,
        Math.min(TRACK_BODY_MAX_H, (lanesH - headerH * keys.length) / expandedCount),
      )
    : 0;
  const out: PlanRowLayout[] = [];
  let top = 0;
  keys.forEach((key, i) => {
    out.push({ key, top, headerH, bodyH: collapsed[i] ? 0 : bodyH, collapsed: collapsed[i] });
    top += headerH + (collapsed[i] ? 0 : bodyH);
  });
  return out;
}
