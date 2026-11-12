/**
 * Chase-camera solver for the holographic map's follow mode, extracted from
 * HolographicMap.tsx. followSelected used to hard-stamp a fixed-distance pose
 * every frame, which also ate the wheel: OrbitControls' dolly moved the
 * camera, and the next tick stamped the old pose back. The distance now lives
 * in the caller — a wheel/pinch event flags a dolly, the next stamped frame
 * adopts the camera↔ship radius (clamped) as the follow distance, and this
 * solver re-stamps the pose along the SAME chase axis — so the wheel trims
 * the chase range while the view keeps hanging behind the ship's stern, and
 * the flag (not a per-frame radius readback) keeps the ship's own motion
 * from ever masquerading as zoom.
 */
import * as THREE from "three";
import { angleDiff } from "./trajectoryMath";

/** Stock chase framing: ~one hull length back, 0.4 of that up — a followed
 *  BB fills the view about like in-game. */
export const CHASE_RUN = 55;
export const CHASE_RISE = 22;
/** Camera↔target distance of the stock framing (the currency the dolly and
 *  the clamps speak; the stock pose's radius, not its horizontal run). */
export const FOLLOW_DIST_DEFAULT = Math.hypot(CHASE_RUN, CHASE_RISE);
/** Zoom clamps: just outside the nominal stern at the near end (hulls are
 *  nominally ~60 units, so 30 is the waterline — never inside the model), a
 *  high tactical overview at the far one. */
export const FOLLOW_DIST_MIN = 32;
export const FOLLOW_DIST_MAX = 2000;

/** Aircraft-follow chase distance: a squadron is far smaller than a hull, so
 *  the stock ship framing would fill the view with a wingtip — this pulled
 *  back preset keeps the whole formation readable while the camera still
 *  hangs behind it. Lives in the same clamp range as every follow distance. */
export const PLANE_FOLLOW_DIST_DEFAULT = 110;

/** AI-report keyframe-jump framing, deliberately pulled back from the stock
 *  chase range so a jump lands on a readable shot instead of hugging the
 *  hull / formation (avoid face-hugging); tunable, inside the clamp range. */
export const AI_FOCUS_SHIP_DIST = 180;
export const AI_FOCUS_PLANE_DIST = 160;

/** Clamp a follow distance to the chase zoom range. */
export function clampFollowDist(dist: number): number {
  return THREE.MathUtils.clamp(dist, FOLLOW_DIST_MIN, FOLLOW_DIST_MAX);
}

/** Which kind of follow target the framing state belongs to. */
export type FollowTargetKind = "ship" | "aircraft";

/** Remembered follow framing across target picks: the chase distance (stock,
 *  a pending one-shot preset, or the user's wheel zoom), whether that distance
 *  is still a pending preset, and the kind of the LAST follow target. The kind
 *  memory outlives clearing the target, so plane → hull-gap → empty-space
 *  clear → ship still resets to the ship stock instead of keeping the plane
 *  range. */
export interface FollowFramingState {
  dist: number;
  preset: boolean;
  kind: FollowTargetKind | null;
}

/** Stock chase distance for one target kind. */
export function stockFollowDist(kind: FollowTargetKind): number {
  return kind === "aircraft" ? PLANE_FOLLOW_DIST_DEFAULT : FOLLOW_DIST_DEFAULT;
}

/** Fresh framing state: ship stock, no pending preset, no kind memory. */
export function initialFollowFraming(): FollowFramingState {
  return { dist: FOLLOW_DIST_DEFAULT, preset: false, kind: null };
}

/** Advance the framing for a newly picked target. An explicit requested
 *  distance (the AI-report framing) becomes a pending one-shot; a target-kind
 *  switch or a still-pending preset restarts at that kind's stock distance;
 *  otherwise the user's remembered wheel zoom survives. */
export function followFramingFor(
  state: FollowFramingState,
  kind: FollowTargetKind,
  requestedDist?: number,
): FollowFramingState {
  if (requestedDist != null) {
    return { dist: clampFollowDist(requestedDist), preset: true, kind };
  }
  // A null kind (nothing picked yet) counts as a change: the very first
  // aircraft pick must start at the aircraft stock, not the initial ship one.
  const kindChanged = state.kind !== kind;
  if (state.preset || kindChanged) {
    return { dist: clampFollowDist(stockFollowDist(kind)), preset: false, kind };
  }
  return { ...state, kind };
}

/** Adopt a wheel/pinch zoom: the user's own framing supersedes a pending
 *  one-shot preset; the kind memory is unchanged. */
export function followFramingZoomed(
  state: FollowFramingState,
  dist: number,
): FollowFramingState {
  return { ...state, dist: clampFollowDist(dist), preset: false };
}

/** Drop the target: abandon a pending preset (restoring the last kind's stock
 *  framing) but KEEP the kind memory for the next pick. */
export function followFramingCleared(
  state: FollowFramingState,
): FollowFramingState {
  if (!state.preset) return state;
  return {
    dist: clampFollowDist(stockFollowDist(state.kind ?? "ship")),
    preset: false,
    kind: state.kind,
  };
}

/** Scratch direction, normalized per call and never handed out. */
const _dir = new THREE.Vector3();

/** Stamp the chase pose for a ship at `target` facing `yaw` (WoWS
 *  convention: the model points along local +Z, so its world forward is
 *  (sin yaw, 0, −cos yaw) with north = −Z) at camera↔target distance
 *  `dist`. The stock pitch (CHASE_RISE per CHASE_RUN of run) is baked into
 *  the axis, so dollying is a pure pull along it instead of flattening onto
 *  the horizon. Writes camera.position only — the orbit target is the
 *  caller's job (it glues the pivot to the same point). */
/** Chase-pose rise ratio: how much of the chase run the camera climbs.
 *  The stock ship framing (CHASE_RISE/CHASE_RUN) looks DOWN at a hull.
 *  Aircraft fly at altitude and are usually the HIGHEST thing on screen, so
 *  the same ratio puts the camera far BELOW them — the chase then stares up
 *  at the sky (user report: 对天望). The aircraft ratio is steeper so the
 *  camera always sits above the formation and looks down at it. */
export const PLANE_CHASE_RISE_RATIO = 0.85;

export function applyFollowPose(
  camera: THREE.Camera,
  target: THREE.Vector3,
  yaw: number,
  dist: number,
  riseRatio: number = CHASE_RISE / CHASE_RUN,
): void {
  _dir.set(-Math.sin(yaw), riseRatio, Math.cos(yaw)).normalize();
  camera.position.copy(target).addScaledVector(_dir, dist);
  // Never let the chase seat sink below the target's own altitude: an
  // aircraft target high above the sea would otherwise put the camera at
  // wave level looking up (the 对天望 shot). The rise term already lifts
  // it; this is the hard guarantee for extreme zoom-outs.
  if (camera.position.y < target.y) camera.position.y = target.y;
}

// ── Damped chase pivot ────────────────────────────────────────────────────
//
// The raw follow pose — the aircraft chain especially — steps between
// squadron update packets, and hard-stamping it every frame jittered the
// camera badly on plane chases. The pivot and yaw now run through a
// frame-rate-independent exponential smoother first; the stamped pose is
// built from the SMOOTHED values, so the chase hangs behind the formation
// instead of telegraphing every packet. Plain numbers throughout — this
// runs per rendered frame and must stay three.js-free.

/** Time constant τ of the chase-pivot smoothing, in seconds. 0.15 s is the
 *  "held but not floaty" spot: fast enough that the camera still reads as
 *  locked on, slow enough to absorb the packet cadence of sparse formations
 *  (samples stream every 0.1–2 s). α = 1 − exp(−dt/τ) makes the convergence
 *  rate independent of the panel's refresh rate. */
export const CHASE_SMOOTH_TAU_S = 0.15;

/** Pivot jump that counts as a CUT, not motion: scrubs, seeks, AI-report
 *  jumps and fresh target picks re-seat the camera on the raw pose instead
 *  of gliding across the map. Formation motion between two packets never
 *  covers this distance (the patrol orbit is ~50 units of radius), while a
 *  re-seat moves hundreds to thousands — the threshold separates the two. */
export const CHASE_SNAP_DIST = 120;

/** Damped-chase memory: the smoothed pivot + yaw the PREVIOUS stamped frame
 *  emitted, tagged with the playhead it belongs to. `t` rides the replay
 *  clock (not wall time) so paused playback never keeps easing, and a seek
 *  backwards is visible as a snap instead of a smooth reverse glide. */
export interface ChaseSmoothState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  t: number;
}

/** One smoothing step: the pose to stamp (already the state for the next
 *  call), the state to carry forward, and whether the raw pose came through
 *  untouched (first frame after a reset, or a snap condition). */
export interface SmoothedChasePose {
  state: ChaseSmoothState;
  x: number;
  y: number;
  z: number;
  yaw: number;
  snapped: boolean;
}

/** Advance the damped chase one frame: exponential smoothing (α =
 *  1 − exp(−dt/τ), τ = CHASE_SMOOTH_TAU_S) over the pivot and — through the
 *  shortest arc, so a formation turning across ±π rotates the short way —
 *  over the yaw. SNAPS (returns the raw pose, state re-seeded from it) when
 *  the pivot jumps farther than CHASE_SNAP_DIST in one step, when dt <= 0
 *  (paused playback: the stamped frame must stay exact) or when the playhead
 *  moves backwards. A null state is the fresh-target case and also snaps. */
export function smoothChasePose(
  state: ChaseSmoothState | null,
  pose: { x: number; y: number; z: number; yaw: number },
  t: number,
): SmoothedChasePose {
  if (
    state == null ||
    t <= state.t ||
    Math.hypot(pose.x - state.x, pose.y - state.y, pose.z - state.z) >
      CHASE_SNAP_DIST
  ) {
    return {
      state: { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw, t },
      x: pose.x,
      y: pose.y,
      z: pose.z,
      yaw: pose.yaw,
      snapped: true,
    };
  }
  const alpha = 1 - Math.exp(-(t - state.t) / CHASE_SMOOTH_TAU_S);
  // Shortest-arc yaw delta (the shared angleDiff primitive): the raw
  // difference across the ±π seam would swing the camera the long way.
  const dYaw = angleDiff(state.yaw, pose.yaw);
  const next: ChaseSmoothState = {
    x: state.x + (pose.x - state.x) * alpha,
    y: state.y + (pose.y - state.y) * alpha,
    z: state.z + (pose.z - state.z) * alpha,
    yaw: state.yaw + dYaw * alpha,
    t,
  };
  return {
    state: next,
    x: next.x,
    y: next.y,
    z: next.z,
    yaw: next.yaw,
    snapped: false,
  };
}
