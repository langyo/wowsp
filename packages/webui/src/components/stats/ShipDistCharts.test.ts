/** Column math for the DOM pie legends: chunkLegendItems must be pure,
 *  order-preserving and fully deterministic — the number of columns a
 *  donut's legend shows depends only on it (5 rows per column: 6 ship
 *  types → 5+1 over two columns, 14 nations → 5+5+4 over three). */
import { describe, expect, it } from "vitest";

import { chunkLegendItems } from "./ShipDistCharts";

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
