/**
 * Freehand → piecewise cubic Bézier fitting for plan-board trajectory
 * drawing: the classic Schneider "FitCurve" algorithm (Graphics Gems,
 * "Algorithm for Automatically Fitting Digitized Curves", public-domain
 * lineage) — chord-length parameterization, least-squares control-point
 * solve, Newton–Raphson reparameterization, recursive midpoint split under
 * a max-error budget.
 *
 * Pure and DOM-free (unit-tested). Points are WORLD coords; `tolerance` is
 * a deviation budget in world units.
 */
import type { Vec2 } from "./types";

/** One cubic Bézier segment: endpoints p0/p3, controls p1/p2. */
export interface BezierSeg {
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
}

interface PtT {
  p: Vec2;
  t: number;
}

const vSub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
const vAdd = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, z: a.z + b.z });
const vScale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, z: a.z * s });
const vDist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);

/** v normalized; the zero vector stays zero (degenerate but harmless in the
 *  least-squares solve). */
function vNorm(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.z);
  return l > 1e-12 ? { x: a.x / l, z: a.z / l } : { x: 0, z: 0 };
}

/** Chord-length parameterization (t spans [0,1]). */
function chordParameterize(pts: Vec2[]): PtT[] {
  const out: PtT[] = [{ p: pts[0], t: 0 }];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += vDist(pts[i], pts[i - 1]);
    out.push({ p: pts[i], t: acc });
  }
  const total = out[out.length - 1].t || 1;
  for (const e of out) e.t /= total;
  return out;
}

/** Bézier basis row: [ (1-t)³, 3t(1-t)², 3t²(1-t), t³ ]. */
function bBasis(t: number): [number, number, number, number] {
  const u = 1 - t;
  return [u * u * u, 3 * t * u * u, 3 * t * t * u, t * t * t];
}

/** Point on a cubic segment at parameter t. */
export function bezierAt(seg: BezierSeg, t: number): Vec2 {
  const [b0, b1, b2, b3] = bBasis(t);
  return {
    x: b0 * seg.p0.x + b1 * seg.p1.x + b2 * seg.p2.x + b3 * seg.p3.x,
    z: b0 * seg.p0.z + b1 * seg.p1.z + b2 * seg.p2.z + b3 * seg.p3.z,
  };
}

/** Uniformly sample a segment list into a polyline. */
export function sampleSegments(segs: BezierSeg[], stepsPerSeg = 10): Vec2[] {
  if (segs.length === 0) return [];
  const out: Vec2[] = [segs[0].p0];
  for (const s of segs) {
    for (let i = 1; i <= stepsPerSeg; i++) out.push(bezierAt(s, i / stepsPerSeg));
  }
  return out;
}

/** Least-squares solve of the two inner control points (Schneider's
 *  generateBezier). Falls back to the thirds rule on a singular normal
 *  matrix or absurd magnitudes. */
function generateBezier(u: PtT[], tHat1: Vec2, tHat2: Vec2): BezierSeg {
  const n = u.length;
  const p0 = u[0].p;
  const p3 = u[n - 1].p;
  const d = vDist(p0, p3);
  const fallback = (): BezierSeg => ({
    p0,
    p1: vAdd(p0, vScale(tHat1, d / 3)),
    p2: vAdd(p3, vScale(tHat2, d / 3)),
    p3,
  });
  if (n === 2) return fallback();

  // Normal equations C·α = x over the tangent-basis magnitudes (Schneider
  // eq. 6–8): A_i = b1(t_i)·t̂1 ⊕ b2(t_i)·t̂2, rhs = P_i − (b0+b1)P0 −
  // (b2+b3)P3.
  let c00 = 0,
    c01 = 0,
    c11 = 0,
    x0 = 0,
    x1 = 0;
  for (let i = 0; i < n; i++) {
    const t = u[i].t;
    const ut = 1 - t;
    const b1 = 3 * t * ut * ut;
    const b2 = 3 * t * t * ut;
    const b0 = ut * ut * ut;
    const b3 = t * t * t;
    const a1 = vScale(tHat1, b1);
    const a2 = vScale(tHat2, b2);
    c00 += a1.x * a1.x + a1.z * a1.z;
    c01 += a1.x * a2.x + a1.z * a2.z;
    c11 += a2.x * a2.x + a2.z * a2.z;
    const rhs = vSub(u[i].p, vAdd(vAdd(vScale(p0, b0 + b1), vScale(p3, b2 + b3)), { x: 0, z: 0 }));
    x0 += a1.x * rhs.x + a1.z * rhs.z;
    x1 += a2.x * rhs.x + a2.z * rhs.z;
  }
  const det = c00 * c11 - c01 * c01;
  if (Math.abs(det) < 1e-12) return fallback();
  const aL = (x0 * c11 - x1 * c01) / det;
  const aR = (c00 * x1 - c01 * x0) / det;
  if (!Number.isFinite(aL) || !Number.isFinite(aR) || aL < 0 || aR < 0) return fallback();
  // Reject controls the data cannot support (fit blowing past the chord).
  if (aL > 4 * d + 1 || aR > 4 * d + 1) return fallback();
  return {
    p0,
    p1: vAdd(p0, vScale(tHat1, aL)),
    p2: vAdd(p3, vScale(tHat2, aR)),
    p3,
  };
}

/** Newton–Raphson reparameterization: the t minimizing |B(t) − p|.
 *  f = (Q−P)·Q′, f′ = Q′·Q′ + (Q−P)·Q″; a few clamped iterations. */
function reparameterize(seg: BezierSeg, p: Vec2, t0: number): number {
  let t = t0;
  for (let it = 0; it < 4; it++) {
    const ut = 1 - t;
    const q = bezierAt(seg, t);
    const qx = q.x - p.x;
    const qz = q.z - p.z;
    // Q′ = 3(1−t)²(P1−P0) + 6t(1−t)(P2−P1) + 3t²(P3−P2)
    const d1x =
      3 * ut * ut * (seg.p1.x - seg.p0.x) +
      6 * t * ut * (seg.p2.x - seg.p1.x) +
      3 * t * t * (seg.p3.x - seg.p2.x);
    const d1z =
      3 * ut * ut * (seg.p1.z - seg.p0.z) +
      6 * t * ut * (seg.p2.z - seg.p1.z) +
      3 * t * t * (seg.p3.z - seg.p2.z);
    // Q″ = 6(1−t)(P2−2P1+P0) + 6t(P3−2P2+P1)
    const d2x = 6 * ut * (seg.p2.x - 2 * seg.p1.x + seg.p0.x) + 6 * t * (seg.p3.x - 2 * seg.p2.x + seg.p1.x);
    const d2z = 6 * ut * (seg.p2.z - 2 * seg.p1.z + seg.p0.z) + 6 * t * (seg.p3.z - 2 * seg.p2.z + seg.p1.z);
    const num = qx * d1x + qz * d1z;
    const den = d1x * d1x + d1z * d1z + qx * d2x + qz * d2z;
    if (Math.abs(den) < 1e-12) break;
    const step = num / den;
    t -= step;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    if (Math.abs(step) < 1e-6) break;
  }
  return t;
}

/** Max deviation from the points to the segment; reports the worst index
 *  (the split point) through `split`. */
function maxError(seg: BezierSeg, u: PtT[], split: { i: number }): number {
  let maxDist = 0;
  let maxI = Math.floor(u.length / 2);
  for (let i = 1; i < u.length - 1; i++) {
    const t = reparameterize(seg, u[i].p, u[i].t);
    const q = bezierAt(seg, t);
    const d = Math.hypot(q.x - u[i].p.x, q.z - u[i].p.z);
    if (d > maxDist) {
      maxDist = d;
      maxI = i;
    }
  }
  split.i = maxI;
  return maxDist;
}

function fitCubic(
  pts: Vec2[],
  tHat1: Vec2,
  tHat2: Vec2,
  tolerance: number,
  out: BezierSeg[],
  depth: number,
): void {
  if (depth > 32) return; // pathological input guard
  if (pts.length === 2) {
    const d = vDist(pts[0], pts[1]) / 3;
    out.push({
      p0: pts[0],
      p1: vAdd(pts[0], vScale(tHat1, d)),
      p2: vAdd(pts[1], vScale(tHat2, d)),
      p3: pts[1],
    });
    return;
  }
  const u = chordParameterize(pts);
  let seg = generateBezier(u, tHat1, tHat2);
  const split = { i: 0 };
  let err = maxError(seg, u, split);
  if (err <= tolerance) {
    out.push(seg);
    return;
  }
  // Way off → the parameterization is at fault: re-fit once with improved
  // parameters before considering a split.
  if (err > tolerance * 4) {
    for (const e of u) e.t = reparameterize(seg, e.p, e.t);
    seg = generateBezier(u, tHat1, tHat2);
    err = maxError(seg, u, split);
    if (err <= tolerance) {
      out.push(seg);
      return;
    }
  }
  const center = vNorm(
    vSub(pts[Math.min(split.i + 1, pts.length - 1)], pts[Math.max(split.i - 1, 0)]),
  );
  fitCubic(pts.slice(0, split.i + 1), tHat1, center, tolerance, out, depth + 1);
  fitCubic(pts.slice(split.i), center, tHat2, tolerance, out, depth + 1);
}

/** Fit a freehand polyline with piecewise cubic Béziers under `tolerance`
 *  world units of deviation. Fewer than 2 points → []. */
export function fitCurve(points: Vec2[], tolerance = 8): BezierSeg[] {
  if (points.length < 2 || tolerance <= 0) return [];
  const tHat1 = vNorm(vSub(points[1], points[0]));
  const tHat2 = vNorm(vSub(points[points.length - 2], points[points.length - 1]));
  const out: BezierSeg[] = [];
  fitCubic(points, tHat1, tHat2, tolerance, out, 0);
  return out;
}
