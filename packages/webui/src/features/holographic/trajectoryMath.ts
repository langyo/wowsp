/**
 * Trajectory stream math for the holographic map — pure sample lookups over
 * the decoded per-entity timelines, extracted verbatim from
 * HolographicMap.tsx so the minimap painter, the per-frame marker refresh
 * and the capture simulator all share one implementation.
 *
 * `sampleAt` is THE interpolation primitive (linear between neighbours, with
 * the un-spotted gap freeze); `hpAtTime` / `progressAtTime` are step lookups
 * over the HP / capture-progress streams. All run per frame, so everything
 * here stays allocation-light and O(log n) where it matters.
 */
import type { HpSample } from "@/api";

/** Max sample gap still interpolated smoothly. Beyond it the entity was
 *  un-spotted (gaps of 20 s to minutes occur for enemies) and the marker
 *  HOLDS the last observed pose — like the in-game minimap — instead of
 *  gliding on a straight line with a slowly rotating heading, which sailed
 *  ships straight across islands at weird angles. Spotted ships stream
 *  every 0.1–2 s, so 4 s cleanly separates the two regimes. */
const UNSEEN_GAP_S = 4;

/** Interpolate a sample at time t (linear between neighbors). */
export function sampleAt(
  traj: { samples: { time: number; x: number; z: number; yaw: number }[] },
  t: number,
) {
  const ss = traj.samples;
  if (t <= ss[0].time) return ss[0];
  if (t >= ss[ss.length - 1].time) return ss[ss.length - 1];
  // Binary search: called per frame from the capture simulation and the
  // aircraft cloud, so keep it O(log n).
  let lo = 0;
  let hi = ss.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ss[mid].time < t) lo = mid;
    else hi = mid;
  }
  const a = ss[lo];
  const b = ss[hi];
  // Un-spotted gap: freeze at the last known pose until re-detection.
  if (b.time - a.time > UNSEEN_GAP_S) return a;
  const f = (t - a.time) / (b.time - a.time || 1);
  return {
    ...a,
    x: a.x + (b.x - a.x) * f,
    z: a.z + (b.z - a.z) * f,
    yaw: a.yaw + angleDiff(a.yaw, b.yaw) * f,
  };
}

export function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Find the last HP value at or before time t. */
export function hpAtTime(samples: HpSample[] | undefined, t: number): number | null {
  if (!samples || samples.length === 0) return null;
  let last: number = samples[0].value;
  for (const s of samples) {
    if (s.time > t) break;
    last = s.value;
  }
  return last;
}

/** Capture progress (0..1000) at time t from the game's own stream.
 *  STEP semantics, zero outside the stream's span: a home point emits no
 *  samples until it is first contested (the Canada 2-cap's own point's
 *  first sample is at t=311s) — extrapolating that first sample back to
 *  t=0 made every home point read "being captured" from the opening
 *  second. Values hold between samples (the game reports on change). */
export function progressAtTime(samples: HpSample[] | undefined, t: number): number | null {
  if (!samples || samples.length === 0) return null;
  if (t < samples[0].time) return 0;
  let v = samples[0].value;
  for (const s of samples) {
    if (s.time <= t) v = s.value;
    else break;
  }
  return v;
}
