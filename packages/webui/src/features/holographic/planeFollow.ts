/**
 * Plane-follow card derivation for the holographic map's aircraft chase —
 * the pure sample math behind the bottom-left pill (HoloPlaneFollowCard):
 * how many planes of the chased squadron are still up (squadronStrength),
 * what the formation's launch strength was, whether it is in an attack run
 * right now (squadronAttacking), and the per-plane samples to judge that
 * from (squadronSamplesAt).
 *
 * Reads the SAME trail table followTargets.ts answers the camera from —
 * one trail per (planeId, formation index), id = planeId * 16 + index —
 * so the card can never disagree with what the camera actually follows.
 * No Vue / DOM / three.js state; refreshed at the 10 Hz hudCurrent cadence
 * (see HolographicMap's planeCardState watch), not per rendered frame.
 */
import type { PlaneTrailLike } from "./followTargets";
import { planeTrailExpiry } from "./planeFormation";
import { samplesUpTo } from "./trajectoryMath";

/** Live strength of a squadron: how many of its planes are still up
 *  (alive) against the launch strength (total). */
export interface SquadronStrength {
  alive: number;
  total: number;
}

/** Strength of one squadron at time t, or null when none of its planes is
 *  live at t (before the launch, after every trail expired).
 *
 *  A plane counts alive when its trail has a sample by t and the trail is
 *  inside the shared lifetime window — born <= t <= planeTrailExpiry(last
 *  sample, removeAt) — the same rule activeSquadronOf applies to the index-0
 *  anchor, evaluated per formation member so shot-down wingmen drop out of
 *  the count while the launch strength (largest formation index seen for
 *  this planeId, + 1) keeps the "12 / 24" denominator stable. Distinctness
 *  of the counted indexes is the trail table's own keying: (planeId, index)
 *  IS the trail identity, so each index appears at most once and the bit
 *  mask cannot double-count. */
export function squadronStrength(
  planeTrails: readonly PlaneTrailLike[],
  planeId: number,
  removeAt: ReadonlyMap<number, number>,
  t: number,
): SquadronStrength | null {
  let total = 0;
  // One bit per formation index (0..15): id % 16 is the index namespace.
  let aliveMask = 0;
  for (const trail of planeTrails) {
    if (Math.floor(trail.id / 16) !== planeId) continue;
    const index = trail.id % 16;
    if (index + 1 > total) total = index + 1;
    const samples = trail.samples;
    if (samples.length === 0) continue;
    // Not launched by t (a trail exists once its first update landed, so a
    // member launching later than the anchor stays invisible until then).
    if (samplesUpTo(samples, t) === 0) continue;
    const born = samples[0].time;
    const expiry = planeTrailExpiry(
      samples[samples.length - 1].time,
      removeAt.get(planeId),
    );
    if (born > t || t > expiry) continue;
    aliveMask |= 1 << index;
  }
  if (aliveMask === 0) return null;
  let alive = 0;
  for (let mask = aliveMask; mask !== 0; mask &= mask - 1) alive++;
  return { alive, total };
}

/** Pitch (degrees) at which a plane sample reads as an attack-run dive.
 *  WoWS attack runs pitch the models sharply down; −25° separates the dive
 *  from ordinary patrol climb/descend noise. The decoder (SquadronPlane.
 *  pitch) supplies it per update sample; older streams carry no pitch at
 *  all — undefined never counts as attacking. */
export const SQUADRON_ATTACK_PITCH_DEG = -25;

/** Whether ANY sampled plane of the formation is in an attack-run dive:
 *  at least one sample with a defined pitch <= SQUADRON_ATTACK_PITCH_DEG.
 *  Runs per card refresh over the formation's current samples (at most the
 *  squadron size, ≤16 entries). */
export function squadronAttacking(planes: readonly { pitch?: number }[]): boolean {
  for (const plane of planes) {
    if (plane.pitch != null && plane.pitch <= SQUADRON_ATTACK_PITCH_DEG) {
      return true;
    }
  }
  return false;
}

/** The formation's current samples: each member trail's last sample at or
 *  before t (members without one yet are skipped). Feed this to
 *  squadronAttacking — the dive state rides the newest update per plane. */
export function squadronSamplesAt(
  planeTrails: readonly PlaneTrailLike[],
  planeId: number,
  t: number,
): { pitch?: number }[] {
  const out: { pitch?: number }[] = [];
  for (const trail of planeTrails) {
    if (Math.floor(trail.id / 16) !== planeId) continue;
    const idx = samplesUpTo(trail.samples, t) - 1;
    if (idx >= 0) out.push(trail.samples[idx]);
  }
  return out;
}
