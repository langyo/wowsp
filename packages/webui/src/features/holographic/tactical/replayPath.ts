/**
 * Real-trajectory extraction: turn a replay `EntityTrajectory` into drawable
 * world polylines for the tactical board's pinned-path annotations.
 *
 * Mirrors the minimap's un-spotted rule: when the gap between two samples
 * exceeds `UNSEEN_GAP_S` seconds the ship was NOT observed, so the polyline
 * is split (no straight teleport line across the fog of war) — same
 * behaviour as `sampleAt` in HolographicMap, expressed for whole paths.
 */
import type { EntityTrajectory } from "@/api/client";
import type { Vec2 } from "./types";

export const UNSEEN_GAP_S = 4;

/**
 * World-space polylines for a trajectory. `upTo` (match seconds) slices the
 * samples the player has seen at that moment; `null` returns the full path.
 */
export function trajectoryPolylines(traj: EntityTrajectory, upTo: number | null): Vec2[][] {
  const samples = traj.samples;
  if (samples.length === 0) return [];
  const out: Vec2[][] = [];
  let cur: Vec2[] = [];
  let prevTime: number | null = null;
  for (const s of samples) {
    if (upTo != null && s.time > upTo) break;
    const p: Vec2 = { x: s.x, z: s.z };
    if (prevTime != null && s.time - prevTime > UNSEEN_GAP_S && cur.length > 0) {
      out.push(cur);
      cur = [];
    }
    // Skip duplicate-position samples within a continuous stretch so tiny
    // 1 m jitter doesn't bloat the polyline.
    const last = cur[cur.length - 1];
    if (!last || last.x !== p.x || last.z !== p.z) cur.push(p);
    prevTime = s.time;
  }
  if (cur.length > 0) out.push(cur);
  // Single-point runs render nothing — drop them.
  return out.filter((seg) => seg.length >= 2);
}
