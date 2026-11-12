/** Unit tests for the squadron formation layout math (pure functions). */
import { describe, expect, it } from "vitest";
import {
  formationOffsets,
  groupInnerOffsets,
  groupSizeOfParams,
  inferGrouping,
  PLANE_TRAIL_GRACE_S,
  planeTrailExpiry,
} from "./planeFormation";
import type { SquadronPlane } from "@/api";

const sp = (time: number, x: number, z: number): SquadronPlane => ({
  time, planeId: 1, index: 0, x, y: 20, z, yaw: 0,
});

describe("groupSizeOfParams (GameParams aerialAttack slots)", () => {
  it("reports the recorded three-plane group for a real airframe", () => {
    // PAAB001_Douglas_TBD: formations.aerialAttack slots are strict
    // three-plane groups (extract_plane_groups.py, 892/894 airframes).
    expect(groupSizeOfParams(4293885936)).toBe(3);
  });

  it("returns null for an unknown airframe so callers can fall back", () => {
    expect(groupSizeOfParams(1)).toBeNull();
    expect(groupSizeOfParams(undefined)).toBeNull();
  });

  it("has no one-plane rows left (ragged tables fall back to inference)", () => {
    // PAAB952_TBM3 / PAAD910_BTD_1 carry a flight-shaped aerialAttack table
    // whose third component is a per-plane offset, not a group id; the
    // extractor must skip them instead of answering 1 (one-plane groups
    // were the reported bug). Every committed row is a real group size.
    expect(groupSizeOfParams(3296690160)).toBeNull();
    expect(groupSizeOfParams(3340664816)).toBeNull();
  });
});

describe("planeTrailExpiry", () => {
  it("adds the shared grace window when the replay recorded no remove", () => {
    expect(planeTrailExpiry(100)).toBe(100 + PLANE_TRAIL_GRACE_S);
    expect(planeTrailExpiry(43.5, undefined)).toBe(43.5 + PLANE_TRAIL_GRACE_S);
  });

  it("caps the grace window at an earlier minimap remove (landed/shot down)", () => {
    expect(planeTrailExpiry(100, 101)).toBe(101);
    expect(planeTrailExpiry(100, 100)).toBe(100);
  });

  it("keeps the grace window when the remove lands after it", () => {
    expect(planeTrailExpiry(100, 500)).toBe(100 + PLANE_TRAIL_GRACE_S);
    expect(planeTrailExpiry(0, Infinity)).toBe(PLANE_TRAIL_GRACE_S);
  });
});

describe("groupInnerOffsets", () => {
  it("renders a single plane at the group origin", () => {
    expect(groupInnerOffsets(1)).toEqual([{ ox: 0, oz: 0 }]);
  });

  it("lays three planes in a 梯形 V (lead front, wingmen behind)", () => {
    expect(groupInnerOffsets(3)).toEqual([
      { ox: 0, oz: 0 },
      { ox: -4.5, oz: -5.5 },
      { ox: 4.5, oz: -5.5 },
    ]);
  });

  it("steps wingmen back in alternating pairs for 5 planes", () => {
    const out = groupInnerOffsets(5);
    expect(out).toHaveLength(5);
    expect(out[1]).toEqual({ ox: -4.5, oz: -5.5 });
    expect(out[2]).toEqual({ ox: 4.5, oz: -5.5 });
    expect(out[3]).toEqual({ ox: -9, oz: -11 });
    expect(out[4]).toEqual({ ox: 9, oz: -11 });
  });
});

describe("formationOffsets", () => {
  it("lays a single group on the ring's front point", () => {
    const out = formationOffsets(1, 3);
    expect(out[0]).toEqual({ ox: 0, oz: 16 });
    expect(out).toHaveLength(3);
  });

  it("distributes four groups on a ring (front/right/back/left)", () => {
    const out = formationOffsets(4, 1);
    expect(out).toHaveLength(4);
    expect(out[0].ox).toBeCloseTo(0);
    expect(out[0].oz).toBeCloseTo(16);
    expect(out[1].ox).toBeCloseTo(16);
    expect(out[1].oz).toBeCloseTo(0);
    expect(out[2].ox).toBeCloseTo(0);
    expect(out[2].oz).toBeCloseTo(-16);
    expect(out[3].ox).toBeCloseTo(-16);
    expect(out[3].oz).toBeCloseTo(0);
  });

  it("scales slot count with groups x planes", () => {
    expect(formationOffsets(4, 3)).toHaveLength(12);
    expect(formationOffsets(6, 1)).toHaveLength(6);
  });

  it("keeps every group's V intact (offsets cluster per group)", () => {
    const out = formationOffsets(4, 3);
    // Group 0's three planes sit nearest the front-ring point.
    const g0 = out.slice(0, 3);
    for (const o of g0) {
      expect(Math.hypot(o.ox, o.oz - 16)).toBeLessThan(12);
    }
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

  it("chunks a wide 10-plane launch into at most four groups", () => {
    // 10 planes spread 0..360 units — the old fixed 45-unit threshold
    // fragmented this into ten groups of 1 (the ring-of-singles report).
    const entries = Array.from({ length: 10 }, (_, i) => ({
      trail: { id: 16 + i, samples: [sp(i * 40, 0, 0)] },
    }));
    const out = inferGrouping(entries, sampleFirst);
    expect(out.groupCount).toBeLessThanOrEqual(4);
    expect(out.groupSize * out.groupCount).toBeGreaterThanOrEqual(10);
  });
});
