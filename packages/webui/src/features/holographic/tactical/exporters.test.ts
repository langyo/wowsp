/** Offline-export frame schedule tests (pure — no DOM / WebCodecs here). */
import { describe, expect, it } from "vitest";
import { frameTimes } from "./exporters";

describe("frameTimes", () => {
  it("steps at 1/fps from `from` through `to` inclusive", () => {
    const t = frameTimes(0, 1, 10);
    expect(t).toHaveLength(11);
    expect(t[0]).toBe(0);
    expect(t[10]).toBeCloseTo(1, 6);
    for (let i = 1; i < t.length; i++) {
      expect(t[i]).toBeGreaterThan(t[i - 1]);
      expect(t[i] - t[i - 1]).toBeCloseTo(0.1, 9);
    }
  });

  it("is strictly increasing even with float-hostile ranges", () => {
    const t = frameTimes(3.7, 10.3, 30);
    for (let i = 1; i < t.length; i++) {
      expect(t[i]).toBeGreaterThan(t[i - 1]);
    }
    expect(t[t.length - 1]).toBeLessThanOrEqual(10.3 + 1e-9);
  });

  it("never passes `to`", () => {
    const t = frameTimes(2, 2.05, 30); // 2 frames only: 2.00 and 2.0333
    expect(t).toHaveLength(2);
    expect(t[1]).toBeLessThanOrEqual(2.05);
  });

  it("degenerates to a single frame when the range is empty or invalid", () => {
    expect(frameTimes(5, 5, 30)).toEqual([5]);
    expect(frameTimes(5, 4.9, 30)).toEqual([5]);
    expect(frameTimes(Number.NaN, 4, 30)).toEqual([]);
    expect(frameTimes(0, 1, 0)).toEqual([0]);
  });
});
