/**
 * Pure donut-ring geometry + legend chunking shared by the stats donuts
 * (ShipDistCharts — class / nation) and the 游玩时间 breakdown donuts
 * (PlaytimeBreakdownPie — type / nation / tier / mode), so every ring in
 * the app draws the identical retired-ECharts shape: path segments on a
 * square viewBox, radius ["40%","68%"] of half the box, 12-o'clock start,
 * clockwise.
 *
 * This module is deliberately dependency-free (no Vue, no i18n, no
 * modelLoader): battleBreakdown/PlaytimeBreakdownPie must not drag
 * three.js into the playtime chunk, and ShipDistCharts' own imports are
 * exactly what that would pull in. Everything here is pure and
 * unit-testable (same contract as playtimeAgg) — the tests live in
 * ShipDistCharts.test.ts.
 */

// ---------------------------------------------------------------------------
// Pure SVG geometry. Angles are degrees in the screen coordinate system:
// -90 = 12 o'clock, increasing clockwise.
// ---------------------------------------------------------------------------

/** Point on a circle at `deg` (see the angle convention above). */
function polar(
  cx: number,
  cy: number,
  r: number,
  deg: number,
): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** Trim float noise so path strings stay short and deterministic.
 *  Exported because the tier histogram (ShipDistCharts.tierBars) shares
 *  the same deterministic-number contract. */
export function fmt(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Closed ring segment (donut slice) from `startDeg` to `endDeg`: outer
 *  arc clockwise, radial edge, inner arc counter-clockwise back, close. */
function ringSegment(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startDeg: number,
  endDeg: number,
): string {
  const o1 = polar(cx, cy, outerR, startDeg);
  const o2 = polar(cx, cy, outerR, endDeg);
  const i2 = polar(cx, cy, innerR, endDeg);
  const i1 = polar(cx, cy, innerR, startDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return (
    `M ${fmt(o1.x)} ${fmt(o1.y)} ` +
    `A ${fmt(outerR)} ${fmt(outerR)} 0 ${large} 1 ${fmt(o2.x)} ${fmt(o2.y)} ` +
    `L ${fmt(i2.x)} ${fmt(i2.y)} ` +
    `A ${fmt(innerR)} ${fmt(innerR)} 0 ${large} 0 ${fmt(i1.x)} ${fmt(i1.y)} Z`
  );
}

/** A 100% slice as TWO 180° ring halves: a single 360° arc degenerates
 *  (start == end, the renderer would drop it), so the ring is split at
 *  left/right (0° and 180°) into two well-formed subpaths. */
function fullRing(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
): string {
  return `${ringSegment(cx, cy, outerR, innerR, 0, 180)} ${ringSegment(cx, cy, outerR, innerR, 180, 360)}`;
}

/** One donut slice: raw aggregation code (stable key), localized label,
 *  value, share of the SHOWN sum, ready-to-render path and fill. */
export interface DonutSlice {
  code: string;
  label: string;
  value: number;
  /** Share of the shown sum at 2-decimal display precision (33.496% →
   *  33.5). */
  percent: number;
  /** Math.round of the RAW share (33.496% → 33): the single integer both
   *  the slice tooltip and the DOM legend render. Computed once here so
   *  re-rounding the 2-decimal value (33.5 → 34) can never disagree with
   *  the legend. */
  percentInt: number;
  path: string;
  fill: string;
}

/** [code, value] entries → donut slices starting at 12 o'clock (-90°),
 *  laid out clockwise in input order (callers pass count-desc). Pure:
 *  same entries + same opts → same slices, so it is fully unit-testable.
 *  Non-positive entries are dropped (a zero slice would be invisible and
 *  its tooltip misleading); an empty (or all-zero) input yields []. */
export function donutSlices(
  entries: readonly (readonly [string, number])[],
  opts: {
    labelOf: (code: string) => string;
    colorOf: (code: string) => string;
    /** Square viewBox side; default 150 (the stats donuts' fixed 150px
     *  square). */
    viewBox?: number;
    /** Defaults keep the retired ECharts look: radius ["40%","68%"] of
     *  half the viewBox → 30 / 51 on the 150 box. */
    outerR?: number;
    innerR?: number;
  },
): DonutSlice[] {
  const shown = entries.filter(([, v]) => v > 0);
  const total = shown.reduce((a, [, v]) => a + v, 0);
  if (total <= 0) return [];
  const viewBox = opts.viewBox ?? 150;
  const cx = viewBox / 2;
  const cy = viewBox / 2;
  const outerR = opts.outerR ?? 0.68 * cx;
  const innerR = opts.innerR ?? 0.4 * cx;
  const slices: DonutSlice[] = [];
  let angle = -90;
  for (const [code, value] of shown) {
    const share = value / total;
    const sweep = share * 360;
    const end = angle + sweep;
    const path =
      sweep > 360 - 1e-9
        ? fullRing(cx, cy, outerR, innerR)
        : ringSegment(cx, cy, outerR, innerR, angle, end);
    slices.push({
      code,
      label: opts.labelOf(code),
      value,
      percent: Math.round(share * 10000) / 100,
      percentInt: Math.round(share * 100),
      path,
      fill: opts.colorOf(code),
    });
    angle = end;
  }
  return slices;
}

/** Split items into fixed-height columns: each column holds up to `size`
 *  items (filled top-to-bottom in input order), overflow continues in the
 *  next column to the right. Pure and order-preserving, so the column
 *  layout is fully deterministic. */
export function chunkLegendItems<T>(items: readonly T[], size: number): T[][] {
  const rows = Math.max(1, Math.floor(size));
  const columns: T[][] = [];
  for (let i = 0; i < items.length; i += rows) {
    columns.push(items.slice(i, i + rows));
  }
  return columns;
}

/** Shared hover-focus class resolver for one chart block: `hovered` is the
 *  block's hover key (slice code, tier number, …) and `key` the element's
 *  own — the hovered element lifts (is-hot), its siblings dim (is-dim).
 *  Class names only; the paint lives in each component's SCSS
 *  (opacity/filter), so the geometry never changes — highlight without
 *  scaling any shape. */
export function focusState<T>(
  hovered: T | null,
  key: T,
): { "is-hot": boolean; "is-dim": boolean } {
  return {
    "is-hot": hovered === key,
    "is-dim": hovered != null && hovered !== key,
  };
}
