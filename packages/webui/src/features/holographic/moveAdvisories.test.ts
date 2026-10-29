/**
 * E18 movement-advice helpers: the shared color ramp bounds, the
 * second-sector bearing reconstruction and the score panel's instant-sample
 * binary search (pure functions — no scene, no IPC).
 */
import { describe, expect, it } from "vitest";
import type { MovementAdvice, ShipScoreSample } from "@/api";
import { adviceColorRgb, secondBearingRad } from "./moveAdvisories";
import { scoreSampleAt } from "./HoloScorePanel";

function advice(partial: Partial<MovementAdvice>): MovementAdvice {
  return {
    entityId: 1,
    shipId: null,
    teamId: 0,
    isRecorder: false,
    rowT: 300,
    topSector: 3,
    topProb: 0.6,
    probDist: [],
    mapBearingRad: 1.0,
    secondSector: 9,
    secondProb: 0.2,
    ...partial,
  };
}

describe("secondBearingRad", () => {
  it("offsets the top bearing by the sector difference × 22.5°", () => {
    // top sector 3 → second 4 is one sector clockwise: +π/8.
    const a = advice({ mapBearingRad: 1.0, topSector: 3, secondSector: 4 });
    expect(secondBearingRad(a)).toBeCloseTo(1.0 + Math.PI / 8, 6);
  });

  it("wraps backwards across sectors correctly", () => {
    const a = advice({ mapBearingRad: 0.2, topSector: 2, secondSector: 15 });
    expect(secondBearingRad(a)).toBeCloseTo(0.2 + 13 * (Math.PI / 8), 6);
  });

  it("is null when the top class is no-move (no reference on the wire)", () => {
    const a = advice({ topSector: 16, mapBearingRad: null, secondSector: 4 });
    expect(secondBearingRad(a)).toBeNull();
  });
});

describe("adviceColorRgb", () => {
  it("ramps monotonically toward the bright endpoint with confidence", () => {
    const dim = adviceColorRgb(false, 0, 0);
    const mid = adviceColorRgb(false, 0, 0.5);
    const bright = adviceColorRgb(false, 0, 1);
    expect(mid[0]).toBeGreaterThan(dim[0]);
    expect(bright[0]).toBeGreaterThan(mid[0]);
    for (const c of [dim, mid, bright]) {
      expect(c.every((ch) => ch >= 0 && ch <= 255)).toBe(true);
    }
  });

  it("separates allegiances at the same confidence", () => {
    const ally = adviceColorRgb(false, 0, 0.8);
    const enemy = adviceColorRgb(false, 1, 0.8);
    expect(enemy[0]).toBeGreaterThan(ally[0]); // amber is red-heavy vs cyan
    expect(ally[2]).toBeGreaterThan(enemy[2]);
  });
});

describe("scoreSampleAt", () => {
  const samples: ShipScoreSample[] = [
    { t: 100, inst: 0.2, fire: null, fired: null, fireProb: null, move: 0.2, confidence: 0.4 },
    { t: 104, inst: 0.4, fire: 0.9, fired: true, fireProb: 0.9, move: 0.3, confidence: 0.6 },
    { t: 108, inst: 0.6, fire: 0.7, fired: false, fireProb: 0.3, move: 0.5, confidence: 0.8 },
  ];

  it("returns the last sample at or before t", () => {
    expect(scoreSampleAt(samples, 105)?.t).toBe(104);
    expect(scoreSampleAt(samples, 104)?.t).toBe(104);
    expect(scoreSampleAt(samples, 1000)?.t).toBe(108);
  });

  it("is null before the first decision point", () => {
    expect(scoreSampleAt(samples, 50)).toBeNull();
    expect(scoreSampleAt([], 100)).toBeNull();
  });
});
