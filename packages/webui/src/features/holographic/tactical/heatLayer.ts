/**
 * Corpus heat-overlay layer for the tactical board: resolves the
 * map-insights doc's (map, mode) row into its spawn/track 96×96 grids and
 * paints one of them as a translucent under-layer — "看看大家实际怎么走"
 * while planning (the community-collected replays the corpus CLI
 * aggregates; see packages/tools/replay-corpus).
 *
 * Grid orientation, verified against the generator (replay-corpus lib.rs):
 * `HeatAcc::bump` bins a point into the flat index `iz * GRID_SIDE + ix`
 * and `HeatAcc::finish` chunks that flat grid into rows, so the serialized
 * `grid` is row-major over Z — row index 0 covers the minZ edge, column
 * index 0 the minX edge — under `bounds` = [minX, minZ, maxX, maxZ]. The
 * grid's own extent is the OBSERVED coordinate extent (self-calibrating
 * bounds), which can be smaller than the map's playable rect; every cell is
 * converted back to its world rect and pushed through the caller's
 * projection, which alone decides where world axes land on screen (z flips
 * onto y in makeProjection) — nothing here flips an axis of its own.
 *
 * Pure module (no Vue/DOM imports) — unit-testable like geometry.ts.
 */
import type { InsightsHeatGrid, MapInsightsDoc, InsightsModeRow } from "../insightsLoader";
import type { Vec2 } from "./types";

/** The toolbar's overlay state: off, or which of the two grids is shown. */
export type HeatLayerMode = "off" | "track" | "spawn";

/** The drawable half of HeatLayerMode. */
export type HeatLayerKind = Exclude<HeatLayerMode, "off">;

/** One (map, mode) corpus row resolved for the board: the battle evidence
 *  behind the grids plus the grids themselves (either may be absent — the
 *  bundled lite doc carries neither, and a degenerate row may lack one). */
export interface HeatOverlayData {
  battleCount: number;
  spawn: InsightsHeatGrid | null;
  track: InsightsHeatGrid | null;
}

/** Minimal structural slice of render.ts's TacticalProjection — keeps this
 *  module free of an import cycle with the renderer. */
export interface HeatProjection {
  toPx(p: Vec2): { x: number; y: number };
}

/** Plan-board preset id (modes.ts) → the raw match-group key the insights
 *  doc and the learned layouts share (the corpus keys rows by the replay
 *  descriptor's matchGroup: pvp / ranked / clan / pve). */
function matchGroupOfPreset(modeId: string): string | null {
  if (modeId.startsWith("random-")) return "pvp";
  if (modeId === "ranked") return "ranked";
  if (modeId === "clan") return "clan";
  if (modeId === "pve-op") return "pve";
  return null;
}

/** Case-tolerant map lookup — the same normalization the stage applies to
 *  the minimaps bounds keys (`spaces/` prefix stripped, exact, lowercase,
 *  then a case-insensitive scan). */
function lookupMap(doc: MapInsightsDoc, spaceId: string) {
  const key = spaceId.replace(/^spaces\//, "");
  const maps = doc.maps;
  return (
    maps[key] ??
    maps[key.toLowerCase()] ??
    Object.entries(maps).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] ??
    null
  );
}

/** Case-tolerant mode-row lookup over one map's modes. */
function lookupMode(modes: Record<string, InsightsModeRow>, mode: string) {
  return modes[mode] ?? modes[mode.toLowerCase()] ?? null;
}

/** Shape-and-sense gate for one serialized grid: finite bounds, rows of
 *  finite counts, and at least one non-zero cell — an all-zero grid has no
 *  traffic to show and reads as "no data", not as an empty overlay. */
function sanitizedHeat(h: InsightsHeatGrid | undefined): InsightsHeatGrid | null {
  if (!h || !Array.isArray(h.bounds) || h.bounds.length !== 4) return null;
  const [minX, minZ, maxX, maxZ] = h.bounds;
  if (![minX, minZ, maxX, maxZ].every((v) => Number.isFinite(v))) return null;
  if (maxX < minX || maxZ < minZ) return null;
  if (!Array.isArray(h.grid) || h.grid.length === 0) return null;
  let any = false;
  for (const row of h.grid) {
    if (!Array.isArray(row)) return null;
    for (const n of row) {
      if (typeof n !== "number" || !Number.isFinite(n)) return null;
      if (n > 0) any = true;
    }
  }
  return any ? h : null;
}

/** Resolve the board's current (map, mode) against the corpus doc. A
 *  learned layout's raw match-group wins (the session keeps the applied
 *  layout's own key); template presets map through their family; anything
 *  else (unset mode, unknown preset) has nothing to resolve. Returns null
 *  unless the row carries at least one drawable grid. */
export function resolveHeatOverlay(
  doc: MapInsightsDoc | null | undefined,
  spaceId: string | null | undefined,
  modeId: string | null,
  modeGroup: string | null,
): HeatOverlayData | null {
  if (!doc || !spaceId) return null;
  const modes = lookupMap(doc, spaceId)?.modes;
  if (!modes) return null;
  const mode = modeGroup || matchGroupOfPreset(modeId ?? "");
  if (!mode) return null;
  const row = lookupMode(modes, mode);
  if (!row) return null;
  const spawn = sanitizedHeat(row.spawnHeat);
  const track = sanitizedHeat(row.trackHeat);
  if (!spawn && !track) return null;
  return { battleCount: row.battleCount, spawn, track };
}

/** Largest cell count of a grid — the normalization denominator (the draw
 *  ramps relative to the grid's own peak, so every (map, mode) uses its
 *  full colour range whatever its battle count). */
export function gridMax(grid: number[][]): number {
  let max = 0;
  for (const row of grid) {
    for (const n of row) {
      if (n > max) max = n;
    }
  }
  return max;
}

/** World rect one grid cell covers — the generator's binning math
 *  (HeatAcc::cell) inverted: column ix spans minX + ix/SIDE·w … on x, row
 *  iz likewise on z from minZ. */
export function heatCellWorldRect(
  bounds: readonly [number, number, number, number],
  cols: number,
  rows: number,
  ix: number,
  iz: number,
): { minX: number; minZ: number; maxX: number; maxZ: number } {
  const w = (bounds[2] - bounds[0]) / Math.max(1, cols);
  const h = (bounds[3] - bounds[1]) / Math.max(1, rows);
  return {
    minX: bounds[0] + ix * w,
    maxX: bounds[0] + (ix + 1) * w,
    minZ: bounds[1] + iz * h,
    maxZ: bounds[1] + (iz + 1) * h,
  };
}

/** Colour ramp: discrete bands from a faint cool blue (thin traffic) up to
 *  a warm high-alpha red (the hottest cells) — the classic corpus-heat
 *  language, dim enough to stay subordinate to the plan's own strokes and
 *  the cap rings drawn above it on the dark board art. */
const HEAT_BANDS: readonly { min: number; color: string }[] = [
  { min: 0, color: "rgba(59, 130, 246, 0.10)" },
  { min: 0.2, color: "rgba(45, 156, 219, 0.17)" },
  { min: 0.4, color: "rgba(34, 211, 238, 0.24)" },
  { min: 0.6, color: "rgba(250, 204, 21, 0.30)" },
  { min: 0.8, color: "rgba(251, 146, 60, 0.38)" },
  { min: 0.93, color: "rgba(244, 63, 94, 0.46)" },
];

/** Index of the band a normalized cell value falls into (the last band
 *  whose floor it clears). */
export function heatBandIndex(t: number): number {
  let idx = 0;
  for (let i = 0; i < HEAT_BANDS.length; i++) {
    if (t >= HEAT_BANDS[i].min) idx = i;
  }
  return idx;
}

/** Paint one grid as translucent cell rects under everything else the
 *  renderer draws. Cells are batched per colour band (96×96 cells at the
 *  board's frame rate would otherwise pay a fillStyle change each), padded
 *  a hair so adjacent cells leave no antialiased seam. No-op for absent or
 *  empty data. */
export function drawHeatOverlay(
  ctx: CanvasRenderingContext2D,
  data: HeatOverlayData,
  kind: HeatLayerKind,
  proj: HeatProjection,
): void {
  const grid = data[kind];
  if (!grid) return;
  const rows = grid.grid.length;
  const cols = rows > 0 ? grid.grid[0].length : 0;
  const max = gridMax(grid.grid);
  if (rows === 0 || cols === 0 || max <= 0) return;
  const bandRects: { x: number; y: number; w: number; h: number }[][] = HEAT_BANDS.map(() => []);
  for (let iz = 0; iz < rows; iz++) {
    const row = grid.grid[iz];
    const width = Math.min(cols, row.length);
    for (let ix = 0; ix < width; ix++) {
      const n = row[ix];
      if (!(n > 0)) continue;
      const r = heatCellWorldRect(grid.bounds, cols, rows, ix, iz);
      // Project the rect's two world corners: the projection aspect-fits
      // and flips z onto y (makeProjection), so min/max normalize here.
      const a = proj.toPx({ x: r.minX, z: r.minZ });
      const b = proj.toPx({ x: r.maxX, z: r.maxZ });
      const pad = 0.35;
      bandRects[heatBandIndex(n / max)].push({
        x: Math.min(a.x, b.x) - pad,
        y: Math.min(a.y, b.y) - pad,
        w: Math.abs(b.x - a.x) + pad * 2,
        h: Math.abs(b.y - a.y) + pad * 2,
      });
    }
  }
  for (let i = 0; i < HEAT_BANDS.length; i++) {
    const list = bandRects[i];
    if (list.length === 0) continue;
    ctx.fillStyle = HEAT_BANDS[i].color;
    ctx.beginPath();
    for (const q of list) ctx.rect(q.x, q.y, q.w, q.h);
    ctx.fill();
  }
}
