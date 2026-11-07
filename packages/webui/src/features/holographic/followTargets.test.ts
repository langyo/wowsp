/** Unit tests for the aircraft-follow target resolution (pure functions). */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { SquadronPlane } from "@/api";
import {
  activeSquadronOf,
  anchorFollowPose,
  carrierHasAnySortie,
  formationFollowPose,
  latestSortiePlaneId,
} from "./followTargets";

/** One aircraft update sample at match time `time`. */
const sp = (time: number, planeId = 1, index = 0): SquadronPlane => ({
  time,
  planeId,
  index,
  x: 0,
  y: 100,
  z: 0,
  yaw: 0,
});

/** Anchor trail (index 0) of one squadron, one sample per given time. */
const trail = (planeId: number, times: number[], index = 0) => ({
  id: planeId * 16 + index,
  samples: times.map((t) => sp(t, planeId, index)),
});

/** No minimap remove events. */
const noRemoves = new Map<number, number>();

describe("activeSquadronOf", () => {
  it("returns null when there are no trails / samples", () => {
    expect(activeSquadronOf([], new Map(), noRemoves, 7, 10)).toBeNull();
    expect(
      activeSquadronOf(
        [{ id: 16, samples: [] }],
        new Map([[1, 7]]),
        noRemoves,
        7,
        10,
      ),
    ).toBeNull();
  });

  it("ignores formation-member trails (index > 0)", () => {
    const trails = [trail(1, [10, 20], 1), trail(1, [10, 20], 2)];
    expect(
      activeSquadronOf(trails, new Map([[1, 7]]), noRemoves, 7, 15),
    ).toBeNull();
  });

  it("returns the squadron's plane id while it is airborne", () => {
    const trails = [trail(3, [10, 20])];
    expect(
      activeSquadronOf(trails, new Map([[3, 7]]), noRemoves, 7, 15),
    ).toBe(3);
    // At the launch timestamp already airborne.
    expect(
      activeSquadronOf(trails, new Map([[3, 7]]), noRemoves, 7, 10),
    ).toBe(3);
  });

  it("is not airborne before its first sample or after last + 5 s", () => {
    const trails = [trail(3, [10, 20])];
    const carrierOf = new Map([[3, 7]]);
    expect(activeSquadronOf(trails, carrierOf, noRemoves, 7, 9.9)).toBeNull();
    expect(activeSquadronOf(trails, carrierOf, noRemoves, 7, 25)).toBe(3);
    expect(activeSquadronOf(trails, carrierOf, noRemoves, 7, 25.1)).toBeNull();
  });

  it("obeys the remove event even when the trail runs longer", () => {
    const trails = [trail(3, [10, 100])];
    const carrierOf = new Map([[3, 7]]);
    const removeAt = new Map([[3, 50]]);
    expect(activeSquadronOf(trails, carrierOf, removeAt, 7, 40)).toBe(3);
    // Removed at 50 → no longer airborne, although samples exist past it.
    expect(activeSquadronOf(trails, carrierOf, removeAt, 7, 60)).toBeNull();
    expect(activeSquadronOf(trails, carrierOf, removeAt, 7, 100)).toBeNull();
  });

  it("only matches squadrons whose carrier resolves to the asked carrier", () => {
    const trails = [trail(3, [10, 20]), trail(4, [10, 20])];
    const carrierOf = new Map<number, number | null>([
      [3, 7],
      [4, 8],
    ]);
    expect(activeSquadronOf(trails, carrierOf, noRemoves, 7, 15)).toBe(3);
    expect(activeSquadronOf(trails, carrierOf, noRemoves, 8, 15)).toBe(4);
    expect(activeSquadronOf(trails, carrierOf, noRemoves, 9, 15)).toBeNull();
    // Unresolved carrier (null) never matches a real carrier id.
    const unresolved = new Map<number, number | null>([[3, null]]);
    expect(activeSquadronOf(trails, unresolved, noRemoves, 7, 15)).toBeNull();
  });

  it("picks the most recently launched overlapping squadron", () => {
    const trails = [trail(3, [10, 30]), trail(4, [20, 40]), trail(5, [5, 15])];
    const carrierOf = new Map<number, number | null>([
      [3, 7],
      [4, 7],
      [5, 7],
    ]);
    // t=25: squadron 3 (born 10) and 4 (born 20) overlap → 4 is newest.
    expect(activeSquadronOf(trails, carrierOf, noRemoves, 7, 25)).toBe(4);
    // t=6: only squadron 5 (born 5) is up.
    expect(activeSquadronOf(trails, carrierOf, noRemoves, 7, 6)).toBe(5);
  });
});

describe("formationFollowPose", () => {
  /** One formation mesh positioned in scene space. `yaw` is the REAL WoWS
   *  heading; the mesh stores three.js rotation.y = π − yaw (markerUpdate's
   *  placement convention), exactly like the live aircraft layer. */
  const mesh = (
    x: number,
    y: number,
    z: number,
    yaw: number,
    visible = true,
  ) => {
    const obj = new THREE.Object3D();
    obj.position.set(x, y, z);
    obj.rotation.y = Math.PI - yaw;
    obj.visible = visible;
    return obj;
  };

  it("returns null for a missing / empty pool", () => {
    expect(formationFollowPose(undefined)).toBeNull();
    expect(formationFollowPose([])).toBeNull();
  });

  it("returns null when no aircraft of the formation is visible", () => {
    expect(
      formationFollowPose([mesh(0, 100, 0, 0, false), mesh(10, 100, 10, 1, false)]),
    ).toBeNull();
  });

  it("centroids the visible meshes and takes the first visible yaw", () => {
    const pool = [
      mesh(0, 100, 0, 0.5),
      mesh(20, 120, 40, 1.2),
      // Hidden members must not drag the centroid or supply the yaw.
      mesh(9999, 9999, 9999, 9, false),
    ];
    expect(formationFollowPose(pool)).toEqual({
      x: 10,
      y: 110,
      z: 20,
      yaw: 0.5,
    });
  });

  it("takes the yaw from the first VISIBLE mesh, not pool[0]", () => {
    const pool = [mesh(0, 100, 0, 5, false), mesh(10, 100, 0, 1.5)];
    expect(formationFollowPose(pool)).toEqual({
      x: 10,
      y: 100,
      z: 0,
      yaw: 1.5,
    });
  });

  it("converts the three.js rotation back to the real WoWS heading", () => {
    // North-facing formation: rotation.y = π, real yaw = 0 → the chase
    // camera hangs at +Z (behind), not in front (regression for the raw
    // rotation.y hand-off).
    const north = mesh(0, 100, 0, 0);
    expect(north.rotation.y).toBeCloseTo(Math.PI);
    expect(formationFollowPose([north])?.yaw).toBeCloseTo(0);
    expect(formationFollowPose([mesh(0, 100, 0, Math.PI / 2)])?.yaw).toBeCloseTo(
      Math.PI / 2,
    );
  });
});

describe("anchorFollowPose", () => {
  const sample = (time: number, x: number, y: number, z: number, yaw: number) => ({
    time,
    planeId: 3,
    index: 0,
    x,
    y,
    z,
    yaw,
  });

  it("returns null for a missing anchor trail / before its first sample", () => {
    expect(anchorFollowPose([], 3, 10)).toBeNull();
    const trails = [{ id: 3 * 16, samples: [sample(10, 5, 90, 7, 0.2)] }];
    expect(anchorFollowPose(trails, 3, 9.9)).toBeNull();
    expect(anchorFollowPose(trails, 4, 20)).toBeNull();
  });

  it("maps the last anchor sample into scene space with its real heading", () => {
    const trails = [
      {
        id: 3 * 16,
        samples: [
          sample(10, 5, 40, 7, 0.2),
          sample(20, 16, 120, -30, 1.1),
        ],
      },
    ];
    // Last sample at or before t: scene z mirrored, altitude lifted to the
    // formation floor, real yaw untouched.
    expect(anchorFollowPose(trails, 3, 20)).toEqual({
      x: 16,
      y: 120,
      z: 30,
      yaw: 1.1,
    });
    expect(anchorFollowPose(trails, 3, 15)).toEqual({
      x: 5,
      y: 60,
      z: -7,
      yaw: 0.2,
    });
  });
});

describe("carrierHasAnySortie", () => {
  it("is false without trails, without samples, or for other carriers", () => {
    expect(carrierHasAnySortie([], new Map(), 7)).toBe(false);
    // Empty anchor trail: a create without a single update is no sortie.
    expect(
      carrierHasAnySortie([{ id: 1 * 16, samples: [] }], new Map([[1, 7]]), 7),
    ).toBe(false);
    // Formation-member trails don't speak for the squadron.
    expect(
      carrierHasAnySortie([trail(1, [10, 20], 1)], new Map([[1, 7]]), 7),
    ).toBe(false);
    expect(
      carrierHasAnySortie([trail(1, [10, 20])], new Map([[1, 8]]), 7),
    ).toBe(false);
    // Unresolved carrier (null) never matches a real carrier id.
    expect(
      carrierHasAnySortie([trail(1, [10, 20])], new Map([[1, null]]), 7),
    ).toBe(false);
  });

  it("is true whenever the carrier flew ANY sampled sortie, time ignored", () => {
    const carrierOf = new Map<number, number | null>([[3, 7]]);
    // A sortie late in the replay counts even at playhead 0 — the menu row
    // must exist before the formation ever launches.
    expect(carrierHasAnySortie([trail(3, [900, 950])], carrierOf, 7)).toBe(true);
    expect(carrierHasAnySortie([trail(3, [10, 20])], carrierOf, 7)).toBe(true);
    // A long-finished sortie (remove event long past) still counts: expiry
    // is not this function's business.
    expect(carrierHasAnySortie([trail(3, [10, 100])], carrierOf, 7)).toBe(true);
  });
});

describe("latestSortiePlaneId", () => {
  it("returns the carrier's most recently launched sampled sortie", () => {
    const carrierOf = new Map<number, number | null>([
      [3, 7],
      [4, 7],
      [5, 8],
    ]);
    expect(
      latestSortiePlaneId([trail(3, [10, 30]), trail(4, [20, 40])], carrierOf, 7),
    ).toBe(4);
    // A later-born sortie of ANOTHER carrier doesn't win for carrier 7.
    expect(
      latestSortiePlaneId(
        [trail(3, [10, 30]), trail(4, [20, 40]), trail(5, [50, 60])],
        carrierOf,
        7,
      ),
    ).toBe(4);
    expect(latestSortiePlaneId([], carrierOf, 7)).toBeNull();
    // Empty-sampled and foreign trails don't provide a representative.
    expect(
      latestSortiePlaneId([{ id: 6 * 16, samples: [] }], new Map([[6, 7]]), 7),
    ).toBeNull();
  });
});
