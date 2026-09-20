/** Geometry unit tests for the tactical board (pure functions, no DOM). */
import { describe, expect, it } from "vitest";
import {
  boundsOf,
  distToSegment,
  pointAlongPolyline,
  pointInEllipse,
  pointNearRect,
  polylineLength,
  simplifyRDP,
  slicePolylineByFraction,
  sliceSegmentByFraction,
  smoothPolyline,
  viewWindow,
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

describe("pointAlongPolyline", () => {
  const line = [p(0, 0), p(10, 0)]; // heading east (+x)
  it("returns the start with an eastward tangent at fraction 0", () => {
    const r = pointAlongPolyline(line, 0);
    expect(r.at).toEqual(p(0, 0));
    expect(r.heading).toBeCloseTo(Math.PI / 2); // east = 90° cw from north
  });
  it("interpolates at half length and reaches the end", () => {
    expect(pointAlongPolyline(line, 0.5).at).toEqual(p(5, 0));
    const end = pointAlongPolyline(line, 1);
    expect(end.at).toEqual(p(10, 0));
    expect(end.heading).toBeCloseTo(Math.PI / 2);
  });
  it("follows the local tangent around a corner", () => {
    const corner = [p(0, 0), p(10, 0), p(10, 10)]; // east then north
    expect(pointAlongPolyline(corner, 0).heading).toBeCloseTo(Math.PI / 2);
    expect(pointAlongPolyline(corner, 1).heading).toBeCloseTo(0); // north
    expect(pointAlongPolyline(corner, 0.75).at).toEqual(p(10, 5));
  });
  it("handles degenerate inputs", () => {
    expect(pointAlongPolyline([], 0.5).at).toEqual(p(0, 0));
    expect(pointAlongPolyline([p(3, 4)], 0.5).at).toEqual(p(3, 4));
    expect(pointAlongPolyline([p(1, 1), p(1, 1)], 0.5).at).toEqual(p(1, 1));
  });
});

describe("viewWindow", () => {
  const full = { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 };
  it("scale 1 (or below) snaps to the whole map regardless of center", () => {
    expect(viewWindow({ cx: 999, cz: -5, scale: 1 }, full)).toEqual(full);
    expect(viewWindow({ cx: 500, cz: 500, scale: 0.3 }, full)).toEqual(full);
  });
  it("zoomed windows keep the map aspect and stay inside the map", () => {
    const v = viewWindow({ cx: 0, cz: 0, scale: 4 }, full);
    expect(v.maxX - v.minX).toBeCloseTo(250);
    expect(v.maxZ - v.minZ).toBeCloseTo(250);
    expect(v.minX).toBeGreaterThanOrEqual(0);
    expect(v.maxX).toBeLessThanOrEqual(1000);
    // center pushed back inside: window clamps to the corner
    expect(v.minX).toBeCloseTo(0);
    expect(v.minZ).toBeCloseTo(0);
  });
  it("clamps scale to the max", () => {
    const v = viewWindow({ cx: 500, cz: 500, scale: 99 }, full, 12);
    expect(v.maxX - v.minX).toBeCloseTo(1000 / 12);
  });
  it("keeps a centered zoom centered", () => {
    const v = viewWindow({ cx: 500, cz: 500, scale: 2 }, full);
    expect(v.minX).toBeCloseTo(250);
    expect(v.maxZ).toBeCloseTo(750);
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
