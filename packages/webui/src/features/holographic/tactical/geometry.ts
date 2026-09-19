/**
 * Pure geometry for the tactical board: freehand simplification (RDP),
 * Catmull-Rom smoothing, polyline slicing for draw-on animations and
 * hit-testing. No DOM / canvas dependencies — everything is unit-testable.
 */
import type { Vec2 } from "./types";

/** Ramer–Douglas–Peucker simplification. Keeps the stroke's character while
 *  collapsing the pointer firehose (~120 Hz samples) down to a few anchors. */
export function simplifyRDP(pts: Vec2[], tolerance: number): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i], pts[a], pts[b]);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > tolerance && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([a, maxIdx], [maxIdx, b]);
    }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** Catmull-Rom spline resampled into a dense polyline (endpoints included).
 *  A sampled polyline — rather than canvas bezier curves — is deliberate:
 *  draw-on slicing, dash patterns and hit-testing all need uniform points. */
export function smoothPolyline(pts: Vec2[], pxPerSegment = 4): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const out: Vec2[] = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    const approx = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(2, Math.ceil(approx / Math.max(0.5, pxPerSegment)));
    for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x:
          0.5 *
          (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        z:
          0.5 *
          (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      });
    }
  }
  return out;
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.z - a.z);
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

export function polylineLength(pts: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  }
  return len;
}

/** Prefix of the polyline covering `fraction` of its total length (0..1). */
export function slicePolylineByFraction(pts: Vec2[], fraction: number): Vec2[] {
  if (fraction >= 1) return pts.slice();
  if (pts.length === 0) return pts.slice();
  if (fraction <= 0) return [pts[0]];
  const total = polylineLength(pts);
  if (total === 0) return pts.slice();
  const target = total * fraction;
  const out: Vec2[] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (acc + seg >= target) {
      const t = seg === 0 ? 0 : (target - acc) / seg;
      out.push({
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t,
      });
      return out;
    }
    acc += seg;
    out.push(pts[i]);
  }
  return out;
}

/** Interpolate along a two-point "polyline" (lines/arrows) by fraction. */
export function sliceSegmentByFraction(from: Vec2, to: Vec2, fraction: number): Vec2 {
  const t = Math.max(0, Math.min(1, fraction));
  return { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t };
}

export function distToPolyline(p: Vec2, pts: Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    best = Math.min(best, distToSegment(p, pts[i - 1], pts[i]));
  }
  return best;
}

/** Axis-aligned bbox of a world point cloud (selection outline, hit padding). */
export function boundsOf(pts: Vec2[]): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, minZ, maxX, maxZ };
}

/** Point-in-rect with padding (world coords). */
export function pointNearRect(
  p: Vec2,
  a: Vec2,
  b: Vec2,
  pad: number,
): boolean {
  return (
    p.x >= Math.min(a.x, b.x) - pad &&
    p.x <= Math.max(a.x, b.x) + pad &&
    p.z >= Math.min(a.z, b.z) - pad &&
    p.z <= Math.max(a.z, b.z) + pad
  );
}

/** Point inside (or within `pad` of) the ellipse defined by two opposite
 *  corners of its bounding box (world coords). Inside-selects is deliberate —
 *  an ellipse ring outline alone is a fiddly click target. */
export function pointInEllipse(p: Vec2, a: Vec2, b: Vec2, pad: number): boolean {
  const cx = (a.x + b.x) / 2;
  const cz = (a.z + b.z) / 2;
  const rx = Math.abs(a.x - b.x) / 2 + pad;
  const rz = Math.abs(a.z - b.z) / 2 + pad;
  if (rx === 0 || rz === 0) return distToSegment(p, a, b) <= pad;
  const nx = (p.x - cx) / rx;
  const nz = (p.z - cz) / rz;
  return nx * nx + nz * nz <= 1;
}
