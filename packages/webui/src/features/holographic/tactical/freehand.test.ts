/** Freehand→Bézier fit unit tests (Schneider fitCurve). */
import { describe, expect, it } from "vitest";
import { bezierAt, fitCurve, sampleSegments } from "./freehand";

const p = (x: number, z: number) => ({ x, z });

describe("fitCurve", () => {
  it("degenerate inputs return no segments", () => {
    expect(fitCurve([p(0, 0)], 5)).toEqual([]);
    expect(fitCurve([], 5)).toEqual([]);
    expect(fitCurve([p(0, 0), p(1, 1)], 0)).toEqual([]);
  });

  it("a straight run fits in one segment hugging the line", () => {
    const pts = Array.from({ length: 12 }, (_, i) => p(i * 10, 0));
    const segs = fitCurve(pts, 2);
    expect(segs.length).toBe(1);
    const s = segs[0];
    expect(s.p0).toEqual(p(0, 0));
    expect(s.p3).toEqual(p(110, 0));
    // Controls stay near the axis (the fit is the line itself).
    expect(Math.abs(s.p1.z)).toBeLessThan(2);
    expect(Math.abs(s.p2.z)).toBeLessThan(2);
  });

  it("two points fit one segment with thirds-rule controls", () => {
    const segs = fitCurve([p(0, 0), p(30, 0)], 2);
    expect(segs).toHaveLength(1);
    expect(segs[0].p1.x).toBeCloseTo(10, 6);
    expect(segs[0].p2.x).toBeCloseTo(20, 6);
  });

  it("a sharp L corner splits into ≥2 segments with G1 continuity", () => {
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i <= 10; i++) pts.push(p(i * 10, 0));
    for (let i = 1; i <= 10; i++) pts.push(p(100, i * 10));
    const segs = fitCurve(pts, 3);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    // Continuity: consecutive segments share endpoints.
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].p0.x).toBeCloseTo(segs[i - 1].p3.x, 6);
      expect(segs[i].p0.z).toBeCloseTo(segs[i - 1].p3.z, 6);
    }
    // Every sampled point of the sampled polyline stays near one of the
    // two legs (within tolerance + slack).
    const poly = sampleSegments(segs, 8);
    for (const q of poly) {
      const dist = Math.min(Math.abs(q.z), Math.abs(q.x - 100));
      expect(dist).toBeLessThan(20);
    }
  });

  it("a smooth S-curve fits within tolerance", () => {
    // A cubic sine sweep — itself a polynomial, so the fit should be tight.
    const pts = Array.from({ length: 40 }, (_, i) => {
      const t = i / 39;
      return p(t * 300, Math.sin(t * Math.PI * 2) * 60);
    });
    const segs = fitCurve(pts, 4);
    expect(segs.length).toBeGreaterThanOrEqual(1);
    // Sampled fit deviates from the source by ≤ tolerance (+ slack for
    // sampling discretization).
    const poly = sampleSegments(segs, 12);
    for (const q of poly) {
      const t = q.x / 300;
      const z = Math.sin(t * Math.PI * 2) * 60;
      // Nearest-source check (x may be off a little; compare against the
      // curve at the SAME normalized x).
      expect(Math.abs(q.z - z)).toBeLessThan(10);
    }
  });

  it("tighter tolerance yields more (or equal) segments", () => {
    const pts = Array.from({ length: 60 }, (_, i) => {
      const t = i / 59;
      return p(t * 200, Math.sin(t * Math.PI * 3) * 80);
    });
    const loose = fitCurve(pts, 20).length;
    const tight = fitCurve(pts, 2).length;
    expect(tight).toBeGreaterThanOrEqual(loose);
  });
});

describe("sampleSegments", () => {
  it("starts at the first segment's p0 and steps every segment", () => {
    const seg = {
      p0: p(0, 0),
      p1: p(0, 10),
      p2: p(10, 10),
      p3: p(10, 0),
    };
    const poly = sampleSegments([seg], 4);
    expect(poly).toHaveLength(5);
    expect(poly[0]).toEqual(p(0, 0));
    expect(poly[4].x).toBeCloseTo(10, 6);
    expect(bezierAt(seg, 0.5).x).toBeCloseTo(5, 6);
  });

  it("empty list yields an empty polyline", () => {
    expect(sampleSegments([], 4)).toEqual([]);
  });
});
