import { describe, expect, it } from "vitest";
import { RING_KINDS, resolveSelfRings, metersToUnits, ringColorNum, ringLabelKm, RING_COLOR } from "./rangeRings";

describe("resolveSelfRings", () => {
  it("resolves a cruiser's stock set from the baked assets", () => {
    // 3267278288 = a real kit + live-stats entry: main 19 km, torp 8 km,
    // sec 7.3 km, det 15.8 km, radarM 12000, hydroM 5000.
    const rings = resolveSelfRings(3267278288);
    const byKind = new Map(rings.map((r) => [r.kind, r.meters]));
    expect(byKind.get("main")).toBe(19000);
    expect(byKind.get("torpedo")).toBe(8000);
    expect(byKind.get("radar")).toBe(12000);
    expect(byKind.get("hydro")).toBe(5000);
    expect(byKind.get("detect")).toBe(15800);
    // Order follows RING_KINDS for stable stacking.
    const ordered = rings.map((r) => r.kind).join(",");
    const canonical = RING_KINDS.filter((k) => byKind.has(k)).join(",");
    expect(ordered).toBe(canonical);
  });

  it("drops kinds the ship lacks", () => {
    const rings = resolveSelfRings(3248404240); // smoke-only kit entry
    expect(rings.map((r) => r.kind)).not.toContain("torpedo");
    expect(rings.map((r) => r.kind)).not.toContain("radar");
  });

  it("never emits the dynamic weather ring or unknown ships", () => {
    expect(resolveSelfRings(3267278288).some((r) => r.kind === "vis")).toBe(false);
    expect(resolveSelfRings(null)).toEqual([]);
    expect(resolveSelfRings(999999999999)).toEqual([]);
  });
});

describe("units and colours", () => {
  it("converts metres to world units (1 unit = 30 m)", () => {
    expect(metersToUnits(9000)).toBeCloseTo(300, 5);
    expect(metersToUnits(20700)).toBeCloseTo(690, 5);
  });

  it("keeps every ring colour distinct and parseable", () => {
    const colors = new Set(Object.values(RING_COLOR));
    expect(colors.size).toBe(RING_KINDS.length);
    for (const k of RING_KINDS) {
      expect(ringColorNum(k)).toBeGreaterThan(0);
    }
  });
});

describe("ringLabelKm", () => {
  it("formats km with one decimal, trimming .0", () => {
    expect(ringLabelKm(20700)).toBe("20.7");
    expect(ringLabelKm(8000)).toBe("8");
    expect(ringLabelKm(5870)).toBe("5.9");
  });
});
