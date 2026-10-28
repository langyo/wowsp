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

/** Clamp a follow distance to the chase zoom range. */
export function clampFollowDist(dist: number): number {
  return THREE.MathUtils.clamp(dist, FOLLOW_DIST_MIN, FOLLOW_DIST_MAX);
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
export function applyFollowPose(
  camera: THREE.Camera,
  target: THREE.Vector3,
  yaw: number,
  dist: number,
): void {
  _dir.set(-Math.sin(yaw), CHASE_RISE / CHASE_RUN, Math.cos(yaw)).normalize();
  camera.position.copy(target).addScaledVector(_dir, dist);
}
