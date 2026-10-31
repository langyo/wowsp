/** Tests for the roster → trajectory role resolution: the relation split
 *  every battle family maps onto (operation scenarios 行动 included —
 *  their rosters carry real side semantics), the marker join's
 *  operation-scenario one-pool JOIN semantic (colors read the relation
 *  afterwards), and the arena-state player-id join that makes mirror
 *  picks unambiguous. */
import { describe, expect, it } from "vitest";

import type { ArenaPlayer, EntityTrajectory, ShipInfo, VehicleEntry } from "@/api";
import { fakeAs } from "@/test-utils/fakes";
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

  it("keys hostile scenario slots on enemy — operations carry real sides", () => {
    // Operation rosters (行动) mark their allied escort waves ≤ 1 and the
    // hostile warships > 1, so the map tint follows the same split there.
    expect(roleFromRelation(3)).toBe("enemy");
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

  it("falls back to the shipId heuristics for entities a partial arena list does not cover", () => {
    // The Lesta synthesis shape: the arena covers the unique ships but
    // skips mirror picks; the uncovered entities must still join through
    // the shipId pass instead of dropping to null.
    const vehicles = [
      veh(1, "Me", 0, 100),
      veh(2, "MirrorA", 1, 200),
      veh(3, "MirrorB", 2, 200),
      veh(4, "UniqueFoe", 2, 300),
    ];
    const shipTrajs = [
      traj(10, 100, -50, 0), // Me — covered by the partial identities
      traj(11, 200, -50, 5), // mirror — NOT covered
      traj(12, 200, 50, -5), // mirror — NOT covered
      traj(13, 300, 60, 0), // unique foe — NOT covered
    ];
    const partial = new Map([
      [
        10,
        {
          team: 0 as const,
          playerId: 1,
          shipParamsId: 100,
          maxHealth: 0,
          isSelf: true,
        },
      ],
    ]);
    const a = resolveRosterAssignments(shipTrajs, vehicles, false, partial);
    // Covered entity joins authoritatively.
    expect(a.get(10)?.id).toBe(1);
    // Uncovered unique ship joins via shipId.
    expect(a.get(13)?.id).toBe(4);
    // Uncovered mirror pair resolves by spawn side (ally centroid from the
    // authoritative join, enemy centroid from the unique foe).
    const mirrorA = a.get(11)!;
    const mirrorB = a.get(12)!;
    expect(new Set([mirrorA.id, mirrorB.id])).toEqual(new Set([2, 3]));
    expect(mirrorA.relation <= 1).toBe(mirrorB.relation > 1);
    // Every entity is assigned something (no null degradation).
    for (const v of a.values()) expect(v).not.toBeNull();
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

  it("keys scenario-slot entries on their real side (operations included)", () => {
    // A hostile-slot scripted entry tints red even in an operation — the
    // one-fleet look is a LIST rule, never a color rule.
    const assignments = new Map([[10, veh(1, "IDS_OP_15_ALLY_DD_01", 2, 300)]]);
    expect(
      resolveMarkerContext(traj(10, 300, 0, 0), shipEntityIds, assignments, encyclopedia).role,
    ).toBe("enemy");
  });

  it("runs the spawn-order fallback without any operation override", () => {
    const assignments = new Map<number, VehicleEntry | null>([[11, null]]);
    // Entity 11 sits past the spawn-order half → "enemy", full stop.
    expect(resolveMarkerContext(traj(11, 999, 0, 0), shipEntityIds, assignments, encyclopedia).role)
      .toBe("enemy");
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
      [300, fakeAs<ShipInfo>({ type: "Submarine" })],
    ]);
    const assignments = new Map<number, VehicleEntry | null>([[11, null], [12, null]]);
    // Entity 11 = the recorder → self; entity 12 = the other team → enemy.
    const self = resolveMarkerContext(
      traj(11, 300, 0, 0), [11, 12], assignments, encyclopedia, identities,
    );
    expect(self.role).toBe("self");
    expect(self.shipInfo?.type).toBe("Submarine");
    const foe = resolveMarkerContext(
      traj(12, 300, 100, 100), [11, 12], assignments, encyclopedia, identities,
    );
    expect(foe.role).toBe("enemy");
  });

  it("returns null identities for replays without an arena state", () => {
    expect(arenaIdentities(undefined)).toBeNull();
    expect(arenaIdentities([])).toBeNull();
  });

  // ── the create-state teamId fallback ────────────────────────────────────
  // Scripted operation (行动) waves spawn MID-BATTLE, after the arena
  // broadcast, and the WW2 operation roster lists the player team only —
  // so these ships carry neither an arena identity nor a roster entry.
  // Their EntityCreate state still states the real side (kind.teamId),
  // which is what the map must tint from instead of the spawn-order guess
  // that painted the whole enemy fleet ally-green (user report
  // 2026-10-26, the 巴伦支海 WW2 operation replay).

  /** A ship trajectory whose create state carries an explicit team. */
  const teamTraj = (entityId: number, shipId: number, teamId: number): EntityTrajectory => ({
    entityId,
    kind: {
      entityType: 2,
      vehicleId: 0,
      initialX: 0,
      initialY: 0,
      initialZ: 0,
      creationTime: 60,
      shipId,
      teamId,
    },
    samples: [{ time: 60, entityId, vehicleId: 0, x: 0, y: 0, z: 0, yaw: 0 }],
  });

  it("tints roster-absent ships by their create-state team, never by spawn order", () => {
    // 7 human ships (entities 0..6) then two scripted waves: an escort on
    // the recorder's slot and a hostile wave — entity ids would sort both
    // waves PAST the half mark, so the legacy heuristic colors them
    // identically; only the teamId branch can split them.
    const shipEntityIds = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const encyclopedia = new Map<number, ShipInfo>([
      [910, fakeAs<ShipInfo>({ type: "Cruiser" })],
    ]);
    const assignments = new Map<number, VehicleEntry | null>([
      [7, null],
      [8, null],
    ]);
    const escort = resolveMarkerContext(
      teamTraj(7, 905, 0), shipEntityIds, assignments, encyclopedia, null,
    );
    expect(escort.role).toBe("ally");
    const foe = resolveMarkerContext(
      teamTraj(8, 910, 1), shipEntityIds, assignments, encyclopedia, null,
    );
    expect(foe.role).toBe("enemy");
    // The GameParams ship id rides the same create state — the ship-name
    // chain reads it instead of falling back to "#entityId".
    expect(foe.shipInfo?.type).toBe("Cruiser");
  });

  it("never resolves a recorder slot from the teamId branch alone", () => {
    // Only the arena's isSelf row earns the recorder tint; teamId 0 without
    // identities means "the recorder's team slot", i.e. an ally.
    const assignments = new Map<number, VehicleEntry | null>([[7, null]]);
    const role = resolveMarkerContext(
      teamTraj(7, 905, 0), [6, 7], assignments, new Map(), null,
    ).role;
    expect(role).toBe("ally");
  });

  it("rejects a shipId join contradicted by the create-state team", () => {
    // An operation enemy sailing a TEAMMATE's ship config: the roster (the
    // WW2 shape — the player team only) offers exactly one entry for the
    // shared shipId, and the unique join would absorb it (ally-green, the
    // teammate's name). The teamId contradiction rejects the join, and the
    // marker context falls through to the teamId branch (enemy).
    const vehicles = [veh(1, "langyo", 0, 300)];
    const shipTrajs = [
      traj(10, 300, 0, 0), // the teammate itself
      { ...teamTraj(11, 300, 1), samples: [{ time: 60, entityId: 11, vehicleId: 0, x: 40, y: 0, z: 40, yaw: 0 }] },
    ];
    const identities = new Map([
      [10, { team: 0, playerId: 1, shipParamsId: 300, maxHealth: 0, isSelf: true }],
    ]);
    const a = resolveRosterAssignments(shipTrajs, vehicles, false, identities);
    expect(a.get(10)?.id).toBe(1); // the teammate joins authoritatively
    expect(a.get(11)).toBeNull(); // the enemy's stolen join is refused
    const ctx = resolveMarkerContext(
      shipTrajs[1], shipTrajs.map((t) => t.entityId), a, new Map(), identities,
    );
    expect(ctx.role).toBe("enemy");
  });

  it("keeps the shipId join when the create-state team agrees with it", () => {
    // An ALLIED escort on the recorder's slot joining its roster entry
    // (the relation ≤ 1 escort wave) must survive the guard.
    const vehicles = [veh(1, "Escort", 1, 400)];
    const shipTrajs = [teamTraj(20, 400, 0)];
    const a = resolveRosterAssignments(shipTrajs, vehicles, false, null);
    expect(a.get(20)?.name).toBe("Escort");
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
