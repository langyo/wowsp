/** Tests for the roster → trajectory role resolution: the marker join's
 *  operation-scenario (行动) one-pool semantic (every marker reads as an
 *  ally there, so the side split stands down for MAP roles), and the
 *  arena-state player-id join that makes mirror picks unambiguous. */
import { describe, expect, it } from "vitest";

import type { ArenaPlayer, EntityTrajectory, ShipInfo, VehicleEntry } from "@/api";
import {
  arenaIdentities,
  resolveMarkerContext,
  resolveRosterAssignments,
} from "./rosterRoles";
import { roleFromRelation } from "./teamColors";

const veh = (id: number, name: string, relation: number, shipId: number): VehicleEntry => ({
  id,
  name,
  relation,
  shipId,
});

/** Minimal type-2 ship trajectory spawning at (x, z). */
const traj = (entityId: number, shipId: number, x: number, z: number): EntityTrajectory => ({
  entityId,
  kind: {
    entityType: 2,
    vehicleId: 0,
    initialX: x,
    initialY: 0,
    initialZ: z,
    creationTime: 0,
    shipId,
  },
  samples: [{ time: 0, entityId, vehicleId: 0, x, y: 0, z, yaw: 0 }],
});

describe("roleFromRelation", () => {
  it("classifies the recorder, allies and enemies in team-vs-team modes", () => {
    expect(roleFromRelation(0)).toBe("self");
    expect(roleFromRelation(1)).toBe("ally");
    expect(roleFromRelation(2)).toBe("enemy");
  });

  it("reads every scenario slot as ally in operations", () => {
    expect(roleFromRelation(0, true)).toBe("self");
    expect(roleFromRelation(1, true)).toBe("ally");
    expect(roleFromRelation(2, true)).toBe("ally");
    expect(roleFromRelation(3, true)).toBe("ally");
  });
});

describe("resolveRosterAssignments", () => {
  // Two unambiguous joins seed both spawn centroids; the mirror pair then
  // picks sides by spawn distance. Declaring the scenario ship (relation 2)
  // FIRST makes the operation branch's "first unclaimed" pick observably
  // different from the side-aware one.
  const vehicles = [
    veh(1, "Ally", 0, 100),
    veh(2, "Foe", 2, 200),
    veh(3, "IDS_OP_15_DUMMY_01", 2, 300),
    veh(4, "langyo", 0, 300),
  ];
  const trajs = [
    traj(11, 100, 0, 0),
    traj(12, 200, 100, 100),
    traj(13, 300, 2, 2),
    traj(14, 300, 98, 98),
  ];

  it("splits mirror picks by spawn side in team-vs-team modes", () => {
    const a = resolveRosterAssignments(trajs, vehicles);
    expect(a.get(13)?.name).toBe("langyo"); // near the ally centroid
    expect(a.get(14)?.name).toBe("IDS_OP_15_DUMMY_01"); // enemy side
  });

  it("treats the roster as one pool in operation scenarios", () => {
    const a = resolveRosterAssignments(trajs, vehicles, true);
    // No side split: the first unclaimed mirror entry wins regardless of
    // its scenario-slot relation or the spawn position.
    expect(a.get(13)?.name).toBe("IDS_OP_15_DUMMY_01");
    expect(a.get(14)?.name).toBe("langyo");
  });
});

describe("resolveMarkerContext", () => {
  const encyclopedia = new Map();
  const shipEntityIds = [10, 11];

  it("keys the role on relation in team-vs-team modes", () => {
    const assignments = new Map([[10, veh(1, "Foe", 2, 300)]]);
    expect(resolveMarkerContext(traj(10, 300, 0, 0), shipEntityIds, assignments, encyclopedia).role)
      .toBe("enemy");
  });

  it("reads scenario-slot entries as ally in operations", () => {
    const assignments = new Map([[10, veh(1, "IDS_OP_15_ALLY_DD_01", 2, 300)]]);
    expect(
      resolveMarkerContext(traj(10, 300, 0, 0), shipEntityIds, assignments, encyclopedia, true).role,
    ).toBe("ally");
  });

  it("forces the spawn-order fallback to ally in operations", () => {
    const assignments = new Map<number, VehicleEntry | null>([[11, null]]);
    // Entity 11 sits past the spawn-order half → "enemy" without the flag.
    expect(resolveMarkerContext(traj(11, 999, 0, 0), shipEntityIds, assignments, encyclopedia).role)
      .toBe("enemy");
    expect(
      resolveMarkerContext(traj(11, 999, 0, 0), shipEntityIds, assignments, encyclopedia, true).role,
    ).toBe("ally");
  });
});

describe("arena identities", () => {
  // Mirror match: both teams sail the same ship (shared shipId 300), so the
  // shipId join is ambiguous and the spawn-side heuristic got it wrong —
  // the arena's player-id join is the authority.
  const vehicles = [veh(1, "langyo", 0, 300), veh(2, "Player02", 2, 300)];
  const trajs = [traj(11, 300, 0, 0), traj(12, 300, 100, 100)];
  const players: ArenaPlayer[] = [
    {
      entityId: 11,
      teamId: 1,
      playerId: 1,
      shipParamsId: 300,
      maxHealth: 12600,
      name: "langyo",
      avatarId: 10,
      isSelf: true,
    },
    {
      entityId: 12,
      teamId: 0,
      playerId: 2,
      shipParamsId: 300,
      maxHealth: 14080,
      name: "Player02",
      avatarId: 20,
      isSelf: false,
    },
  ];

  it("joins mirror picks by roster player id, never by spawn side", () => {
    const identities = arenaIdentities(players)!;
    const a = resolveRosterAssignments(trajs, vehicles, false, identities);
    expect(a.get(11)?.name).toBe("langyo");
    expect(a.get(12)?.name).toBe("Player02");
  });

  it("carries the arena build health through as the max-HP source", () => {
    const identities = arenaIdentities(players)!;
    expect(identities.get(11)?.maxHealth).toBe(12600);
    expect(identities.get(12)?.maxHealth).toBe(14080);
    // A missing/zero field reads undefined so HP displays fall through to
    // their fallback chain instead of trusting a bogus 0.
    const bare = arenaIdentities([{ entityId: 13, teamId: 1 }])!;
    expect(bare.get(13)?.maxHealth).toBeUndefined();
  });

  it("splits mirror picks by spawn side when the arena state is missing", () => {
    // Same data, no identities: the legacy heuristic decides (and may get
    // either side right) — the point is it stays the fallback path.
    const a = resolveRosterAssignments(trajs, vehicles);
    expect(a.get(11)).toBeDefined();
    expect(a.get(12)).toBeDefined();
    expect(a.get(11)?.id).not.toBe(a.get(12)?.id);
  });

  it("roles ships off the team slot when the roster join misses", () => {
    const identities = arenaIdentities(players)!;
    // Only `type` matters for this assertion — the rest of ShipInfo is
    // unused by the role resolution.
    const encyclopedia = new Map<number, ShipInfo>([
      [300, { type: "Submarine" } as unknown as ShipInfo],
    ]);
    const assignments = new Map<number, VehicleEntry | null>([[11, null], [12, null]]);
    // Entity 11 = the recorder → self; entity 12 = the other team → enemy.
    const self = resolveMarkerContext(
      traj(11, 300, 0, 0), [11, 12], assignments, encyclopedia, false, identities,
    );
    expect(self.role).toBe("self");
    expect(self.shipInfo?.type).toBe("Submarine");
    const foe = resolveMarkerContext(
      traj(12, 300, 100, 100), [11, 12], assignments, encyclopedia, false, identities,
    );
    expect(foe.role).toBe("enemy");
  });

  it("returns null identities for replays without an arena state", () => {
    expect(arenaIdentities(undefined)).toBeNull();
    expect(arenaIdentities([])).toBeNull();
  });

  // A real 12v12 random battle (双峰海峡, 2026-09-29) with FIVE shipId
  // mirror groups — including the two Salmon submarines, one per team
  // (names anonymized). This is the match the spawn-side heuristic botched:
  // the recorder's own submarine rendered red as the enemy's mirror entry,
  // and half the allies were hidden at t=0 as unobserved "enemies".
  it("joins every ship of a real mirror-heavy match through the arena state", async () => {
    const fx = (await import("./rosterRoles.fixture.two-brothers.json")).default;
    const identities = arenaIdentities(fx.arenaPlayers)!;
    expect(identities.size).toBe(24);
    const shipTrajs = fx.ships as EntityTrajectory[];
    const a = resolveRosterAssignments(shipTrajs, fx.vehicles, false, identities);

    // Total + injective: every ship gets its own roster entry.
    expect(a.size).toBe(24);
    const claimed = [...a.values()].filter(Boolean).map((v) => v!.id);
    expect(new Set(claimed).size).toBe(24);

    // The recorder's entity is the arena isSelf entry and joins the
    // relation-0 roster entry.
    const selfPlayer = fx.arenaPlayers.find((p: ArenaPlayer) => p.isSelf)!;
    const selfEntry = a.get(selfPlayer.entityId);
    expect(selfEntry).toBeDefined();
    expect(selfEntry!.relation).toBe(0);

    // Roster side and arena team agree on all 24 — the regression itself.
    const byId = new Map(fx.vehicles.map((v: VehicleEntry) => [v.id, v]));
    for (const [entityId, entry] of a) {
      const team = fx.arenaPlayers.find(
        (p: ArenaPlayer) => p.entityId === entityId,
      )!.teamId;
      expect(entry, `entity ${entityId}`).not.toBeNull();
      expect(entry!.relation <= 1, `${byId.get(entry!.id)!.name}`).toBe(
        team === fx.selfTeam,
      );
    }
  });
});
