/**
 * Aircraft-follow target resolution for the holographic map's chase camera.
 *
 * The map renders aircraft squadrons as per-plane trails (id = planeId * 16 +
 * formation index; see planeWarfare.buildPlaneTrails) and keeps the GLB model
 * pools positioned per playhead tick. This pure module answers the questions
 * the aircraft-chase camera asks every frame: WHICH squadron of a carrier is
 * airborne at time t (activeSquadronOf), WHERE the visible aircraft of one
 * rendered formation pool currently are (formationFollowPose), and — when
 * the formation has no rendered model this tick — what recorded anchor pose
 * to fall back to (anchorFollowPose). No Vue / DOM / renderer state — only
 * samples and already-positioned scene objects.
 */
import type * as THREE from "three";
import type { SquadronPlane } from "@/api";
import { samplesUpTo } from "./trajectoryMath";
import { PLANE_TRAIL_GRACE_S } from "./planeFormation";

/** One aircraft's sample trail, keyed by the composite plane id
 *  (planeId * 16 + formation index) — the shape of MapInternals.planeTrails. */
export interface PlaneTrailLike {
  id: number;
  samples: SquadronPlane[];
}

/** Plane id of the carrier's currently airborne squadron at t, or null.
 *
 *  Only the formation's index-0 anchor trail speaks for the squadron
 *  (id % 16 === 0); the wingmen trails share its lifetime. A squadron is
 *  alive from its launch (first sample) to five seconds after its last
 *  observed sample — but never past the minimap remove event (landed / shot
 *  down / recalled) when the replay recorded one, so a squadron that is
 *  removed early disappears on time even though its trail keeps extending.
 *
 *  When several of the carrier's squadrons overlap (a re-launch inside the
 *  previous trail's grace), the newest launch wins: the camera follows what
 *  the carrier most recently put in the air. The carrier link comes from
 *  ctx.planeCarrierOf (resolvePlaneCarriers). No allocation; runs per frame.
 */
export function activeSquadronOf(
  planeTrails: readonly PlaneTrailLike[],
  carrierOf: ReadonlyMap<number, number | null>,
  removeAt: ReadonlyMap<number, number>,
  carrierId: number,
  t: number,
): number | null {
  let bestPlaneId: number | null = null;
  let bestBorn = -Infinity;
  for (const trail of planeTrails) {
    // Formation members (index > 0) mirror the anchor's lifetime — skip them.
    if (trail.id % 16 !== 0) continue;
    const planeId = Math.floor(trail.id / 16);
    if (carrierOf.get(planeId) !== carrierId) continue;
    const samples = trail.samples;
    if (samples.length === 0) continue;
    // Must have launched by t: a trail only exists once its first update
    // landed, so the last sample at or before t has to exist.
    if (samplesUpTo(samples, t) === 0) continue;
    const born = samples[0].time;
    // Alive until ~5 s after the last sample or the remove event, whichever
    // comes first (removeAt precedes the trail's end when shot down).
    const last = samples[samples.length - 1].time;
    const expiry = Math.min(last + PLANE_TRAIL_GRACE_S, removeAt.get(planeId) ?? Infinity);
    if (born > t || t > expiry) continue;
    if (born > bestBorn) {
      bestBorn = born;
      bestPlaneId = planeId;
    }
  }
  return bestPlaneId;
}

/** Pose the chase camera should hang behind for one rendered formation pool:
 *  the centroid of the currently VISIBLE aircraft meshes plus the formation's
 *  real WoWS heading (every member of one formation carries the same heading,
 *  and mesh positions are scene-space because the pools are added straight to
 *  the scene root).
 *
 *  The meshes carry three.js `rotation.y = π − yaw` (markerUpdate's placement
 *  convention), while followCamera.applyFollowPose consumes the REAL yaw —
 *  returning the raw rotation here put the camera in front of the formation.
 *  The conversion lives here so every caller speaks the same convention.
 *
 *  Null when no aircraft of the formation is visible (pool missing or model
 *  still loading) — callers then try anchorFollowPose, then the carrier hull. */
export function formationFollowPose(
  pool: THREE.Object3D[] | undefined,
): { x: number; y: number; z: number; yaw: number } | null {
  if (!pool || pool.length === 0) return null;
  let count = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  let rotationY = 0;
  for (const mesh of pool) {
    if (!mesh.visible) continue;
    if (count === 0) rotationY = mesh.rotation.y;
    x += mesh.position.x;
    y += mesh.position.y;
    z += mesh.position.z;
    count++;
  }
  if (count === 0) return null;
  return { x: x / count, y: y / count, z: z / count, yaw: Math.PI - rotationY };
}

/** Recorded anchor pose for a formation without a rendered model this tick
 *  (Points fallback, model pack missing, or the GLB pool still loading): the
 *  last index-0 sample at or before t, mapped into scene space (z mirrored,
 *  altitude lifted to the formation floor) with the recorded REAL heading
 *  (SquadronPlane.yaw, 0 = north). This is the last-resort fallback: callers
 *  prefer the visible Points cloud slot when one is on screen, because the
 *  synthetic patrol centre is where the dots are actually drawn. Null when
 *  the anchor trail has no sample by t. */
export function anchorFollowPose(
  planeTrails: readonly PlaneTrailLike[],
  planeId: number,
  t: number,
): { x: number; y: number; z: number; yaw: number } | null {
  const anchorId = planeId * 16;
  for (const trail of planeTrails) {
    if (trail.id !== anchorId || trail.samples.length === 0) continue;
    const idx = samplesUpTo(trail.samples, t) - 1;
    if (idx < 0) return null;
    const s = trail.samples[idx];
    return { x: s.x, y: Math.max(60, s.y), z: -s.z, yaw: s.yaw };
  }
  return null;
}
