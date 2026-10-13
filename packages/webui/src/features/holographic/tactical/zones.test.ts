/** Zone-math unit tests: torpedo sweeps and consumable rings (pure). */
import { describe, expect, it } from "vitest";
import {
  SMOKE_RADIUS_UNITS,
  TORPEDO_SPEED_UNITS_S,
  zoneAlphaAt,
  zoneEndedAt,
  zoneHitTest,
  zoneParamsOf,
  zoneRadiusAt,
  zoneSectorPoints,
  type ZoneLike,
} from "./zones";

const torp: ZoneLike = {
  zoneType: "torpedo",
  at: { x: 0, z: 0 },
  heading: 0,
  t0: 60,
  radius: 300,
  halfAngle: 0.2618, // ~15°
  speed: TORPEDO_SPEED_UNITS_S,
  durS: 0,
};

const radar: ZoneLike = {
  zoneType: "radar",
  at: { x: 0, z: 0 },
  heading: 0,
  t0: 100,
  radius: 200,
  halfAngle: 0,
  speed: 0,
  durS: 30,
};

describe("zoneRadiusAt", () => {
  it("torpedoes sweep outward at run speed until max range", () => {
    expect(zoneRadiusAt(torp, 59)).toBe(0);
    expect(zoneRadiusAt(torp, 60)).toBeCloseTo(0, 6);
    expect(zoneRadiusAt(torp, 60 + 100)).toBeCloseTo(TORPEDO_SPEED_UNITS_S * 100, 6);
    expect(zoneRadiusAt(torp, 60 + 1e6)).toBe(300);
  });

  it("static rings jump to full radius immediately", () => {
    expect(zoneRadiusAt(radar, 99)).toBe(0);
    expect(zoneRadiusAt(radar, 100)).toBe(200);
    expect(zoneRadiusAt(radar, 129)).toBe(200);
  });
});

describe("zoneEndedAt / zoneAlphaAt", () => {
  it("a spread ends when it reaches max range", () => {
    expect(zoneEndedAt(torp)).toBeCloseTo(60 + 300 / TORPEDO_SPEED_UNITS_S, 6);
  });

  it("a ring ends when its duration lapses", () => {
    expect(zoneEndedAt(radar)).toBe(130);
    expect(zoneAlphaAt(radar, 100)).toBeCloseTo(0, 6); // fade-in starts at 0
    expect(zoneAlphaAt(radar, 101)).toBeGreaterThan(0.5);
    expect(zoneAlphaAt(radar, 125)).toBeGreaterThan(0);
    expect(zoneAlphaAt(radar, 130)).toBe(0);
  });
});

describe("zoneParamsOf", () => {
  it("builds torpedo params from the unit's reach", () => {
    const p = zoneParamsOf("torpedo", { torpRadius: 333, smoke: false });
    expect(p).not.toBeNull();
    expect(p!.radius).toBe(333);
    expect(p!.speed).toBe(TORPEDO_SPEED_UNITS_S);
    expect(p!.halfAngle).toBeGreaterThan(0);
  });

  it("refuses zones the unit cannot field", () => {
    expect(zoneParamsOf("torpedo", { smoke: true })).toBeNull();
    expect(zoneParamsOf("radar", { smoke: true })).toBeNull();
    expect(zoneParamsOf("hydro", { radarRadius: 100, smoke: false })).toBeNull();
    expect(zoneParamsOf("smoke", { smoke: false })).toBeNull();
  });

  it("rings use kit radii and estimated durations", () => {
    const r = zoneParamsOf("radar", { radarRadius: 190, smoke: false });
    expect(r).toEqual({ radius: 190, halfAngle: 0, speed: 0, durS: 30 });
    const s = zoneParamsOf("smoke", { smoke: true });
    expect(s!.radius).toBe(SMOKE_RADIUS_UNITS);
    expect(s!.durS).toBe(90);
  });
});

describe("zoneSectorPoints / zoneHitTest", () => {
  it("a sector spans the wedge between its flanks", () => {
    const pts = zoneSectorPoints(torp, 300);
    expect(pts.length).toBeGreaterThanOrEqual(14);
    expect(pts[0]).toEqual({ x: 0, z: 0 });
    // Aimed north: the arc's farthest point is at z ≈ +300.
    const far = pts[pts.length - 1];
    expect(far.z).toBeCloseTo(300 * Math.cos(0.2618), 4);
  });

  it("hits inside the wedge, misses outside it and beyond the sweep", () => {
    const r = zoneRadiusAt(torp, 60 + 200);
    expect(zoneHitTest(torp, { x: 0, z: r * 0.9 }, 60 + 200, 1)).toBe(true);
    // Due east of the launch is outside a north-aimed wedge.
    expect(zoneHitTest(torp, { x: 50, z: 10 }, 60 + 200, 1)).toBe(false);
    // Ahead of the sweep front is empty water.
    expect(zoneHitTest(torp, { x: 0, z: 299 }, 61, 1)).toBe(false);
  });

  it("a ring hit-tests by radius alone", () => {
    expect(zoneHitTest(radar, { x: 140, z: 140 }, 110, 1)).toBe(true); // inside (198 < 200)
    expect(zoneHitTest(radar, { x: 0, z: 250 }, 110, 1)).toBe(false); // outside
  });
});
