/** Unit tests for the capture-zone classification heuristics. */
import { describe, expect, it } from "vitest";
import { capLetter, isCaptureZone, zoneBirthTime, zoneIsLive } from "./capZones";
import type { EntityTrajectory } from "@/api";

/** Minimal zone trajectory: entityType 14 with only the fields the
 *  classifier reads. */
const zone = (fields: Partial<EntityTrajectory>): EntityTrajectory => ({
  entityId: 1,
  samples: [],
  kind: {
    entityType: 14,
    vehicleId: 0,
    initialX: 0,
    initialY: 0,
    initialZ: 0,
    creationTime: 0,
  },
  ...fields,
});

describe("isCaptureZone", () => {
  it("accepts a zone carrying the controlPoint create component", () => {
    const t = zone({ kind: { ...zone({}).kind!, controlPointIndex: 0 } });
    expect(isCaptureZone(t)).toBe(true);
  });

  it("accepts a zone with an ownership stream", () => {
    const t = zone({ capSamples: [{ time: 10, value: 1 }] });
    expect(isCaptureZone(t)).toBe(true);
  });

  it("rejects a zone with no discriminators at all", () => {
    expect(isCaptureZone(zone({}))).toBe(false);
  });

  it("accepts a long tug-of-war progress stream (real capture point)", () => {
    const cp = Array.from({ length: 10 }, (_, i) => ({ time: i, value: 100 + i }));
    expect(isCaptureZone(zone({ capProgress: cp }))).toBe(true);
  });

  it("rejects a short high-value decaying stream (strike-target health)", () => {
    const cp = [
      { time: 1, value: 1200 },
      { time: 2, value: 800 },
      { time: 3, value: 0 },
    ];
    expect(isCaptureZone(zone({ capProgress: cp }))).toBe(false);
  });

  it("accepts a short stream that ends while still owned", () => {
    const cp = [
      { time: 1, value: 300 },
      { time: 2, value: 700 },
    ];
    expect(isCaptureZone(zone({ capProgress: cp }))).toBe(true);
  });

  it("accepts a point nobody ever touched (flat zero stream)", () => {
    const cp = [{ time: 1, value: 0 }, { time: 2, value: 0 }];
    expect(isCaptureZone(zone({ capProgress: cp }))).toBe(true);
  });

  it("rejects a short contest that ends at zero (reads as health decay)", () => {
    // Short streams ending at zero are treated as strike targets unless a
    // sample stayed zero the whole match; only a LONG stream (>= 10
    // samples) is trusted as a real point's tug-of-war.
    const cp = [
      { time: 1, value: 400 },
      { time: 2, value: 900 },
      { time: 3, value: 200 },
      { time: 4, value: 0 },
    ];
    expect(isCaptureZone(zone({ capProgress: cp }))).toBe(false);
  });

  it("accepts a pre-owned point nobody ever contested (zero streams)", () => {
    // 15.8 2-cap layout: each side pre-owns its home point, and a point
    // the enemy never enters emits NO ownership and NO progress samples
    // for the whole match — the create state's controlPoint component is
    // the only signal left (regression for the vanishing home point).
    const t = zone({ kind: { ...zone({}).kind!, controlPointIndex: 1 } });
    expect(isCaptureZone(t)).toBe(true);
  });
});

describe("capLetter", () => {
  it("prefers the game's own point index over the list position", () => {
    const t = zone({ kind: { ...zone({}).kind!, controlPointIndex: 1 } });
    expect(capLetter(t, 0)).toBe("B");
  });

  it("falls back to the list position without a point index", () => {
    expect(capLetter(zone({}), 2)).toBe("C");
  });
});

describe("zone birth time (progressive op points)", () => {
  it("reads the EntityCreate time as the birth instant", () => {
    const t = zone({ kind: { ...zone({}).kind!, creationTime: 120 } });
    expect(zoneBirthTime(t)).toBe(120);
  });

  it("treats pre-recording entities (-1) as live from the first frame", () => {
    const t = zone({ kind: { ...zone({}).kind!, creationTime: -1 } });
    expect(zoneBirthTime(t)).toBe(-1);
    expect(zoneIsLive(t, 0)).toBe(true);
  });

  it("hides an op point until the playhead crosses its creation", () => {
    const t = zone({ kind: { ...zone({}).kind!, creationTime: 120 } });
    expect(zoneIsLive(t, 119.9)).toBe(false);
    expect(zoneIsLive(t, 120)).toBe(true);
    expect(zoneIsLive(t, 900)).toBe(true);
  });

  it("treats a missing kind as pre-recording (live immediately)", () => {
    expect(zoneIsLive({ entityId: 1, samples: [] }, 0)).toBe(true);
  });
});
