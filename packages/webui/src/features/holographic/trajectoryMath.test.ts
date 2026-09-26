/** Unit tests for trajectory stream math (pure sample lookups). */
import { describe, expect, it } from "vitest";
import { angleDiff, hpAtTime, progressAtTime, sampleAt } from "./trajectoryMath";

const traj = (samples: { time: number; x: number; z: number; yaw: number }[]) => ({ samples });

describe("sampleAt", () => {
  const two = traj([
    { time: 0, x: 0, z: 0, yaw: 0 },
    { time: 4, x: 100, z: 200, yaw: 1 },
  ]);

  it("clamps to the first sample before the span", () => {
    expect(sampleAt(two, -5)).toBe(two.samples[0]);
  });

  it("clamps to the last sample after the span", () => {
    expect(sampleAt(two, 100)).toBe(two.samples[1]);
  });

  it("interpolates linearly between neighbours (yaw along the short way)", () => {
    const s = sampleAt(two, 2);
    expect(s.x).toBeCloseTo(50);
    expect(s.z).toBeCloseTo(100);
    expect(s.yaw).toBeCloseTo(0.5);
  });

  it("freezes at the last known pose across an un-spotted gap", () => {
    // 10 s between samples exceeds the 4 s smooth-gap budget.
    const gapped = traj([
      { time: 0, x: 10, z: 20, yaw: 0.25 },
      { time: 10, x: 110, z: 120, yaw: 1 },
    ]);
    const s = sampleAt(gapped, 5);
    expect(s.x).toBe(10);
    expect(s.z).toBe(20);
    expect(s.yaw).toBe(0.25);
  });

  it("still interpolates a gap of exactly the smooth-gap budget", () => {
    const edge = traj([
      { time: 0, x: 0, z: 0, yaw: 0 },
      { time: 4, x: 8, z: 0, yaw: 0 },
    ]);
    expect(sampleAt(edge, 2).x).toBeCloseTo(4);
  });
});

describe("angleDiff", () => {
  it("returns the plain difference for small angles", () => {
    expect(angleDiff(0.1, 0.4)).toBeCloseTo(0.3);
    expect(angleDiff(0.1, -0.1)).toBeCloseTo(-0.2);
  });

  it("wraps to the shortest path across ±π", () => {
    expect(angleDiff(0, Math.PI + 0.1)).toBeCloseTo(-(Math.PI - 0.1));
    expect(angleDiff(3, -3)).toBeCloseTo(2 * Math.PI - 6);
  });
});

describe("hpAtTime", () => {
  const hp = [
    { time: 1, value: 100 },
    { time: 5, value: 80 },
    { time: 9, value: 60 },
  ];

  it("returns null without a stream", () => {
    expect(hpAtTime(undefined, 5)).toBeNull();
    expect(hpAtTime([], 5)).toBeNull();
  });

  it("holds the first value before any sample", () => {
    expect(hpAtTime(hp, 0)).toBe(100);
  });

  it("steps to the last value at or before t", () => {
    expect(hpAtTime(hp, 1)).toBe(100);
    expect(hpAtTime(hp, 5)).toBe(80);
    expect(hpAtTime(hp, 6)).toBe(80);
    expect(hpAtTime(hp, 10)).toBe(60);
  });
});

describe("progressAtTime", () => {
  const cp = [
    { time: 10, value: 500 },
    { time: 20, value: 800 },
  ];

  it("returns null without a stream", () => {
    expect(progressAtTime(undefined, 5)).toBeNull();
    expect(progressAtTime([], 5)).toBeNull();
  });

  it("reads zero before the stream starts (home point not yet contested)", () => {
    expect(progressAtTime(cp, 5)).toBe(0);
  });

  it("holds values between step samples", () => {
    expect(progressAtTime(cp, 10)).toBe(500);
    expect(progressAtTime(cp, 15)).toBe(500);
    expect(progressAtTime(cp, 20)).toBe(800);
    expect(progressAtTime(cp, 30)).toBe(800);
  });
});
