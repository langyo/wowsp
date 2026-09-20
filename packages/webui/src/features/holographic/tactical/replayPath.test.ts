/** Trajectory → polyline extraction tests (fog-of-war gap splitting, time
 * slicing, sample de-duplication). */
import { describe, expect, it } from "vitest";
import type { EntityTrajectory } from "@/api/client";
import { trajectoryPolylines } from "./replayPath";

function traj(samples: { time: number; x: number; z: number }[]): EntityTrajectory {
  return {
    entityId: 1,
    samples: samples.map((s) => ({
      time: s.time,
      entityId: 1,
      vehicleId: 1,
      x: s.x,
      y: 0,
      z: s.z,
      yaw: 0,
    })),
  };
}

describe("trajectoryPolylines", () => {
  it("returns nothing for an empty trajectory", () => {
    expect(trajectoryPolylines(traj([]), null)).toEqual([]);
  });

  it("returns one continuous polyline when there are no gaps", () => {
    const out = trajectoryPolylines(
      traj([
        { time: 0, x: 0, z: 0 },
        { time: 1, x: 10, z: 0 },
        { time: 2, x: 20, z: 0 },
      ]),
      null,
    );
    expect(out).toEqual([[{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 }]]);
  });

  it("splits the path at un-spotted gaps (fog of war)", () => {
    const out = trajectoryPolylines(
      traj([
        { time: 0, x: 0, z: 0 },
        { time: 3, x: 10, z: 0 },
        // 5 s gap (un-spotted) — split here…
        { time: 8, x: 500, z: 500 },
        // …but a 4 s gap is continuous observation, no split.
        { time: 12, x: 510, z: 500 },
      ]),
      null,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    expect(out[1]).toEqual([{ x: 500, z: 500 }, { x: 510, z: 500 }]);
  });

  it("slices at the playhead for upTo paths", () => {
    const t = traj([
      { time: 0, x: 0, z: 0 },
      { time: 3, x: 100, z: 0 },
      { time: 6, x: 200, z: 0 },
    ]);
    expect(trajectoryPolylines(t, 3)).toEqual([[{ x: 0, z: 0 }, { x: 100, z: 0 }]]);
    expect(trajectoryPolylines(t, null)).toHaveLength(1);
    expect(trajectoryPolylines(t, null)[0]).toHaveLength(3);
  });

  it("drops consecutive duplicate positions", () => {
    const out = trajectoryPolylines(
      traj([
        { time: 0, x: 0, z: 0 },
        { time: 1, x: 0, z: 0 },
        { time: 2, x: 5, z: 0 },
      ]),
      null,
    );
    expect(out[0]).toEqual([{ x: 0, z: 0 }, { x: 5, z: 0 }]);
  });
});
