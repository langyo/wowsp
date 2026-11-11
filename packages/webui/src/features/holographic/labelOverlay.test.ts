/**
 * The aircraft card's anchor pick: a carrier with several sorties airborne
 * used to pick the "newest sample", which alternated between formations tick
 * to tick and made the card flicker. The pick is now by rendered wedge
 * (nearest the camera, deterministic tie-break).
 */
import { describe, expect, it } from "vitest";
import {
  behindCameraEdgeNdc,
  pickLabelWedgePlane,
  planeRowVisible,
} from "./labelOverlay";
import type { MapInternals } from "./mapInternals";

const LABEL = 100;

function makeCtx(entries: Array<[number, number | undefined]>): MapInternals {
  const ctx = {
    planeLabelOfPlane: new Map(entries),
    planeWedge: new Map<number, { x: number; y: number; z: number }>(),
  } as unknown as MapInternals;
  return ctx;
}

describe("behindCameraEdgeNdc", () => {
  it("pins a behind-camera point to the ±0.8 edge ring", () => {
    const p = behindCameraEdgeNdc(2, 1);
    expect(p.x).toBeCloseTo(0.8);
    expect(p.y).toBeCloseTo(0.4);
  });

  it("keeps a centered direction centered", () => {
    expect(behindCameraEdgeNdc(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("collapses non-finite camera-plane projections to the centre", () => {
    expect(behindCameraEdgeNdc(Infinity, 1)).toEqual({ x: 0, y: 0 });
    expect(behindCameraEdgeNdc(NaN, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe("planeRowVisible", () => {
  it("shows for boost, slow and consumables alike", () => {
    expect(planeRowVisible({ planeBoost: true })).toBe(true);
    // The slow-only state must show the row (the PR that added planeSlow
    // originally forgot the gate here — throttleAt yields ONE mode, so
    // slow-only is the normal case while decelerating).
    expect(planeRowVisible({ planeSlow: true })).toBe(true);
    expect(planeRowVisible({ planeConsumables: ["healForsage"] })).toBe(true);
  });

  it("hides when nothing runs", () => {
    expect(planeRowVisible({})).toBe(false);
    expect(planeRowVisible({ planeConsumables: [] })).toBe(false);
  });
});

describe("pickLabelWedgePlane", () => {
  it("picks the rendered formation nearest the camera", () => {
    const ctx = makeCtx([
      [7, LABEL],
      [9, LABEL],
      [11, 999], // another carrier's sortie — never ours
    ]);
    // Camera in SCENE space; wedges are world (z mirrored).
    const cam = { x: 0, y: 0, z: 0 };
    ctx.planeWedge.set(7, { x: 500, y: 20, z: 300 });
    ctx.planeWedge.set(9, { x: 10, y: 20, z: -5 }); // world z -5 → scene +5
    ctx.planeWedge.set(11, { x: 1, y: 20, z: 1 });
    expect(pickLabelWedgePlane(ctx, LABEL, cam)).toBe(9);
  });

  it("is deterministic for equidistant formations (smallest planeId)", () => {
    const ctx = makeCtx([
      [9, LABEL],
      [7, LABEL],
    ]);
    const cam = { x: 0, y: 0, z: 0 };
    ctx.planeWedge.set(7, { x: 10, y: 0, z: 0 });
    ctx.planeWedge.set(9, { x: -10, y: 0, z: 0 });
    expect(pickLabelWedgePlane(ctx, LABEL, cam)).toBe(7);
  });

  it("returns -1 when nothing is rendered (sample fallback applies)", () => {
    const ctx = makeCtx([[7, LABEL]]);
    expect(pickLabelWedgePlane(ctx, LABEL, { x: 0, y: 0, z: 0 })).toBe(-1);
  });
});