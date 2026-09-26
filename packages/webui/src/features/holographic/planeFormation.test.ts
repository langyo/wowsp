/** Unit tests for the squadron formation layout math (pure functions). */
import { describe, expect, it } from "vitest";
import { formationOffsets, groupInnerOffsets, inferGrouping } from "./planeFormation";
import type { SquadronPlane } from "@/api";

const sp = (time: number, x: number, z: number): SquadronPlane => ({
  time, planeId: 1, index: 0, x, y: 20, z, yaw: 0,
});

describe("groupInnerOffsets", () => {
  it("renders a single plane at the group origin", () => {
    expect(groupInnerOffsets(1)).toEqual([{ ox: 0, oz: 0 }]);
  });

  it("places two planes side by side", () => {
    expect(groupInnerOffsets(2)).toEqual([{ ox: -9, oz: 0 }, { ox: 9, oz: 0 }]);
  });

  it("places three planes in an arrow (lead front)", () => {
    expect(groupInnerOffsets(3)).toEqual([
      { ox: 0, oz: -9 }, { ox: -9, oz: 9 }, { ox: 9, oz: 9 },
    ]);
  });

  it("gives 4+ planes two up front and the rest trailing, alternating sides", () => {
    const out = groupInnerOffsets(5);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ ox: -9, oz: -9 });
    expect(out[1]).toEqual({ ox: 9, oz: -9 });
    expect(out[2]).toEqual({ ox: -9, oz: 9 });
    expect(out[3]).toEqual({ ox: 9, oz: 9 });
    expect(out[4]).toEqual({ ox: -9, oz: 9 });
  });
});

describe("formationOffsets", () => {
  it("lays a single group out at the origin using the inner wedge", () => {
    const out = formationOffsets(1, 3);
    expect(out).toEqual(groupInnerOffsets(3));
  });

  it("fills rows 1-2-1 for four single-plane groups", () => {
    const out = formationOffsets(4, 1);
    expect(out).toEqual([
      { ox: 0, oz: 0 },
      { ox: -10, oz: -15 },
      { ox: 10, oz: -15 },
      { ox: 0, oz: -30 },
    ]);
  });

  it("fills rows 1-2-3 for six single-plane groups", () => {
    expect(formationOffsets(6, 1)).toHaveLength(6);
    expect(formationOffsets(6, 1)[5]).toEqual({ ox: 20, oz: -30 });
  });

  it("centers a leftover group in its own row (7 groups → 1-2-3-1)", () => {
    const out = formationOffsets(7, 1);
    expect(out).toHaveLength(7);
    expect(out[6]).toEqual({ ox: 0, oz: -45 });
  });

  it("scales with the group size (offset count = groups x planes)", () => {
    expect(formationOffsets(3, 2)).toHaveLength(6);
  });
});

describe("inferGrouping", () => {
  const sampleFirst = (tr: { samples: SquadronPlane[] }, _t: number) =>
    tr.samples.length > 0 ? { x: tr.samples[0].x, z: tr.samples[0].z } : null;

  it("degenerates to one group for a lone plane", () => {
    const entries = [{ trail: { id: 16, samples: [sp(0, 0, 0)] } }];
    expect(inferGrouping(entries, sampleFirst)).toEqual({ groupSize: 1, groupCount: 1 });
  });

  it("keeps well-separated planes in separate groups", () => {
    const entries = [
      { trail: { id: 16, samples: [sp(0, 0, 0)] } },
      { trail: { id: 16, samples: [sp(0, 500, 0)] } },
    ];
    expect(inferGrouping(entries, sampleFirst)).toEqual({ groupSize: 1, groupCount: 2 });
  });

  it("clusters planes launched together into one group", () => {
    const entries = [
      { trail: { id: 16, samples: [sp(0, 0, 0)] } },
      { trail: { id: 17, samples: [sp(0, 10, 0)] } },
    ];
    expect(inferGrouping(entries, sampleFirst)).toEqual({ groupSize: 2, groupCount: 1 });
  });
});
