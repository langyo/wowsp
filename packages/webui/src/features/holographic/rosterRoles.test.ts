/** Tests for the roster → trajectory role resolution, focused on the
 *  operation-scenario (行动) single-team semantic: relation values follow
 *  scenario team slots there, so roles and the mirror-pick spawn split
 *  must stop keying on them. */
import { describe, expect, it } from "vitest";

import type { EntityTrajectory, VehicleEntry } from "@/api";
import { resolveMarkerContext, resolveRosterAssignments } from "./rosterRoles";
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
