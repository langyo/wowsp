/** Unit tests for the squadron formation layout math (pure functions). */
import { describe, expect, it } from "vitest";
import {
  bankForTurnRate,
  formationOffsets,
  GROUP_COL_LATERAL,
  GROUP_RANK_DEPTH,
  headingDelta,
  headingRate,
  PLANE_BANK_SATURATION,
  PLANE_MAX_BANK,
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

  it("closes a four-plane V with a centred tail (diamond, not a stray wing)", () => {
    const out = groupInnerOffsets(4);
    expect(out).toEqual([
      { ox: 0, oz: 0 },
      { ox: -4.5, oz: -5.5 },
      { ox: 4.5, oz: -5.5 },
      { ox: 0, oz: -11 },
    ]);
  });

  it("keeps two-plane groups side by side (no tail column)", () => {
    expect(groupInnerOffsets(2)).toEqual([
      { ox: 0, oz: 0 },
      { ox: -4.5, oz: -5.5 },
    ]);
  });

  it("closes a six-plane V with a centred third-rank tail", () => {
    const out = groupInnerOffsets(6);
    expect(out).toEqual([
      { ox: 0, oz: 0 },
      { ox: -4.5, oz: -5.5 },
      { ox: 4.5, oz: -5.5 },
      { ox: -9, oz: -11 },
      { ox: 9, oz: -11 },
      { ox: 0, oz: -16.5 },
    ]);
  });
});

describe("formationOffsets (triangular array)", () => {
  it("puts the lead group on the centreline at the origin", () => {
    const out = formationOffsets(1, 3);
    expect(out).toHaveLength(3);
    // The V's leader is the first slot of the first group.
    expect(out[0]).toEqual({ ox: 0, oz: 0 });
  });

  it("spreads four groups as a triangle: one lead, two wing, one trail", () => {
    // Rank 0 = lead, rank 1 = left + right, rank 2 = centre trail. NOT a
    // ring: the groups must stay on one axis-aligned pyramid so the wing
    // reads as a formation from every chase angle (2026-11-12 review).
    const out = formationOffsets(4, 1);
    expect(out).toHaveLength(4);
    const [a, b, c, d] = out;
    expect(a).toEqual({ ox: 0, oz: 0 });
    expect(b.ox).toBeCloseTo(-GROUP_COL_LATERAL / 2);
    expect(b.oz).toBeCloseTo(-GROUP_RANK_DEPTH);
    expect(c.ox).toBeCloseTo(GROUP_COL_LATERAL / 2);
    expect(c.oz).toBeCloseTo(-GROUP_RANK_DEPTH);
    expect(d.ox).toBeCloseTo(0);
    expect(d.oz).toBeCloseTo(-GROUP_RANK_DEPTH * 2);
  });

  it("keeps rank r at r + 1 groups, centred, widening backwards", () => {
    const out = formationOffsets(6, 1);
    expect(out).toHaveLength(6);
    // rank 0: 1 group, rank 1: 2, rank 2: 3
    const depths = out.map((o) => o.oz);
    expect(depths.filter((d) => d === 0)).toHaveLength(1);
    expect(depths.filter((d) => d === -GROUP_RANK_DEPTH)).toHaveLength(2);
    expect(depths.filter((d) => d === -GROUP_RANK_DEPTH * 2)).toHaveLength(3);
    // Symmetric about the axis: the lateral offsets of each rank sum to 0.
    expect(out[1].ox + out[2].ox).toBeCloseTo(0);
    expect(out[3].ox + out[4].ox + out[5].ox).toBeCloseTo(0);
  });

  it("scales slot count with groups x planes", () => {
    expect(formationOffsets(4, 3)).toHaveLength(12);
    expect(formationOffsets(6, 1)).toHaveLength(6);
  });

  it("keeps every group's V intact (offsets cluster per group)", () => {
    const out = formationOffsets(4, 3);
    const g0 = out.slice(0, 3);
    for (const o of g0) {
      // Group 0 is the V at the origin: every slot sits within one V reach
      // of it (w × 1 and d × 1), far tighter than the group spacing.
      expect(Math.hypot(o.ox, o.oz)).toBeLessThan(Math.hypot(4.5, 5.5) + 0.01);
    }
  });

  it("leaves a readable channel between groups at every rank", () => {
    const out = formationOffsets(6, 3);
    // Distinct group origins (rank 1 pair) stay a full lateral step apart,
    // far wider than one group's own lateral spread (2 × w = 9).
    expect(GROUP_COL_LATERAL).toBeGreaterThan(9);
    expect(GROUP_RANK_DEPTH).toBeGreaterThan(11);
    expect(out).toHaveLength(18);
  });
});

describe("banking (roll into the turn)", () => {
  it("normalises the heading delta across the ±π wrap", () => {
    // 350° → 10° is a +20° turn, not −340°.
    const from = (350 * Math.PI) / 180;
    const to = (10 * Math.PI) / 180;
    expect((headingDelta(from, to) * 180) / Math.PI).toBeCloseTo(20);
    expect((headingDelta(to, from) * 180) / Math.PI).toBeCloseTo(-20);
  });

  it("banks proportionally and saturates at the clamp", () => {
    expect(bankForTurnRate(0)).toBeCloseTo(0);
    const half = bankForTurnRate(PLANE_BANK_SATURATION / 2);
    expect(half).toBeCloseTo(PLANE_MAX_BANK / 2);
    // Anything at or beyond the saturation rate keeps the clamp (never flips).
    expect(bankForTurnRate(PLANE_BANK_SATURATION)).toBeCloseTo(PLANE_MAX_BANK);
    expect(bankForTurnRate(PLANE_BANK_SATURATION * 10)).toBeCloseTo(PLANE_MAX_BANK);
    expect(bankForTurnRate(-PLANE_BANK_SATURATION * 10)).toBeCloseTo(-PLANE_MAX_BANK);
  });

  it("derives the turn rate from a sample pair, rejecting unusable dt", () => {
    // 90° over one second = π/2 rad/s.
    expect(headingRate(0, 10, Math.PI / 2, 11)).toBeCloseTo(Math.PI / 2);
    // Missing/zero/negative dt carries no rate.
    expect(headingRate(0, 10, 1, 10)).toBeNull();
    expect(headingRate(null, 10, 1, 11)).toBeNull();
    expect(headingRate(0, 10, undefined, 11)).toBeNull();
  });

  it("banks left on a left turn and right on a right turn", () => {
    expect(bankForTurnRate(0.5)).toBeGreaterThan(0);
    expect(bankForTurnRate(-0.5)).toBeLessThan(0);
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
