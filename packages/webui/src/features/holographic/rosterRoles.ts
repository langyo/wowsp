/**
 * Roster → trajectory role resolution for the holographic map, extracted
 * from HolographicMap.tsx. Pure functions over the replay streams: assign
 * each ship trajectory its roster entry (team role + shipId join) and map a
 * trajectory to its marker context. The resolved assignments live in the
 * map component; these helpers only compute them.
 */
import type { EntityTrajectory, ShipInfo, VehicleEntry } from "@/api";
import { roleFromRelation, type TeamRole } from "./teamColors";

/** Assign each ship trajectory its roster entry via the EntityCreate
 *  `shipId` (recovered from the state stream by the backend). Most shipIds
 *  are unique per match; when two players sail the same ship (mirror
 *  picks, bots), the collision is broken by spawn-side: centroids are
 *  computed from the unambiguous joins, and each ambiguous entity takes
 *  the same-side roster entry. Entities with no roster hit get `null` and
 *  fall back to the spawn-order team heuristic in `resolveMarkerContext`. */
export function resolveRosterAssignments(
  shipTrajs: EntityTrajectory[],
  vehicles: VehicleEntry[],
): Map<number, VehicleEntry | null> {
  const byShipId = new Map<number, VehicleEntry[]>();
  for (const v of vehicles) {
    const arr = byShipId.get(v.shipId) ?? [];
    arr.push(v);
    byShipId.set(v.shipId, arr);
  }
  const spawnOf = (t: EntityTrajectory) => ({
    x: t.kind?.initialX ?? t.samples[0]?.x ?? 0,
    z: t.kind?.initialZ ?? t.samples[0]?.z ?? 0,
  });
  const assignments = new Map<number, VehicleEntry | null>();
  const ambiguous: { traj: EntityTrajectory; entries: VehicleEntry[] }[] = [];
  for (const traj of shipTrajs) {
    const sid = traj.kind?.shipId;
    const entries = sid != null ? byShipId.get(sid) : undefined;
    if (entries && entries.length === 1) {
      assignments.set(traj.entityId, entries[0]);
    } else if (entries && entries.length > 1) {
      ambiguous.push({ traj, entries });
    } else {
      assignments.set(traj.entityId, null);
    }
  }
  if (ambiguous.length > 0) {
    let ax = 0, az = 0, an = 0, ex = 0, ez = 0, en = 0;
    // Roster entries already taken by unique joins — ambiguous picks must
    // not steal them, and two ambiguous entities must not share an entry.
    const claimed = new Set<VehicleEntry>();
    for (const traj of shipTrajs) {
      const a = assignments.get(traj.entityId);
      if (!a) continue;
      claimed.add(a);
      const s = spawnOf(traj);
      if (a.relation <= 1) { ax += s.x; az += s.z; an++; }
      else { ex += s.x; ez += s.z; en++; }
    }
    for (const { traj, entries } of ambiguous) {
      const unclaimed = entries.filter((e) => !claimed.has(e));
      let pick: VehicleEntry;
      if (an > 0 && en > 0) {
        const s = spawnOf(traj);
        const dAlly = (s.x - ax / an) ** 2 + (s.z - az / an) ** 2;
        const dEnemy = (s.x - ex / en) ** 2 + (s.z - ez / en) ** 2;
        const wantAlly = dAlly < dEnemy;
        pick =
          unclaimed.find((e) => (wantAlly ? e.relation <= 1 : e.relation > 1)) ??
          unclaimed[0] ??
          entries[0];
      } else {
        pick = unclaimed[0] ?? entries[0];
      }
      claimed.add(pick);
      assignments.set(traj.entityId, pick);
    }
  }
  return assignments;
}

/** Map each ship trajectory to its roster entry (for team role + ship
 *  model) via the precomputed roster assignments. When a trajectory has
 *  no matching roster entry (older replay, decode gap), the role falls
 *  back to the entity-id spawn-order heuristic: the client spawns team A
 *  before team B, so the first half of ships (by entity id) are treated
 *  as allies. Unresolved ships never claim the "self" role, so the
 *  recorder's own marker stays uniquely white. */
export function resolveMarkerContext(
  traj: EntityTrajectory,
  shipEntityIds: number[],
  assignments: Map<number, VehicleEntry | null>,
  encyclopedia: Map<number, ShipInfo>,
): { role: TeamRole; shipInfo: ShipInfo | null; entry: VehicleEntry | null } {
  const entry = assignments.get(traj.entityId) ?? null;
  let role: TeamRole;
  let shipInfo: ShipInfo | null;
  if (entry) {
    role = roleFromRelation(entry.relation);
    shipInfo = encyclopedia.get(entry.shipId) ?? null;
  } else {
    // Fallback: entity-id spawn order (team A spawns before team B).
    // Never "self" — only the exact match earns the recorder tint.
    const idx = shipEntityIds.indexOf(traj.entityId);
    const isAlly = idx >= 0 && idx < shipEntityIds.length / 2;
    role = isAlly ? "ally" : "enemy";
    shipInfo = null;
  }
  return { role, shipInfo, entry };
}
