import { describe, expect, it } from "vitest";
import { gridEdgeLabels, MAP_GRID_COLUMNS } from "./mapGrid";

describe("gridEdgeLabels", () => {
  it("full-map centres: letters across the top, numbers down the left", () => {
    const cell = 760 / MAP_GRID_COLUMNS;
    const { top, left } = gridEdgeLabels(
      760,
      Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => (i + 0.5) * cell),
      Array.from({ length: MAP_GRID_COLUMNS }, (_, j) => (j + 0.5) * cell),
    );
    expect(top.map((l) => l.text)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    expect(left.map((l) => l.text)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(top[0].x).toBeCloseTo(cell / 2, 5);
    expect(left[0].y).toBeCloseTo(cell / 2, 5);
    expect(top.every((l) => !l.clamped)).toBe(true);
  });

  it("zoom spreads the labels with their squares — only on-canvas ones stay", () => {
    // 2× zoom on the map centre: cell centres become (i+0.5)·152 − 380.
    const cols = Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => (i + 0.5) * 152 - 380);
    const { top, left } = gridEdgeLabels(760, cols, cols);
    // On-canvas [margin, 760−margin] = centres 152..608 → squares D..G / 4..7.
    expect(top.map((l) => l.text)).toEqual(["D", "E", "F", "G"]);
    expect(top[0].x).toBeCloseTo(152, 5);
    expect(top[3].x).toBeCloseTo(608, 5);
    expect(left.map((l) => l.text)).toEqual(["4", "5", "6", "7"]);
  });

  it("pan moves the labels with their squares", () => {
    const cols = Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => (i + 0.5) * 76);
    const { top } = gridEdgeLabels(
      760,
      cols.map((x) => x - 100),
      cols,
    );
    // Every square slid left by 100px: A's centre (-62) left the canvas, B
    // landed exactly on the margin, and the survivors keep their order.
    expect(top.map((l) => l.text)).toEqual(["B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    expect(top[0].x).toBeCloseTo(114 - 100, 5); // B rode its square
  });

  it("deep zoom keeps one clamped label per strip, at the nearest end", () => {
    // Every column centre far past the right edge, every row on-canvas.
    const cols = Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => 900 + i * 100);
    const rows = Array.from({ length: MAP_GRID_COLUMNS }, (_, j) => (j + 0.5) * 76);
    const { top, left } = gridEdgeLabels(760, cols, rows);
    expect(top).toHaveLength(1);
    expect(top[0].clamped).toBe(true);
    expect(top[0].text).toBe("A"); // nearest to the canvas
    expect(top[0].x).toBe(760 - 14); // pinned at the strip end
    expect(left).toHaveLength(10); // the rows were never off-canvas
    expect(left.every((l) => !l.clamped)).toBe(true);
  });

  it("deep zoom from the west pins the nearest label at the LEFT end", () => {
    const cols = Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => -900 + i * 100);
    const rows = Array.from({ length: MAP_GRID_COLUMNS }, () => 380);
    const { top } = gridEdgeLabels(760, cols, rows);
    expect(top).toHaveLength(1);
    expect(top[0].text).toBe("J"); // -100 is the closest centre to the canvas
    expect(top[0].x).toBe(14);
    expect(top[0].clamped).toBe(true);
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
    const { left } = gridEdgeLabels(
      760,
      Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => (i + 0.5) * cell),
      rowYs,
    );
    expect(left.map((l) => l.text)).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
    ]);
    expect(left[0].y).toBeCloseTo(cell / 2, 5); // row 1 on the NORTHERN band
  });

  it("90° map rotation swaps the strips: letters down the left, numbers across the top", () => {
    const cell = 760 / MAP_GRID_COLUMNS;
    const cols = Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => (i + 0.5) * cell);
    const rows = Array.from({ length: MAP_GRID_COLUMNS }, (_, j) => (j + 0.5) * cell);
    const { top, left } = gridEdgeLabels(760, cols, rows, Math.PI / 2);
    expect(left.map((l) => l.text)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    expect(top.map((l) => l.text)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    // A clockwise quarter-turn carries the west edge to the top: column A's
    // line now runs horizontally near the top, so its label sits high on
    // the left strip; row 1 (north) lands by the right edge.
    expect(left[0].y).toBeCloseTo(cell / 2, 5);
    expect(top[0].x).toBeCloseTo(760 - cell / 2, 5);
  });

  it("270° map rotation swaps the strips the other way round", () => {
    const cell = 760 / MAP_GRID_COLUMNS;
    const cols = Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => (i + 0.5) * cell);
    const rows = Array.from({ length: MAP_GRID_COLUMNS }, (_, j) => (j + 0.5) * cell);
    const { top, left } = gridEdgeLabels(760, cols, rows, (3 * Math.PI) / 2);
    expect(left.map((l) => l.text)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    expect(top.map((l) => l.text)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    // Counter-clockwise: the west edge goes to the bottom, north to the left.
    expect(left[0].y).toBeCloseTo(760 - cell / 2, 5);
    expect(top[0].x).toBeCloseTo(cell / 2, 5);
  });

  it("180° keeps the strips but reverses each family's positions", () => {
    const cell = 760 / MAP_GRID_COLUMNS;
    const cols = Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => (i + 0.5) * cell);
    const rows = Array.from({ length: MAP_GRID_COLUMNS }, (_, j) => (j + 0.5) * cell);
    const { top, left } = gridEdgeLabels(760, cols, rows, Math.PI);
    // Insertion order stays A..J / 1..10; the POSITIONS flip with the map.
    expect(top.map((l) => l.text)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    expect(left.map((l) => l.text)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(top[0].x).toBeCloseTo(760 - cell / 2, 5); // A now on the right
    expect(top[9].x).toBeCloseTo(cell / 2, 5);
    expect(left[0].y).toBeCloseTo(760 - cell / 2, 5); // row 1 now at the bottom
  });
});
