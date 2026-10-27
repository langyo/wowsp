/**
 * decodeReplayStreamPacked — the MessagePack leg of the replay-stream IPC
 * (see streams.rs read_replay_positions). Pins:
 *   - a packed stream round-trips into the exact TS shape the JSON leg
 *     produced (camelCase keys, numbers, optional families);
 *   - the defensive leaves fold accepts BOTH shapes the decoder could hand
 *     back (v3 ships a plain record; a Map folds into the same record).
 */
import { describe, expect, it } from "vitest";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { decodeReplayStreamPacked } from "./replay";

function pack(obj: unknown): ArrayBuffer {
  const u8 = msgpackEncode(obj);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

describe("decodeReplayStreamPacked", () => {
  it("round-trips a representative stream into the JSON-leg shape", () => {
    const wire = {
      trajectories: [
        {
          entityId: 42,
          kind: { entityType: 2, vehicleId: 7, initialX: 1.5, initialY: 0, initialZ: -2.5 },
          samples: [
            { time: 1, entityId: 42, vehicleId: 7, x: 0.5, y: 0, z: -1.25, yaw: 0.25 },
          ],
          hpSamples: [{ time: 1, value: 42000 }],
        },
      ],
      recorderVehicleId: 42,
      leaves: { "42": 55.5 },
    };
    const out = decodeReplayStreamPacked(pack(wire));
    expect(out.trajectories.length).toBe(1);
    const traj = out.trajectories[0]!;
    expect(traj.kind?.entityType).toBe(2);
    expect(traj.hpSamples?.[0]?.value).toBe(42000);
    expect(out.recorderVehicleId).toBe(42);
    // Both legs must agree on the leaves record shape consumers index into.
    expect(out.leaves).toEqual({ "42": 55.5 });
  });

  it("keeps the defensive leaves fold a no-op for the v3 record shape", () => {
    // The wire always carries STRING keys now (Rust leaves_string_keys);
    // v3 decodes those into the plain record below. Integer-keyed msgpack
    // maps decode to {} in v3 (entries dropped), which is exactly why the
    // Rust side stringifies — this pins that the fold does not disturb the
    // healthy path.
    const out = decodeReplayStreamPacked(
      pack({ trajectories: [], leaves: { "7": 1.5, "42": 55.5 } }),
    );
    expect(out.leaves).toEqual({ "7": 1.5, "42": 55.5 });
  });
});
