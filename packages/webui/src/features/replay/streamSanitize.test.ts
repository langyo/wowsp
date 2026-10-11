import { describe, expect, it } from "vitest";
import type { EntityTrajectory, PositionSample, ReplayStream } from "@/api";
import { sanitizeReplayStream } from "./streamSanitize";

const pos = (time: number, x = 0, z = 0): PositionSample => ({
  time,
  entityId: 1,
  vehicleId: 1,
  x,
  y: 0,
  z,
  yaw: 0,
});

const traj = (over: Partial<EntityTrajectory> = {}): EntityTrajectory => ({
  entityId: 1,
  samples: [pos(0), pos(10)],
  ...over,
});

const streamOf = (trajectories: unknown): ReplayStream =>
  ({ trajectories }) as unknown as ReplayStream;

describe("sanitizeReplayStream", () => {
  it("keeps a clean stream untouched, array identities included", () => {
    const samples = [pos(0), pos(5), pos(10)];
    const hp = [{ time: 1, value: 100 }];
    const tr = traj({ samples, hpSamples: hp });
    const stream = streamOf([tr]);
    sanitizeReplayStream(stream);
    expect(stream.trajectories).toEqual([tr]);
    expect(stream.trajectories[0].samples).toBe(samples);
    expect(stream.trajectories[0].hpSamples).toBe(hp);
  });

  it("keeps zero-sample trajectories (the #956 un-spotted-spawn class)", () => {
    const tr = traj({ entityId: 7, samples: [] });
    const stream = streamOf([tr]);
    sanitizeReplayStream(stream);
    expect(stream.trajectories).toHaveLength(1);
    expect(stream.trajectories[0].entityId).toBe(7);
    expect(stream.trajectories[0].samples).toEqual([]);
  });

  it("empties a timeline whose every sample is degenerate, keeping the entity", () => {
    const stream = streamOf([
      traj({
        entityId: 9,
        samples: [pos(Number.NaN), pos(0, Number.POSITIVE_INFINITY)] as PositionSample[],
      }),
    ]);
    sanitizeReplayStream(stream);
    expect(stream.trajectories).toHaveLength(1);
    expect(stream.trajectories[0].entityId).toBe(9);
    expect(stream.trajectories[0].samples).toEqual([]);
  });

  it("drops nullish and non-finite samples from a timeline", () => {
    const bad = [
      pos(0),
      undefined,
      pos(5, Number.NaN, 0),
      { ...pos(6), time: Number.POSITIVE_INFINITY },
      pos(10, 0, Number.NEGATIVE_INFINITY),
      null,
      pos(15, 3, 4),
    ] as unknown as PositionSample[];
    const stream = streamOf([traj({ samples: bad })]);
    sanitizeReplayStream(stream);
    const kept = stream.trajectories[0].samples;
    // undefined/null entries and NaN/Infinity fields are all gone; the
    // finite samples keep their order.
    expect(kept.map((s) => s.time)).toEqual([0, 15]);
    expect(kept[1].x).toBe(3);
    expect(kept[1].z).toBe(4);
  });

  it("coerces a non-array samples field to the empty timeline", () => {
    const stream = streamOf([
      traj({ samples: "broken" as unknown as PositionSample[] }),
    ]);
    sanitizeReplayStream(stream);
    expect(stream.trajectories[0].samples).toEqual([]);
  });

  it("drops nullish trajectory entries and cleans the HP-style timelines", () => {
    const stream = streamOf([
      null,
      traj({
        entityId: 2,
        hpSamples: [{ time: 1, value: 50 }, null, { time: 3, value: Number.NaN }] as unknown as EntityTrajectory["hpSamples"],
        capSamples: [{ time: 2, value: 0 }],
        capProgress: [null, { time: 4, value: 700 }] as unknown as EntityTrajectory["capProgress"],
      }),
      undefined,
    ]);
    sanitizeReplayStream(stream);
    expect(stream.trajectories).toHaveLength(1);
    const tr = stream.trajectories[0];
    expect(tr.hpSamples).toEqual([{ time: 1, value: 50 }]);
    // A clean list keeps its identity (no copy on the normal path).
    expect(tr.capSamples).toEqual([{ time: 2, value: 0 }]);
    expect(tr.capProgress).toEqual([{ time: 4, value: 700 }]);
  });

  it("answers an empty trajectory list for a malformed stream field", () => {
    const stream = streamOf(undefined);
    sanitizeReplayStream(stream);
    expect(stream.trajectories).toEqual([]);
  });
});
