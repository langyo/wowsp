import { describe, expect, it } from "vitest";

import { statCellOrigins } from "./shotKit";

/** A canvas stand-in whose measureText is deterministic: every glyph is
 *  6px wide. Only measureText is on statCellOrigins' critical path. */
const fakeCtx = {
  measureText: (s: string) => ({ width: s.length * 6 }),
} as unknown as CanvasRenderingContext2D;

/** Column widths implied by the fake measure for a cell matrix. */
function colWidths(cells: string[][]): number[] {
  const widths: number[] = [];
  for (let i = 0; i < Math.max(0, ...cells.map((c) => c.length)); i++) {
    widths.push(Math.max(...cells.map((row) => (row[i] ?? "").length)) * 6);
  }
  return widths;
}

describe("statCellOrigins", () => {
  // The stats card's real-world failure shape: a narrow battles column
  // under a wide winrate column ("3" vs "100.0%").
  const CELLS = [
    ["3", "100.0%", "1234", "1.23"],
    ["12", "48.2%", "98,432", "0.98"],
  ];
  const GAP = 10;

  it("returns each column's RIGHT edge, so right-aligned cells never overlap", () => {
    const origins = statCellOrigins(fakeCtx, CELLS, GAP);
    const widths = colWidths(CELLS);
    expect(origins).toEqual([12, 58, 104, 138]);
    // Non-overlap invariant: every column's left edge clears the previous
    // column's right edge by at least the gap — the exact property whose
    // absence made the poster's battles and winrate columns print on top
    // of each other.
    for (let i = 1; i < origins.length; i++) {
      expect(origins[i] - widths[i]).toBeGreaterThanOrEqual(origins[i - 1] + GAP);
    }
  });

  it("ends at the whole block's width (the callers' trailing-space base)", () => {
    const origins = statCellOrigins(fakeCtx, CELLS, GAP);
    const widths = colWidths(CELLS);
    const total = widths.reduce((s, w) => s + w, 0) + GAP * (widths.length - 1);
    expect(origins[origins.length - 1]).toBe(total);
  });

  it("keeps ragged rows (short rows miss trailing cells) and empty input", () => {
    expect(statCellOrigins(fakeCtx, [["3", "100.0%"], ["12"]], GAP)).toEqual([12, 58]);
    expect(statCellOrigins(fakeCtx, [], GAP)).toEqual([]);
  });
});
