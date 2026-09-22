import { describe, expect, it } from "vitest";
import { gridLabelLayout, MAP_GRID_COLUMNS } from "./mapGrid";

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
