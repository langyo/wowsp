/**
 * Roster → trajectory role resolution for the holographic map, extracted
 * from HolographicMap.tsx. Pure functions over the replay streams: assign
 * each ship trajectory its roster entry (team role + shipId join) and map a
 * trajectory to its marker context. The resolved assignments live in the
 * map component; these helpers only compute them.
 */
import type { ArenaPlayer, EntityTrajectory, ShipInfo, VehicleEntry } from "@/api";
import { roleFromRelation, type TeamRole } from "./teamColors";

/** Authoritative per-entity identity, distilled from the arena's initial
 *  state: the ship entity's team slot, its roster player id and its
 *  GameParams ship id, plus which entity is the recorder's own. */
export interface ArenaIdentity {
  team: number;
  playerId?: number;
  shipParamsId?: number;
  isSelf: boolean;
}

/** Distil the arena player list into per-entity identities. `null` when the
 *  arena state is missing (old replays, unpinned versions) — consumers then
 *  fall back to the shipId join + spawn-side heuristics. */
export function arenaIdentities(
  arenaPlayers: ArenaPlayer[] | undefined,
): Map<number, ArenaIdentity> | null {
  if (!arenaPlayers || arenaPlayers.length === 0) return null;
  const m = new Map<number, ArenaIdentity>();
  for (const p of arenaPlayers) {
    m.set(p.entityId, {
      team: p.teamId,
      playerId: p.playerId || undefined,
      shipParamsId: p.shipParamsId || undefined,
      isSelf: !!p.isSelf,
    });
  }
  return m;
}

/** Assign each ship trajectory its roster entry. When the arena's initial
 *  state decoded (`arenaIdentities`), the join is authoritative: the ship
 *  entity's roster player id comes from the server, so mirror picks (two
 *  players on the same ship share one `shipId`) can never be crossed.
 *  Without it the join falls back to the EntityCreate `shipId` (recovered
 *  from the state stream by the backend): most shipIds are unique per
 *  match; when two players sail the same ship (mirror picks, bots), the
 *  collision is broken by spawn-side: centroids are computed from the
 *  unambiguous joins, and each ambiguous entity takes the same-side roster
 *  entry. Entities with no roster hit get `null` and fall back to the
 *  spawn-order team heuristic in `resolveMarkerContext`.
 *
 *  Operation scenarios (`operation`, 行动) skip the side split entirely —
 *  their relation values follow scenario team slots, so there is just one
 *  pool and ambiguous entities take the first unclaimed entry. */
export function resolveRosterAssignments(
  shipTrajs: EntityTrajectory[],
  vehicles: VehicleEntry[],
  operation = false,
  identities?: Map<number, ArenaIdentity> | null,
): Map<number, VehicleEntry | null> {
  // Authoritative path: roster join by arena player id (one roster entry
  // per player — mirror shipIds can't collide).
  if (identities && identities.size > 0) {
    const byPlayerId = new Map<number, VehicleEntry>();
    for (const v of vehicles) byPlayerId.set(v.id, v);
    const assignments = new Map<number, VehicleEntry | null>();
    for (const traj of shipTrajs) {
      const identity = identities.get(traj.entityId);
      const entry =
        identity?.playerId != null ? byPlayerId.get(identity.playerId) : undefined;
      assignments.set(traj.entityId, entry ?? null);
    }
    return assignments;
  }
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
      if (operation || a.relation <= 1) { ax += s.x; az += s.z; an++; }
      else { ex += s.x; ez += s.z; en++; }
    }
    for (const { traj, entries } of ambiguous) {
      const unclaimed = entries.filter((e) => !claimed.has(e));
      let pick: VehicleEntry;
      if (!operation && an > 0 && en > 0) {
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
 *  no matching roster entry, the authoritative arena identity (when the
 *  arena state decoded) supplies the team — self via its own entry, allies
 *  by team slot — and the encyclopedia lookup falls back to the arena's
 *  GameParams ship id. Only when even the arena state is missing does the
 *  role fall back to the entity-id spawn-order heuristic: the client
 *  spawns team A before team B, so the first half of ships (by entity id)
 *  are treated as allies. Operation scenarios (`operation`) read every
 *  roster entry as ally — their relation values follow scenario team
 *  slots, not enemy semantics. */
export function resolveMarkerContext(
  traj: EntityTrajectory,
  shipEntityIds: number[],
  assignments: Map<number, VehicleEntry | null>,
  encyclopedia: Map<number, ShipInfo>,
  operation = false,
  identities?: Map<number, ArenaIdentity> | null,
): { role: TeamRole; shipInfo: ShipInfo | null; entry: VehicleEntry | null } {
  const entry = assignments.get(traj.entityId) ?? null;
  const identity = identities?.get(traj.entityId);
  let role: TeamRole;
  let shipInfo: ShipInfo | null;
  if (entry) {
    role = roleFromRelation(entry.relation, operation);
    shipInfo = encyclopedia.get(entry.shipId) ?? null;
  } else if (identity) {
    role = identity.isSelf
      ? "self"
      : !operation && identity.team !== selfTeamOf(identities)
        ? "enemy"
        : "ally";
    shipInfo =
      identity.shipParamsId != null
        ? encyclopedia.get(identity.shipParamsId) ?? null
        : null;
  } else {
    // Fallback: entity-id spawn order (team A spawns before team B).
    // Never "self" — only the exact match earns the recorder tint.
    const idx = shipEntityIds.indexOf(traj.entityId);
    const isAlly = idx >= 0 && idx < shipEntityIds.length / 2;
    role = isAlly || operation ? "ally" : "enemy";
    shipInfo = null;
  }
  return { role, shipInfo, entry };
}

/** The recorder's team slot, from the arena identity marked `isSelf`. */
function selfTeamOf(identities: Map<number, ArenaIdentity> | null | undefined): number {
  for (const identity of identities?.values() ?? []) {
    if (identity.isSelf) return identity.team;
  }
  return 0;
}
