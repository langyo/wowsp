/** Unit tests for the capture-zone classification heuristics. */
import { describe, expect, it } from "vitest";
import { isCaptureZone } from "./capZones";
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
});
