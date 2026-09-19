/** Geometry unit tests for the tactical board (pure functions, no DOM). */
import { describe, expect, it } from "vitest";
import {
  boundsOf,
  distToSegment,
  pointInEllipse,
  pointNearRect,
  polylineLength,
  simplifyRDP,
  slicePolylineByFraction,
  sliceSegmentByFraction,
  smoothPolyline,
} from "./geometry";

const p = (x: number, z: number) => ({ x, z });

describe("simplifyRDP", () => {
  it("collapses collinear runs to the two endpoints", () => {
    const pts = [p(0, 0), p(1, 0), p(2, 0), p(3, 0), p(4, 0)];
    expect(simplifyRDP(pts, 0.5)).toEqual([p(0, 0), p(4, 0)]);
  });

  it("keeps a corner that deviates beyond tolerance", () => {
    const pts = [p(0, 0), p(2, 5), p(4, 0)];
    const out = simplifyRDP(pts, 1);
    expect(out).toHaveLength(3);
  });

  it("returns a copy for short inputs", () => {
    const pts = [p(0, 0)];
    const out = simplifyRDP(pts, 1);
    expect(out).toEqual(pts);
    expect(out).not.toBe(pts);
  });
});

describe("smoothPolyline", () => {
  it("preserves the first and last points", () => {
    const out = smoothPolyline([p(0, 0), p(10, 0), p(10, 10)], 2);
    expect(out[0]).toEqual(p(0, 0));
    expect(out[out.length - 1]).toEqual(p(10, 10));
  });

  it("densifies the input", () => {
    const out = smoothPolyline([p(0, 0), p(100, 0), p(100, 100)], 4);
    expect(out.length).toBeGreaterThan(3);
  });
});

describe("distToSegment", () => {
  it("measures perpendicular distance", () => {
    expect(distToSegment(p(5, 3), p(0, 0), p(10, 0))).toBeCloseTo(3);
  });

  it("clamps to the nearest endpoint", () => {
    expect(distToSegment(p(-4, 0), p(0, 0), p(10, 0))).toBeCloseTo(4);
    expect(distToSegment(p(14, 2), p(0, 0), p(10, 0))).toBeCloseTo(Math.hypot(4, 2));
  });

  it("handles degenerate zero-length segments", () => {
    expect(distToSegment(p(3, 4), p(0, 0), p(0, 0))).toBeCloseTo(5);
  });
});

describe("slicePolylineByFraction", () => {
  it("returns the whole polyline at fraction 1", () => {
    const pts = [p(0, 0), p(5, 0), p(10, 0)];
    expect(slicePolylineByFraction(pts, 1)).toEqual(pts);
  });

  it("cuts a straight polyline at half its length", () => {
    const pts = [p(0, 0), p(10, 0)];
    const out = slicePolylineByFraction(pts, 0.5);
    expect(out).toEqual([p(0, 0), p(5, 0)]);
    expect(polylineLength(out)).toBeCloseTo(polylineLength(pts) / 2);
  });

  it("clamps out-of-range fractions", () => {
    const pts = [p(0, 0), p(10, 0)];
    expect(slicePolylineByFraction(pts, 0)).toEqual([p(0, 0)]);
    expect(slicePolylineByFraction(pts, 4)).toEqual(pts);
  });
});

describe("sliceSegmentByFraction", () => {
  it("interpolates linearly", () => {
    expect(sliceSegmentByFraction(p(0, 0), p(10, 20), 0.5)).toEqual(p(5, 10));
    expect(sliceSegmentByFraction(p(0, 0), p(10, 20), 0)).toEqual(p(0, 0));
    expect(sliceSegmentByFraction(p(0, 0), p(10, 20), 2)).toEqual(p(10, 20));
  });
});

describe("pointNearRect / pointInEllipse", () => {
  it("rect: inside and padded-outside hits, far misses", () => {
    const a = p(0, 0);
    const b = p(10, 10);
    expect(pointNearRect(p(5, 5), a, b, 1)).toBe(true);
    expect(pointNearRect(p(10.5, 5), a, b, 1)).toBe(true);
    expect(pointNearRect(p(20, 5), a, b, 1)).toBe(false);
  });

  it("ellipse: centre and padded ring hit, far outside misses", () => {
    const a = p(-10, -5);
    const b = p(10, 5);
    expect(pointInEllipse(p(0, 0), a, b, 1)).toBe(true);
    expect(pointInEllipse(p(10, 0), a, b, 1)).toBe(true);
    expect(pointInEllipse(p(20, 0), a, b, 1)).toBe(false);
  });
});

describe("boundsOf", () => {
  it("computes the enclosing box", () => {
    expect(boundsOf([p(3, -2), p(-5, 4), p(0, 0)])).toEqual({
      minX: -5,
      minZ: -2,
      maxX: 3,
      maxZ: 4,
    });
  });
});
