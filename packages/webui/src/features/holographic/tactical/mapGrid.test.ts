import { describe, expect, it } from "vitest";
import {
  gridLabelLayout,
  gridLabelLayoutForView,
  MAP_GRID_COLUMNS,
} from "./mapGrid";

describe("gridLabelLayout", () => {
  it("at zero rotation: letters across the top in order, numbers down the left", () => {
    const { top, left } = gridLabelLayout(0, 760);
    expect(top.map((l) => l.text)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    expect(left.map((l) => l.text)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    // evenly spaced cell centres, top edge y≈0
    expect(top[0].x).toBeCloseTo(38, 5);
    expect(top[1].x - top[0].x).toBeCloseTo(76, 5);
    expect(top.every((l) => l.y === 0)).toBe(true);
    expect(left.every((l) => l.x === 0)).toBe(true);
    expect(left[0].y).toBeCloseTo(38, 5);
  });

  it("at 90° the families swap strips while both stay upright", () => {
    const { top, left } = gridLabelLayout(Math.PI / 2, 760);
    expect(top.map((l) => l.text)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(left.map((l) => l.text)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
  });

  it("at 180° letters stay on the top strip with mirrored positions", () => {
    const { top, left } = gridLabelLayout(Math.PI, 760);
    expect(top.map((l) => l.text)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    // The whole grid spun 180°: A's column now sits on the screen right.
    expect(top[0].x).toBeCloseTo(722, 0);
    expect(top[9].x).toBeCloseTo(38, 0);
    expect(left[0]).toEqual({ text: "1", x: 0, y: expect.closeTo(722, 0) });
    expect(left[9]).toEqual({ text: "10", x: 0, y: expect.closeTo(38, 0) });
  });

  it("every label sits inside the canvas with a margin at odd angles", () => {
    for (const deg of [15, 30, 45, 60, 75, 105, 135, 170]) {
      const { top, left } = gridLabelLayout((deg * Math.PI) / 180, 760);
      for (const l of [...top, ...left]) {
        expect(l.x).toBeGreaterThanOrEqual(0);
        expect(l.x).toBeLessThanOrEqual(760);
        expect(l.y).toBeGreaterThanOrEqual(0);
        expect(l.y).toBeLessThanOrEqual(760);
      }
      expect(top.length + left.length).toBeGreaterThan(0);
    }
  });

  it("labels beyond the canvas at steep angles are dropped, not clamped into a pile", () => {
    const { top } = gridLabelLayout(Math.PI / 3, 760); // 60°
    const xs = top.map((l) => l.x);
    expect(new Set(xs).size).toBe(xs.length);
    expect(top.length).toBeLessThan(MAP_GRID_COLUMNS);
  });
});

describe("gridLabelLayoutForView", () => {
  it("full-map centres reproduce the fixed scale-1 layout", () => {
    const cell = 760 / MAP_GRID_COLUMNS;
    const fixed = gridLabelLayout(0, 760);
    const projected = gridLabelLayoutForView(
      0,
      760,
      Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => (i + 0.5) * cell),
      Array.from({ length: MAP_GRID_COLUMNS }, (_, j) => (j + 0.5) * cell),
    );
    expect(projected).toEqual(fixed);
  });

  it("zoom spreads the labels with their squares — only on-canvas ones stay", () => {
    // 2× zoom on the map centre: cell centres become (i+0.5)·152 − 380.
    const cols = Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => (i + 0.5) * 152 - 380);
    const rows = [...cols];
    const { top, left } = gridLabelLayoutForView(0, 760, cols, rows);
    // On-canvas [margin, 760−margin] = centres 152..608 → squares D..G.
    expect(top.map((l) => l.text)).toEqual(["D", "E", "F", "G"]);
    expect(top[0].x).toBeCloseTo(152, 5);
    expect(top[3].x).toBeCloseTo(608, 5);
    expect(left.map((l) => l.text)).toEqual(["4", "5", "6", "7"]);
    expect(top.every((l) => !l.clamped)).toBe(true);
  });

  it("pan moves the labels with their squares", () => {
    const cols = Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => (i + 0.5) * 76);
    const shifted = gridLabelLayoutForView(0, 760, cols.map((x) => x - 100), cols);
    // Every square slid left by 100px: A's centre (-62) left the canvas, B
    // landed exactly on the margin, and the survivors keep their order.
    expect(shifted.top.map((l) => l.text)).toEqual([
      "B", "C", "D", "E", "F", "G", "H", "I", "J",
    ]);
    expect(shifted.top[0].x).toBeCloseTo(114 - 100, 5); // B rode its square
  });

  it("deep zoom keeps one clamped label per strip, at the nearest end", () => {
    // Every column centre far past the right edge, every row on-canvas.
    const cols = Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => 900 + i * 100);
    const rows = Array.from({ length: MAP_GRID_COLUMNS }, (_, j) => (j + 0.5) * 76);
    const { top, left } = gridLabelLayoutForView(0, 760, cols, rows);
    expect(top).toHaveLength(1);
    expect(top[0].clamped).toBe(true);
    expect(top[0].text).toBe("A"); // nearest to the canvas
    expect(top[0].x).toBe(760 - 14); // pinned at the strip end
    expect(left).toHaveLength(10); // the rows were never off-canvas
    expect(left.every((l) => !l.clamped)).toBe(true);
  });

  it("row numbering contract — callers count row centres off maxZ (row 1 = north)", () => {
    // Mirrors PlanStage/HolographicMap's projection (gz(z) = (maxZ−z)/H·size,
    // row j's centre z = maxZ − H·(j+0.5)/10). Counting off minZ instead
    // would put "1" on the southern band and mirror every reported
    // coordinate.
    const cell = 760 / MAP_GRID_COLUMNS;
    const gz = (z: number): number => ((1000 - z) / 1000) * 760; // maxZ = 1000
    const rowYs = Array.from(
      { length: MAP_GRID_COLUMNS },
      (_, j) => gz(1000 - (1000 * (j + 0.5)) / MAP_GRID_COLUMNS),
    );
    const { left } = gridLabelLayoutForView(
      0,
      760,
      Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => (i + 0.5) * cell),
      rowYs,
    );
    expect(left.map((l) => l.text)).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
    ]);
    expect(left[0].y).toBeCloseTo(cell / 2, 5); // row 1 on the NORTHERN band
  });

  it("steep rotation + deep zoom still keeps a label on each ruler", () => {
    // At 45° a column/row line crosses the top/left edge only from a narrow
    // band; pushed far off-canvas by zoom NONE crosses, so the endpoint
    // fallback must pin the nearest square instead of a blank ruler.
    const far = Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => 2000 + i * 300);
    const { top, left } = gridLabelLayoutForView(Math.PI / 4, 760, far, far);
    expect(top).toHaveLength(1);
    expect(top[0].clamped).toBe(true);
    expect(top[0].text).toBe("A");
    expect(left).toHaveLength(1);
    expect(left[0].clamped).toBe(true);
    expect(left[0].text).toBe("1");
  });
});
