/** Corpus heat-overlay tests: resolution against the insights doc (mode-key
 *  alignment + case tolerance + absent-data no-ops), normalization, and the
 *  cell→world→screen math — the orientation fixtures mirror the generator's
 *  own grid tests (replay-corpus lib.rs) so a serialization flip would fail
 * here, not on the board. Pure — no DOM. */
import { describe, expect, it } from "vitest";

import { fakeAs } from "@/test-utils/fakes";
import type { InsightsHeatGrid, MapInsightsDoc } from "../insightsLoader";
import {
  drawHeatOverlay,
  gridMax,
  heatBandIndex,
  heatCellWorldRect,
  resolveHeatOverlay,
  type HeatOverlayData,
  type HeatProjection,
} from "./heatLayer";

/** 96×96 zero grid (GRID_SIDE, the corpus contract). */
function zeroGrid(): number[][] {
  return Array.from({ length: 96 }, () => Array.from({ length: 96 }, () => 0));
}

function heat(bounds: [number, number, number, number], grid: number[][]): InsightsHeatGrid {
  return { bounds, grid };
}

function docOf(maps: Record<string, { modes: Record<string, unknown> }>): MapInsightsDoc {
  return { version: 1, generatedAt: "2026-10-14T00:00:00Z", unparsed: 0, maps: maps as never };
}

/** Projection mirroring render.ts's makeProjection (z flips onto y, aspect
 *  irrelevant for square bounds). */
function projOf(bounds: [number, number, number, number], size = 96): HeatProjection {
  const [minX, minZ, maxX, maxZ] = bounds;
  const w = maxX - minX || 1;
  const h = maxZ - minZ || 1;
  return {
    toPx: (p) => ({ x: ((p.x - minX) / w) * size, y: ((maxZ - p.z) / h) * size }),
  };
}

interface HeatPaint {
  color: string;
  rects: number[][];
}

/** Recording 2D-context stub: one paint per beginPath/rect…/fill round. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; paints: HeatPaint[] } {
  const paints: HeatPaint[] = [];
  let cur: number[][] = [];
  const ctx = fakeAs<CanvasRenderingContext2D>({
    fillStyle: "",
    beginPath: () => {
      cur = [];
    },
    rect: (x: number, y: number, w: number, h: number) => cur.push([x, y, w, h]),
    fill: () => paints.push({ color: String(ctx.fillStyle), rects: cur }),
  });
  return { ctx, paints };
}

function flatRect(r: number[]): { x: number; y: number; w: number; h: number } {
  return { x: r[0], y: r[1], w: r[2], h: r[3] };
}

// ── resolution ───────────────────────────────────────────────────────────

describe("resolveHeatOverlay", () => {
  const grid = zeroGrid();
  grid[0][0] = 3;
  const full = heat([0, 0, 960, 960], grid);
  const rankedGrid = zeroGrid();
  rankedGrid[95][0] = 1;
  const rankedHeat = heat([-960, -960, 0, 0], rankedGrid);
  const corpus = docOf({
    "20_NE_two_brothers": {
      modes: {
        pvp: { battleCount: 12, capsSample: 12, caps: [], spawnHeat: full, trackHeat: full },
        ranked: { battleCount: 4, capsSample: 4, caps: [], spawnHeat: rankedHeat },
      },
    },
  });

  it("maps a template preset id onto the corpus match-group row", () => {
    const out = resolveHeatOverlay(corpus, "20_NE_two_brothers", "random-4", null);
    expect(out).not.toBeNull();
    expect(out!.battleCount).toBe(12);
    expect(out!.spawn).toBe(full);
    expect(out!.track).toBe(full);
  });

  it("prefers the applied learned layout's raw match-group", () => {
    const out = resolveHeatOverlay(corpus, "20_NE_two_brothers", null, "ranked");
    expect(out).not.toBeNull();
    expect(out!.battleCount).toBe(4);
    expect(out!.spawn).toBe(rankedHeat);
    expect(out!.track).toBeNull();
  });

  it("resolves map ids case-tolerantly with a spaces/ prefix", () => {
    const pvp = resolveHeatOverlay(corpus, "spaces/20_NE_TWO_BROTHERS", "random-1", null);
    expect(pvp).not.toBeNull();
    expect(pvp!.battleCount).toBe(12);
  });

  it("is a no-op for absent doc, unknown map, unset mode, unknown preset and uncovered mode", () => {
    expect(resolveHeatOverlay(null, "20_NE_two_brothers", "random-4", null)).toBeNull();
    expect(resolveHeatOverlay(corpus, "00_CO_ocean", "random-4", null)).toBeNull();
    expect(resolveHeatOverlay(corpus, "20_NE_two_brothers", null, null)).toBeNull();
    expect(resolveHeatOverlay(corpus, "20_NE_two_brothers", "sandbox-3", null)).toBeNull();
    expect(resolveHeatOverlay(corpus, "20_NE_two_brothers", "random-4", "brawl")).toBeNull();
  });

  it("keeps whichever grid is drawable and drops absent or all-zero ones", () => {
    const spawnOnly = zeroGrid();
    spawnOnly[10][10] = 7;
    const trackZero = heat([0, 0, 1, 1], zeroGrid());
    const doc = docOf({
      map: { modes: { pvp: { battleCount: 2, capsSample: 2, caps: [], spawnHeat: heat([0, 0, 1, 1], spawnOnly), trackHeat: trackZero } } },
    });
    const out = resolveHeatOverlay(doc, "map", "random-2", null);
    expect(out).not.toBeNull();
    expect(out!.spawn).not.toBeNull();
    expect(out!.track).toBeNull();
  });

  it("yields null for the bundled lite doc (no heat keys at all)", () => {
    const lite = docOf({ map: { modes: { pvp: { battleCount: 5, capsSample: 5, caps: [] } } } });
    expect(resolveHeatOverlay(lite, "map", "random-4", null)).toBeNull();
  });
});

// ── normalization ────────────────────────────────────────────────────────

describe("normalization", () => {
  it("gridMax finds the largest cell", () => {
    const g = [
      [0, 1],
      [3, 2],
    ];
    expect(gridMax(g)).toBe(3);
    expect(gridMax(zeroGrid())).toBe(0);
  });

  it("heatBandIndex ramps monotonically with the intensity floor", () => {
    expect(heatBandIndex(0)).toBe(0);
    expect(heatBandIndex(0.19)).toBe(0);
    expect(heatBandIndex(0.2)).toBe(1);
    expect(heatBandIndex(0.5)).toBe(2);
    expect(heatBandIndex(0.59)).toBe(2);
    expect(heatBandIndex(0.79)).toBe(3);
    expect(heatBandIndex(0.8)).toBe(4); // the orange band floor
    expect(heatBandIndex(1)).toBe(5);
    for (let t = 0; t <= 1; t += 0.05) {
      expect(heatBandIndex(t + 0.1)).toBeGreaterThanOrEqual(heatBandIndex(t));
    }
  });
});

// ── cell → world math ────────────────────────────────────────────────────

describe("heatCellWorldRect", () => {
  it("inverts the generator's binning over known bounds", () => {
    // 96 cells over [0, 960]: one cell spans exactly 10 world units.
    const r = heatCellWorldRect([0, 0, 960, 960], 96, 96, 4, 7);
    expect(r.minX).toBeCloseTo(40, 10);
    expect(r.maxX).toBeCloseTo(50, 10);
    expect(r.minZ).toBeCloseTo(70, 10);
    expect(r.maxZ).toBeCloseTo(80, 10);
  });

  it("works off non-zero origins and non-square grids", () => {
    // 10 columns over [-100, 100] → 20 wide; 5 rows over [-50, 50] → 20 tall.
    const r = heatCellWorldRect([-100, -50, 100, 50], 10, 5, 2, 1);
    expect(r.minX).toBeCloseTo(-60, 10);
    expect(r.maxX).toBeCloseTo(-40, 10);
    expect(r.minZ).toBeCloseTo(-30, 10);
    expect(r.maxZ).toBeCloseTo(-10, 10);
  });
});

// ── drawing ──────────────────────────────────────────────────────────────

describe("drawHeatOverlay", () => {
  it("places generator-fixture cells on the right board corners (orientation)", () => {
    // The generator's own fixture (lib.rs heat_grid_accumulates_points_
    // into_cells): add(0,0) → grid[0][0]; add(1,1) twice → grid[95][95];
    // add(0.5,0.5) → grid[48][48]. Rows are z from minZ (south), columns
    // are x from minX (west) — through makeProjection's y-flip row 0 must
    // land at the BOTTOM of the canvas, column 0 on the LEFT.
    const grid = zeroGrid();
    grid[0][0] = 1;
    grid[48][48] = 1;
    grid[95][95] = 2;
    const data: HeatOverlayData = { battleCount: 1, spawn: heat([0, 0, 1, 1], grid), track: null };
    const { ctx, paints } = recordingCtx();
    drawHeatOverlay(ctx, data, "spawn", projOf([0, 0, 1, 1], 96));
    const rects = paints.flatMap((p) => p.rects.map(flatRect));
    expect(rects).toHaveLength(3);
    // Row 0, col 0 = south-west = bottom-left: one full cell at the corner.
    const sw = rects.find((q) => q.x < 1 && q.y > 94);
    expect(sw).toBeDefined();
    expect(sw!.w).toBeCloseTo(1 + 0.7, 6); // cell + hair pad both sides
    // Row 95, col 95 = north-east = top-right.
    const ne = rects.find((q) => q.x > 94 && q.y < 1);
    expect(ne).toBeDefined();
    // The centre cell straddles the middle (48/96 = 0.5).
    const mid = rects.find((q) => Math.abs(q.x - 48) < 2 && Math.abs(q.y - 48) < 2);
    expect(mid).toBeDefined();
  });

  it("groups cells into one fill per colour band", () => {
    const grid = [
      [100, 10],
      [0, 55],
    ];
    const data: HeatOverlayData = { battleCount: 1, spawn: null, track: heat([0, 0, 2, 2], grid) };
    const { ctx, paints } = recordingCtx();
    drawHeatOverlay(ctx, data, "track", projOf([0, 0, 2, 2], 100));
    // 100/100 → top band; 55/100 → the 0.4 band; 10/100 → the bottom band.
    expect(paints).toHaveLength(3);
    expect(paints.every((p) => p.rects.length === 1)).toBe(true);
    const colors = paints.map((p) => p.color);
    expect(new Set(colors).size).toBe(3);
  });

  it("is a no-op for an absent grid or an all-zero grid", () => {
    const data: HeatOverlayData = { battleCount: 1, spawn: null, track: heat([0, 0, 1, 1], zeroGrid()) };
    const a = recordingCtx();
    drawHeatOverlay(a.ctx, data, "spawn", projOf([0, 0, 1, 1])); // absent grid
    expect(a.paints).toHaveLength(0);
    const b = recordingCtx();
    drawHeatOverlay(b.ctx, data, "track", projOf([0, 0, 1, 1])); // max = 0
    expect(b.paints).toHaveLength(0);
  });
});
