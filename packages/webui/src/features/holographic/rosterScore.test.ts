/** Unit tests for the roster score/lamp helpers. */
import { describe, expect, it } from "vitest";
import {
  aiLampColor,
  aiLampHue,
  formatContribution,
  scoreSampleAt,
} from "./rosterScore";
import type { ShipScoreSample } from "@/api";

const sample = (t: number): ShipScoreSample => ({
  t,
  inst: 0.5,
  fire: null,
  fired: null,
  fireProb: null,
  hpLost: null,
  move: 0.5,
  confidence: 0.5,
});

const samples = [sample(100), sample(104), sample(108)];

describe("scoreSampleAt", () => {
  it("returns null before the first sample (and for an empty series)", () => {
    expect(scoreSampleAt(samples, 50)).toBeNull();
    expect(scoreSampleAt([], 100)).toBeNull();
  });

  it("returns the exact sample on a boundary hit", () => {
    expect(scoreSampleAt(samples, 100)?.t).toBe(100);
    expect(scoreSampleAt(samples, 104)?.t).toBe(104);
    expect(scoreSampleAt(samples, 108)?.t).toBe(108);
  });

  it("returns the last sample at or before t between samples", () => {
    expect(scoreSampleAt(samples, 101)?.t).toBe(100);
    expect(scoreSampleAt(samples, 105)?.t).toBe(104);
    expect(scoreSampleAt(samples, 107.9)?.t).toBe(104);
  });

  it("clamps to the last sample after the series ends", () => {
    expect(scoreSampleAt(samples, 1000)?.t).toBe(108);
  });
});

describe("formatContribution", () => {
  it("renders raw numbers below 1000", () => {
    expect(formatContribution(0)).toBe("0");
    expect(formatContribution(842)).toBe("842");
  });

  it("renders thousands with one decimal + k", () => {
    expect(formatContribution(84_234)).toBe("84.2k");
    expect(formatContribution(1_000)).toBe("1.0k");
  });

  it("renders millions with two decimals + M", () => {
    expect(formatContribution(1_312_000)).toBe("1.31M");
    expect(formatContribution(1_000_000)).toBe("1.00M");
  });
});

describe("aiLampHue / aiLampColor", () => {
  it("maps agreement 0 / 0.5 / 1 to red / yellow / green hue", () => {
    expect(aiLampHue(0)).toBe(0);
    expect(aiLampHue(0.5)).toBe(60);
    expect(aiLampHue(1)).toBe(120);
  });

  it("is continuous between the endpoints", () => {
    expect(aiLampHue(0.25)).toBeCloseTo(30, 5);
    expect(aiLampHue(0.75)).toBeCloseTo(90, 5);
    expect(aiLampHue(0.618)).toBeCloseTo(74.16, 5);
  });

  it("clamps out-of-range agreement instead of wrapping", () => {
    expect(aiLampHue(-1)).toBe(0);
    expect(aiLampHue(2)).toBe(120);
  });

  it("formats the HSL colour with the continuous hue", () => {
    expect(aiLampColor(0)).toBe("hsl(0.0 78% 55%)");
    expect(aiLampColor(0.5)).toBe("hsl(60.0 78% 55%)");
    expect(aiLampColor(1)).toBe("hsl(120.0 78% 55%)");
    expect(aiLampColor(0.618)).toBe("hsl(74.2 78% 55%)");
  });
});
