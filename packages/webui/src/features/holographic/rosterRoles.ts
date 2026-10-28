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
  /** Starting health of this exact build, straight from the arena state —
   *  the authoritative max-HP source for every HP display (see shipHp.ts). */
  maxHealth?: number;
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
      maxHealth: p.maxHealth || undefined,
      isSelf: !!p.isSelf,
    });
  }
  return m;
}

/** Assign each ship trajectory its roster entry. When the arena's initial
 * state decoded (`arenaIdentities`), the join is authoritative for the
 * entities it covers: the ship entity's roster player id comes from the
 * server, so mirror picks (two players on the same ship share one
 * `shipId`) can never be crossed. Entities the arena list does NOT cover
 * fall through to the EntityCreate `shipId` join below (a partial list is
 * what Lesta replays get — their arena roster is synthesized from the
 * container header and mirror picks are skipped rather than guessed):
 * most shipIds are unique per match; when two players sail the same ship
 * (mirror picks, bots), the collision is broken by spawn-side: centroids
 * are computed from the unambiguous joins, and each ambiguous entity
 * takes the same-side roster entry. Entities with no roster hit get
 * `null` and fall back to the spawn-order team heuristic in
 * `resolveMarkerContext`.
 *
 * Operation scenarios (`operation`, 行动) still join as one pool — the
 * mirror-pick side split stands down there (their scripted spawns share
 * shipIds heavily, so a proximity split would only shuffle guesses); the
 * roster relation each entity lands on still carries the real side the
 * map color reads afterwards. */
export function resolveRosterAssignments(
  shipTrajs: EntityTrajectory[],
  vehicles: VehicleEntry[],
  operation = false,
  identities?: Map<number, ArenaIdentity> | null,
): Map<number, VehicleEntry | null> {
  // Authoritative pass: roster join by arena player id (one roster entry
  // per player — mirror shipIds can't collide). Entities without an
  // identity stay unassigned here and flow into the heuristic pass below.
  const assignments = new Map<number, VehicleEntry | null>();
  const remaining: EntityTrajectory[] = [];
  if (identities && identities.size > 0) {
    const byPlayerId = new Map<number, VehicleEntry>();
    for (const v of vehicles) byPlayerId.set(v.id, v);
    for (const traj of shipTrajs) {
      const identity = identities.get(traj.entityId);
      const entry =
        identity?.playerId != null ? byPlayerId.get(identity.playerId) : undefined;
      if (entry) {
        assignments.set(traj.entityId, entry);
      } else {
        remaining.push(traj);
      }
    }
  } else {
    remaining.push(...shipTrajs);
  }
  if (remaining.length === 0) return assignments;
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
  const ambiguous: { traj: EntityTrajectory; entries: VehicleEntry[] }[] = [];
  const selfTeam = selfTeamOf(identities);
  for (const traj of remaining) {
    const sid = traj.kind?.shipId;
    const entries = sid != null ? byShipId.get(sid) : undefined;
    if (entries && entries.length === 1) {
      // The create-state teamId is authoritative for the versions that pin
      // it: a ship whose state says "other team" must never absorb a roster
      // entry just because the shipId matches — an operation enemy sailing a
      // teammate's ship would paint ally-green and read the teammate's name
      // (the roster itself only ever covers the ships that existed at match
      // start). Reject the join; the entity falls through to the teamId
      // branch of resolveMarkerContext.
      const kindTeam = traj.kind?.teamId;
      const contradicts =
        kindTeam != null &&
        (kindTeam === selfTeam) !== (roleFromRelation(entries[0].relation) !== "enemy");
      assignments.set(traj.entityId, contradicts ? null : entries[0]);
    } else if (entries && entries.length > 1) {
      ambiguous.push({ traj, entries });
    } else {
      assignments.set(traj.entityId, null);
    }
  }
  if (ambiguous.length > 0) {
    let ax = 0, az = 0, an = 0, ex = 0, ez = 0, en = 0;
    // Roster entries already taken — by the authoritative arena pass or by
    // unique heuristic joins — ambiguous picks must not steal them, and two
    // ambiguous entities must not share an entry.
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
 *  are treated as allies. The split holds in operation scenarios (行动)
 *  too — their roster relations carry real side semantics (escort waves
 *  ≤ 1, hostile warships > 1), so map colors follow the same rule as the
 *  other battle families; only the LIST surfaces collapse to one team. */
export function resolveMarkerContext(
  traj: EntityTrajectory,
  shipEntityIds: number[],
  assignments: Map<number, VehicleEntry | null>,
  encyclopedia: Map<number, ShipInfo>,
  identities?: Map<number, ArenaIdentity> | null,
): { role: TeamRole; shipInfo: ShipInfo | null; entry: VehicleEntry | null } {
  const entry = assignments.get(traj.entityId) ?? null;
  const identity = identities?.get(traj.entityId);
  let role: TeamRole;
  let shipInfo: ShipInfo | null;
  if (entry) {
    role = roleFromRelation(entry.relation);
    shipInfo = encyclopedia.get(entry.shipId) ?? null;
  } else if (identity) {
    role = identity.isSelf
      ? "self"
      : identity.team !== selfTeamOf(identities)
        ? "enemy"
        : "ally";
    shipInfo =
      identity.shipParamsId != null
        ? encyclopedia.get(identity.shipParamsId) ?? null
        : null;
  } else if (traj.kind?.teamId != null) {
    // Authoritative create-state team — the one side signal that covers
    // ships the arena broadcast never lists: scripted operation (行动)
    // waves spawn mid-battle, after the broadcast, and carry no roster
    // entry either (the WW2 operation roster lists the player team only).
    // Their EntityCreate state carries the real side, so the map tints
    // enemy-red / escort-green without any spawn-order guess. Never
    // "self" — the recorder always has its own arena/identity row.
    role = traj.kind.teamId === selfTeamOf(identities) ? "ally" : "enemy";
    shipInfo =
      traj.kind.shipId != null
        ? encyclopedia.get(traj.kind.shipId) ?? null
        : null;
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

/** The recorder's team slot, from the arena identity marked `isSelf`. */
function selfTeamOf(identities: Map<number, ArenaIdentity> | null | undefined): number {
  for (const identity of identities?.values() ?? []) {
    if (identity.isSelf) return identity.team;
  }
  return 0;
}
