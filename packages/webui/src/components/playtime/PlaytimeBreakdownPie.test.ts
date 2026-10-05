import { describe, expect, it } from "vitest";

import { CIRCUMFERENCE, DONUT, pieSliceGeom } from "./PlaytimeBreakdownPie";

/** C for reference: 2π·48 ≈ 301.59 stroke units (fmtN-trimmed everywhere). */
const C = CIRCUMFERENCE;
const PAD = DONUT.pad;

describe("pieSliceGeom", () => {
  it("draws a lone full slice as a closed ring without a self-seam", () => {
    const g = pieSliceGeom(C, 0, C, PAD);
    expect(g.dasharray).toBe(`${Math.round(C * 100) / 100} 0`);
    expect(g.dashoffset).toBe(0);
  });

  it("pads a 1% slice into a centered seam and keeps the dash positive", () => {
    // 1% of the turn ≈ 3.02 units — above the pad, so the padded shape
    // applies: dash = arc - pad, offset shifted pad/2 forward.
    const g = pieSliceGeom(C * 0.01, 0, C, PAD);
    expect(g.dasharray).toBe("1.52 300.08");
    expect(g.dashoffset).toBe(-0.75);
  });

  it("clamps the pad away from a sliver thinner than the seam", () => {
    // 0.4% of the turn ≈ 1.21 units — below the pad, which would collapse
    // the dash to zero length: draw unpadded, starting exactly at start.
    const start = C * 0.996;
    const g = pieSliceGeom(C * 0.004, start, C, PAD);
    expect(g.dasharray).toBe("1.21 300.39");
    expect(g.dashoffset).toBe(-300.39);
  });

  it("places a half-turn slice's seam centered on its start boundary", () => {
    const g = pieSliceGeom(C * 0.5, C * 0.5, C, PAD);
    expect(g.dasharray).toBe("149.3 152.3");
    expect(g.dashoffset).toBe(-151.55);
  });

  it("a dominant non-first slice keeps the padded path instead of overpainting earlier slivers", () => {
    // Tier order puts a 99.7% bucket LAST (T1..T11 asc); the closed-ring
    // case must not fire there — it would cover the T1/T2 slivers.
    const s1 = pieSliceGeom(0.00664 * C, 0, C, PAD); // T1 sliver
    const s2 = pieSliceGeom(0.00332 * C, 0.00664 * C, C, PAD); // T2 sliver
    const s5 = pieSliceGeom(0.99668 * C, 0.01328 * C, C, PAD); // T5 dominant
    expect(s5.dashoffset).toBeLessThan(0); // not the closed ring's offset 0
    expect(parseFloat(s5.dasharray)).toBeGreaterThan(C * 0.99); // its full arc, seam-padded
    expect(s1.dasharray).not.toBe(`${Math.round(C * 100) / 100} 0`);
    expect(s2.dashoffset).toBeLessThan(0);
  });
});
