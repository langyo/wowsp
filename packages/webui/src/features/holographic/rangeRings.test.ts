import { describe, expect, it } from "vitest";
import {
  RING_KINDS,
  resolveSelfRings,
  metersToUnits,
  ringColorNum,
  ringLabelKm,
  RING_COLOR,
  selfSpotterActive,
  selfInSmoke,
  animatedRingMeters,
  resetRingAnim,
} from "./rangeRings";

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

describe("selfSpotterActive", () => {
  // 4293328880 = PAAS001_Vought_OS2U (type "scout" in plane_types.json).
  const SCOUT = 4293328880;
  const DIVE = 4283400176; // any non-scout type
  const adds = [
    { time: 144.8, planeId: 101, ownerId: 7, paramsId: SCOUT },
    { time: 300, planeId: 202, ownerId: 9, paramsId: SCOUT },
    { time: 310, planeId: 303, ownerId: 7, paramsId: DIVE },
  ];
  const removes = [{ time: 261.5, planeId: 101 }];

  it("is active only inside the own scout's launch-to-remove window", () => {
    expect(selfSpotterActive(adds, removes, 7, 144)).toBe(false);
    expect(selfSpotterActive(adds, removes, 7, 145)).toBe(true);
    expect(selfSpotterActive(adds, removes, 7, 260)).toBe(true);
    expect(selfSpotterActive(adds, removes, 7, 262)).toBe(false);
  });

  it("ignores teammates' spotters and own non-scout squadrons", () => {
    expect(selfSpotterActive(adds, removes, 7, 301)).toBe(false); // teammate's scout
    expect(selfSpotterActive(adds, removes, 9, 305)).toBe(true); // that teammate's own view
    expect(selfSpotterActive(adds, removes, 7, 311)).toBe(false); // own dive bomber
    expect(selfSpotterActive(adds, removes, null, 150)).toBe(false);
  });

  it("holds the grace window when no removal arrives", () => {
    const bare = [{ time: 100, planeId: 1, ownerId: 7, paramsId: SCOUT }];
    expect(selfSpotterActive(bare, [], 7, 150)).toBe(true);
    expect(selfSpotterActive(bare, [], 7, 300)).toBe(false);
  });
});

describe("selfInSmoke", () => {
  // Dense sample stream (≤3 s apart — sampleAt freezes across >4 s gaps).
  const driftSamples = Array.from({ length: 98 }, (_v, i) => ({
    time: 10 + i * 3,
    x: (500 * i) / 97,
    z: (-100 * i) / 97,
    yaw: 0,
  }));
  const clusters = [
    // Anchor-only cluster (no trajectory): stays at its first puff.
    { sx: 100, sz: -200, t0: 60, lastT: 200, endT: 260, traj: null },
    // Drifting screen: the cloud moves to (500, -100) by t=301.
    { sx: 0, sz: 0, t0: 10, lastT: 301, endT: 400, traj: { samples: driftSamples } },
  ];
  it("matches only inside the cloud's radius and lifetime", () => {
    expect(selfInSmoke(clusters, 110, -200, 100)).toBe(true);
    expect(selfInSmoke(clusters, 200, -200, 100)).toBe(false); // 100 u away
    expect(selfInSmoke(clusters, 110, -200, 300)).toBe(false); // dissipated
    expect(selfInSmoke([], 110, -200, 100)).toBe(false);
  });
  it("tracks the drifting centre, not the launch anchor", () => {
    // By t=250 the drifting cloud sits near (410, -82), far from its anchor.
    expect(selfInSmoke(clusters, 5, -5, 250)).toBe(false); // near the anchor
    expect(selfInSmoke(clusters, 405, -80, 250)).toBe(true); // near the drift
  });
});

describe("animatedRingMeters", () => {
  it("eases toward the target and settles", () => {
    resetRingAnim();
    const v0 = animatedRingMeters("main", 20000, 0);
    expect(v0).toBe(20000); // first call snaps
    let cur = v0;
    for (let ms = 16; ms <= 800; ms += 16) {
      cur = animatedRingMeters("main", 24000, ms);
    }
    expect(cur).toBeGreaterThan(23990); // settled at the spotter target
    expect(cur).toBeLessThanOrEqual(24000);
  });

  it("resets between replays", () => {
    resetRingAnim();
    expect(animatedRingMeters("main", 15000, 0)).toBe(15000);
  });
});
