/**
 * Deterministic 2D-minimap motion helpers, shared by the minimap painter
 * (thumb + enlarged overlay) and the enlarged map's hover picker.
 *
 * Three jobs live here, all pure given (samples, t):
 *
 *  - Aircraft smoothing: the replay's squadron stream only emits positions
 *    every so often (and sometimes jumps), so a marker pinned to the last
 *    sample stepped across the map. planeSmoothPosAt interpolates between
 *    neighbours AND eases the marker toward that target with a frame-rate
 *    independent exponential (state per trail lives in MapInternals), which
 *    turns recorded teleports into a short glide instead of a snap.
 *  - Unspotted-gap bridging: ship trajectories freeze at the last observed
 *    sample while the ship is dark (UNSEEN_GAP_S); trailGapLinks names the
 *    short dark windows the playhead has crossed so the painter can draw a
 *    translucent dashed inference line between the two observed poses.
 *  - Fighter-patrol wards: activeWards resolves the alive window of every
 *    receive_wardAdded entry (add → first remove after it) the same way the
 *    3D overlay rings do, so the 2D circles can never drift from the 3D ones.
 *
 * Also hosts the marker-size / speed constants both painters and the hover
 * picker must agree on (torpedo triangles, torpedo run speed).
 */
import type { SquadronPlane, WardEvent, WardRemoveEvent } from "@/api";
import { angleDiff, UNSEEN_GAP_S } from "./trajectoryMath";
import { clampXZ } from "./sceneUtils";

// ── Torpedo markers ────────────────────────────────────────────────────
/** Half-width of the in-game torpedo triangle (apex-to-base units) on the
 *  ENLARGED 2D map. Deliberately small: a full salvo is a dozen markers and
 *  the old 8 px wedges buried the fleets under them. */
export const TORPEDO_TRI_PX_ENLARGED = 5.5;
/** Same half-width for the 160 px thumbnail (proportionally smaller still). */
export const TORPEDO_TRI_PX_THUMB = 3;
/** Torpedo run speed in world units per battle second (≈60 kn at the
 *  engine's ~4.5 m/unit scale — see markerUpdate's torpedo pass). */
export const TORPEDO_SPEED_UNITS_S = 7;

// ── Unspotted-gap bridges ──────────────────────────────────────────────
/** Longest un-spotted gap (battle seconds) still bridged by a translucent
 *  dashed inference line. Gaps start at UNSEEN_GAP_S (4 s — fine-grained
 *  re-spot cadence); anything beyond this window is a genuinely lost ship
 *  and its trail keeps the open pen-lift. */
export const TRAIL_GAP_LINK_MAX_S = 20;

// ── Aircraft smoothing ─────────────────────────────────────────────────
/** Exponential ease time constant (battle seconds) for aircraft markers.
 *  Small enough to stay glued to a live squadron, large enough to turn a
 *  recorded jump into a readable glide. */
export const PLANE_SMOOTH_TAU_S = 0.28;
/** Playhead jump that snaps smoothing instead of easing: larger than the
 *  normal redraw step even at 10× playback, so seeks/scrubs never leave a
 *  marker lagging behind its recorded position. */
export const PLANE_SMOOTH_SNAP_S = 0.5;

/** One smoothed aircraft pose (world XZ + heading in radians). */
export interface PlanePos {
  x: number;
  z: number;
  yaw: number;
}

/** Persistent per-trail smoothing state, owned by MapInternals. */
export interface PlaneAnimState extends PlanePos {
  /** Playhead the state was last advanced to. */
  t: number;
}

/** Raw (piecewise-linear) aircraft pose at battle time `t`. Times outside
 *  the stream clamp to its first/last sample so callers never see NaN; an
 *  empty stream answers null. */
export function planeRawPosAt(
  samples: SquadronPlane[],
  t: number,
): PlanePos | null {
  const n = samples.length;
  if (n === 0) return null;
  if (t <= samples[0].time) {
    return { x: samples[0].x, z: samples[0].z, yaw: samples[0].yaw };
  }
  const last = samples[n - 1];
  if (t >= last.time) return { x: last.x, z: last.z, yaw: last.yaw };
  // Binary search for the segment containing t (samples are time-sorted).
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].time < t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.time - a.time;
  if (span <= 1e-6) return { x: b.x, z: b.z, yaw: b.yaw };
  const f = (t - a.time) / span;
  return {
    x: a.x + (b.x - a.x) * f,
    z: a.z + (b.z - a.z) * f,
    yaw: a.yaw + angleDiff(a.yaw, b.yaw) * f,
  };
}

/** Smooth aircraft pose at `t`: the raw pose eased toward with an
 *  exponential decay state. The FIRST call for a trail (and any seek, which
 *  shows up as a playhead step beyond PLANE_SMOOTH_SNAP_S) snaps to the raw
 *  pose; every later call advances one redraw step. Two passes over the same
 *  `t` in one frame (thumb, then the enlarged canvas) return the cached
 *  pose instead of easing twice. */
export function planeSmoothPosAt(
  id: number,
  samples: SquadronPlane[],
  t: number,
  state: Map<number, PlaneAnimState>,
): PlanePos | null {
  const raw = planeRawPosAt(samples, t);
  if (!raw) return null;
  const prev = state.get(id);
  // Same playhead (the second canvas of one frame): reuse the eased pose.
  if (prev && t === prev.t) return { x: prev.x, z: prev.z, yaw: prev.yaw };
  if (!prev || t < prev.t || t - prev.t > PLANE_SMOOTH_SNAP_S) {
    const snap: PlaneAnimState = { x: raw.x, z: raw.z, yaw: raw.yaw, t };
    state.set(id, snap);
    return { x: raw.x, z: raw.z, yaw: raw.yaw };
  }
  const dt = t - prev.t;
  const alpha = 1 - Math.exp(-dt / PLANE_SMOOTH_TAU_S);
  const next: PlaneAnimState = {
    x: prev.x + (raw.x - prev.x) * alpha,
    z: prev.z + (raw.z - prev.z) * alpha,
    yaw: prev.yaw + angleDiff(prev.yaw, raw.yaw) * alpha,
    t,
  };
  state.set(id, next);
  return { x: next.x, z: next.z, yaw: next.yaw };
}

// ── Ship trail gap bridges ─────────────────────────────────────────────
/** One inferred straight run across a short un-spotted window (world XZ). */
export interface TrailGapLink {
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  /** Dark window length in battle seconds. */
  gapS: number;
}

/** Short unspotted gaps the playhead has fully crossed: both the last
 *  observed sample and the re-detection sample sit at/before `t`. Gaps up
 *  to UNSEEN_GAP_S are already drawn as ordinary trail segments; gaps past
 *  `maxGapS` are genuine losses and stay open. */
export function trailGapLinks(
  samples: { time: number; x: number; z: number }[],
  t: number,
  maxGapS: number = TRAIL_GAP_LINK_MAX_S,
): TrailGapLink[] {
  const out: TrailGapLink[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (b.time > t) break;
    const gapS = b.time - a.time;
    if (gapS <= UNSEEN_GAP_S || gapS > maxGapS) continue;
    out.push({ fromX: a.x, fromZ: a.z, toX: b.x, toZ: b.z, gapS });
  }
  return out;
}

// ── Fighter-patrol wards ───────────────────────────────────────────────
/** Wards alive at battle time `t`: from an add until the FIRST remove for
 *  the same squadron AFTER that add (wards can be re-deployed under the same
 *  id — a remove in the same tick belongs to the previous deployment). The
 *  3D overlay rings (actorBuild) use the same rule. */
export function activeWards(
  wards: WardEvent[],
  removes: WardRemoveEvent[],
  t: number,
): WardEvent[] {
  if (wards.length === 0) return [];
  const out: WardEvent[] = [];
  for (const w of wards) {
    if (t < w.time) continue;
    let end: number | null = null;
    for (const r of removes) {
      if (r.planeId !== w.squadronId || r.time <= w.time) continue;
      if (end == null || r.time < end) end = r.time;
    }
    if (end != null && t > end) continue;
    out.push(w);
  }
  return out;
}

// ── Torpedo marker position ────────────────────────────────────────────
/** Straight-run torpedo pose: launch anchor + direction × TORPEDO_SPEED ×
 *  age, clamped to the playable map rect exactly like the 3D fish (long-lived
 *  un-joined torpedoes park at the edge instead of sailing off-map). Scene
 *  coordinates (z = -worldZ), matching the 3D torpedo meshes. */
export function torpedoPosAt(
  run: { base: { x: number; z: number }; dir: { x: number; z: number } },
  age: number,
  mapRect: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null,
): { x: number; z: number } {
  return clampXZ(
    run.base.x + run.dir.x * TORPEDO_SPEED_UNITS_S * age,
    run.base.z + run.dir.z * TORPEDO_SPEED_UNITS_S * age,
    mapRect,
  );
}
