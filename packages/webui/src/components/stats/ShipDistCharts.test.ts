/** Column math + SVG geometry for the ship-distribution charts.
 *  chunkLegendItems must be pure, order-preserving and fully deterministic
 *  — the number of columns a donut's legend shows depends only on it (5
 *  rows per column: 6 ship types → 5+1 over two columns, 14 nations →
 *  5+5+4 over three). donutSlices / tierBars generate the hand-drawn SVG
 *  paths, so their angle math, radii, layout and the degenerate
 *  full-circle arc all carry exact-string coverage here; the percentInt
 *  tests pin the legend-hint/tooltip integer agreement against double
 *  rounding (legend rows show no percent text — percents live in the
 *  hover hint only). */
import { describe, expect, it } from "vitest";

import { t } from "@/i18n";
import {
  chunkLegendItems,
  donutSlices,
  sliceHint,
  tierBars,
  toLegendItems,
} from "./ShipDistCharts";

/** Shorthand: the per-column item counts for a chunking run. */
function shape(items: number[], size: number): number[] {
  return chunkLegendItems(items, size).map((col) => col.length);
}

describe("chunkLegendItems", () => {
  it("returns no columns for an empty legend", () => {
    expect(chunkLegendItems([], 5)).toEqual([]);
  });

  it("keeps up to `size` items in a single column", () => {
    expect(chunkLegendItems(["a"], 5)).toEqual([["a"]]);
    expect(chunkLegendItems([1, 2, 3, 4, 5], 5)).toEqual([[1, 2, 3, 4, 5]]);
  });

  it("spills overflow into further columns of the same height", () => {
    // 6 ship types → 2 columns.
    expect(chunkLegendItems([1, 2, 3, 4, 5, 6], 5)).toEqual([
      [1, 2, 3, 4, 5],
      [6],
    ]);
    // 14 nations → 3 columns.
    expect(shape(Array.from({ length: 14 }, (_, i) => i), 5)).toEqual([5, 5, 4]);
  });

  it("fills columns top-to-bottom in input order", () => {
    const columns = chunkLegendItems(["a", "b", "c", "d", "e", "f", "g"], 3);
    expect(columns).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
      ["g"],
    ]);
  });

  it("clamps a non-positive column size to one row per column", () => {
    expect(chunkLegendItems(["a", "b"], 0)).toEqual([["a"], ["b"]]);
    expect(chunkLegendItems(["a", "b"], -3)).toEqual([["a"], ["b"]]);
  });
});

/** Identity label/color resolvers so passthrough is observable. */
const identity = {
  labelOf: (code: string) => `L(${code})`,
  colorOf: (code: string) => `C(${code})`,
};

describe("donutSlices", () => {
  it("returns no slices for empty or all-zero input", () => {
    expect(donutSlices([], identity)).toEqual([]);
    expect(
      donutSlices(
        [
          ["a", 0],
          ["b", -3],
        ],
        identity,
      ),
    ).toEqual([]);
  });

  it("drops non-positive entries but keeps the share base consistent", () => {
    // 0/-3 filtered; 75/25 of the SHOWN sum.
    const slices = donutSlices(
      [
        ["a", 75],
        ["b", 25],
        ["dead", 0],
      ],
      identity,
    );
    expect(slices.map((s) => s.percent)).toEqual([75, 25]);
  });

  it("starts at 12 o'clock and lays slices out clockwise", () => {
    // 150 viewBox → center (75,75), outer 51, inner 30. First slice 75%
    // sweeps 270°: M at the top point, large-arc flag set, and the outer
    // arc lands on the LEFT extreme (angle -90+270 = 180°).
    const [big, small] = donutSlices(
      [
        ["a", 75],
        ["b", 25],
      ],
      identity,
    );
    expect(big!.path).toBe(
      "M 75 24 A 51 51 0 1 1 24 75 L 45 75 A 30 30 0 1 0 75 45 Z",
    );
    // The 25% slice starts exactly where the big one ended (left extreme)
    // and its 90° small arc closes the ring back at the 12 o'clock point.
    expect(small!.path).toBe(
      "M 24 75 A 51 51 0 0 1 75 24 L 75 45 A 30 30 0 0 0 45 75 Z",
    );
  });

  it("passes code/label/value/fill through", () => {
    const slices = donutSlices([["cruiser", 10]], identity);
    expect(slices[0]).toMatchObject({
      code: "cruiser",
      label: "L(cruiser)",
      value: 10,
      percent: 100,
      percentInt: 100,
      fill: "C(cruiser)",
    });
  });

  it("rounds percents to two decimals", () => {
    const slices = donutSlices(
      [
        ["a", 1],
        ["b", 2],
      ],
      identity,
    );
    expect(slices.map((s) => s.percent)).toEqual([33.33, 66.67]);
    expect(slices.map((s) => s.percentInt)).toEqual([33, 67]);
  });

  it("keeps percents out of legend text and reuses sliceHint verbatim", () => {
    // 33496/100000 = 33.496%: the 2-decimal display value is 33.5, so
    // re-rounding IT would show 34 while the raw share rounds to 33.
    // percentInt is rounded once from the raw share; legend rows carry NO
    // percent text — the row's hover hint IS sliceHint, the exact string
    // the slice tooltip renders.
    expect(toLegendItems([])).toEqual([]);
    const slices = donutSlices(
      [
        ["a", 33496],
        ["b", 66504],
      ],
      identity,
    );
    expect(slices[0]!.percent).toBe(33.5);
    expect(slices[0]!.percentInt).toBe(33);
    const [legendItem] = toLegendItems(slices);
    expect(legendItem!.text).toBe("L(a)");
    expect(legendItem!.text).not.toContain("33");
    // Expected hint built with the SAME t() so the assertion holds whether
    // or not another test already loaded the locale messages.
    expect(legendItem!.hint).toBe(`L(a) · ${t("stats.dist.battles")} 33496 · 33%`);
    expect(sliceHint(slices[0]!)).toBe(legendItem!.hint);
  });

  it("honors custom viewBox and radii", () => {
    const slices = donutSlices([["a", 60], ["b", 40]], {
      ...identity,
      viewBox: 200,
      outerR: 90,
      innerR: 50,
    });
    // Center (100,100): top point at 100-90, first sweep 216° → large arc.
    expect(slices[0]!.path).toContain("M 100 10 A 90 90 0 1 1 ");
    expect(slices[0]!.path).toContain("A 50 50 0 1 0 ");
  });

  it("draws a 100% slice as two 180° half-arcs, not a degenerate arc", () => {
    const [slice] = donutSlices([["only", 42]], identity);
    // A single 360° arc would have start == end and render nothing; the
    // ring is split at 0°/180° into two well-formed subpaths.
    const subpaths = slice!.path.split("M ").filter(Boolean);
    expect(subpaths).toHaveLength(2);
    // Right extreme → left extreme (bottom half), then left → right (top
    // half): both outer arcs sweep clockwise, both inner arcs sweep back.
    expect(slice!.path).toBe(
      "M 126 75 A 51 51 0 0 1 24 75 L 45 75 A 30 30 0 0 0 105 75 Z " +
        "M 24 75 A 51 51 0 0 1 126 75 L 105 75 A 30 30 0 0 0 45 75 Z",
    );
    // No zero-length arc: every arc endpoint pair differs.
    expect(slice!.path).not.toMatch(/A (\d+) (\d+) 0 [01] 1 (\d+) \3 /);
  });
});

describe("tierBars", () => {
  // Default frame: 320×150, side pad 8, top pad 22, baseline y=132, tier
  // numbers at y=144 → plot height 110, ten 30.4-unit slots.
  const VALUES = [0, 5, 10, 0, 0, 0, 0, 0, 0, 0];

  it("always returns one slot per tier, evenly spaced and in order", () => {
    const { bars } = tierBars(VALUES);
    expect(bars.map((b) => b.tier)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(bars[0]!.centerX).toBe(23.2); // 8 + 30.4 × 0.5
    const step = bars[1]!.centerX - bars[0]!.centerX;
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i]!.centerX - bars[i - 1]!.centerX).toBeCloseTo(step, 10);
    }
    expect(step).toBeCloseTo(30.4, 10);
  });

  it("exposes the axis baseline frame", () => {
    const layout = tierBars(VALUES);
    expect(layout).toMatchObject({
      width: 320,
      height: 150,
      baselineY: 132,
      axisFrom: 8,
      axisTo: 312,
      tierLabelY: 144,
    });
  });

  it("scales bar heights against the maximum bin", () => {
    const { bars } = tierBars(VALUES);
    expect(bars[2]!.barHeight).toBe(110); // max bin fills the plot
    expect(bars[1]!.barHeight).toBe(55); // half
    expect(bars[0]!.barHeight).toBe(0); // empty bin
  });

  it("rounds only the top corners and anchors at the baseline", () => {
    const { bars } = tierBars(VALUES);
    // Tier 3 (max): centered at 84, bar 12 wide, top at y=22, rx=2.
    expect(bars[2]!.path).toBe(
      "M 78 132 L 78 24 Q 78 22 80 22 L 88 22 Q 90 22 90 24 L 90 132 Z",
    );
    // Tier 2 (half height): same width, top at y=77.
    expect(bars[1]!.path).toBe(
      "M 47.6 132 L 47.6 79 Q 47.6 77 49.6 77 L 57.6 77 Q 59.6 77 59.6 79 L 59.6 132 Z",
    );
  });

  it("empty bins carry no bar path and no value label", () => {
    const { bars } = tierBars(VALUES);
    expect(bars[0]!.path).toBe("");
    expect(bars[0]!.labelY).toBeNull();
    // Nonzero bins sit their label above the bar top.
    expect(bars[2]!.labelY).toBe(17); // top 22 − 5
    expect(bars[1]!.labelY).toBe(72); // top 77 − 5
  });

  it("keeps the fixed bar width clamped to the slot width", () => {
    // 40 tiers on the 320 box → 7.6-unit slots shrink the 12-unit bar.
    const { bars } = tierBars(new Array(40).fill(1));
    expect(bars[0]!.barWidth).toBeCloseTo(7.6, 10);
    // Default case: slots are 30.4 wide, so the 12-unit bar survives.
    expect(tierBars(VALUES).bars[0]!.barWidth).toBe(12);
  });

  it("renders all-zero data without dividing by zero", () => {
    const { bars } = tierBars(new Array(10).fill(0));
    expect(bars.every((b) => b.path === "" && b.labelY === null)).toBe(true);
    expect(bars.every((b) => Number.isFinite(b.centerX))).toBe(true);
  });

  it("treats a NaN bin (and the max it poisons) as empty, never NaN geometry", () => {
    const { bars } = tierBars([NaN, 5, 10, 0, 0, 0, 0, 0, 0, 0]);
    expect(bars.every((b) => b.path === "" && b.labelY === null)).toBe(true);
    expect(bars.every((b) => Number.isFinite(b.centerX))).toBe(true);
  });

  it("honors custom width/height/barWidth", () => {
    const { bars, baselineY, axisTo } = tierBars([4, 2], {
      width: 100,
      height: 60,
      barWidth: 5,
    });
    expect(baselineY).toBe(42); // 60 − 18
    expect(axisTo).toBe(92); // 100 − 8
    expect(bars[0]!.centerX).toBe(29); // 8 + 42 × 0.5
    expect(bars[0]!.barWidth).toBe(5);
    expect(bars[0]!.barHeight).toBe(20); // (60−18−22) × 1.0
  });
});
