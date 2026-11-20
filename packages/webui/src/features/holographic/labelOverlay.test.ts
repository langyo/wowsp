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
  planeCardAllowed,
  planeRowVisible,
} from "./labelOverlay";
import type { MapInternals } from "./mapInternals";
import type { EntityTrajectory, PositionSample, SquadronPlane } from "@/api";

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

describe("planeCardAllowed (aircraft cards stay out of the aircraft chase)", () => {
  it("drops every carrier's aircraft card while the chase rides a wing", () => {
    // The cards ride the rendered wedge centroid, so they drift across the
    // screen on every bank, and their content repeats the hull plaque plus
    // the bottom-left HUD. Followed wing included — its readout moved there.
    expect(planeCardAllowed(1234)).toBe(false);
  });

  it("keeps the cards when the camera is not chasing aircraft", () => {
    expect(planeCardAllowed(null)).toBe(true);
    expect(planeCardAllowed(undefined)).toBe(true);
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
/* ── Homeward-bound (post-strike) wings lose the floating card ───────────
 * The 3D half of the requirement: "3d 视角下也只是有模型没悬浮标签". The
 * formation MODEL keeps rendering (markerUpdate's placement pass is
 * untouched); the per-carrier aircraft card must not hang over a wing that is
 * flying home. */

const CARRIER = 700;
const T_RETURN = 45; // the leg is proven at 40 (see planeFormation's tests)

/** A parked carrier (a real CV makes ~10 m/s against the wing's ~60). */
const carrierTrack = (): PositionSample[] =>
  Array.from({ length: 121 }, (_, i) => ({
    time: i,
    entityId: CARRIER,
    vehicleId: 0,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
  }));

/** Sortie trail at 1 Hz: out at 60 m/s, a −35° attack dive at t 21/22, then
 *  home — the same profile planeFormation's tests prove at t = 40. */
function sortie(planeId: number, returning: boolean): { id: number; samples: SquadronPlane[] } {
  const samples: SquadronPlane[] = [];
  for (let t = 0; t <= 48; t++) {
    const x = returning ? (t <= 20 ? 60 * t : t < 23 ? 1200 : 1200 - 60 * (t - 23)) : 60 * t;
    samples.push({
      time: t,
      planeId,
      index: 0,
      x,
      y: 20,
      z: 0,
      yaw: 0,
      pitch: returning && t > 20 && t < 23 ? -35 : 0,
    });
  }
  return { id: planeId * 16, samples };
}

/** Attach aircraft sorties (with their carrier join) to a label context. */
function withPlanes(
  ctx: MapInternals,
  sorties: Array<[number, boolean]>,
): MapInternals {
  const obj = ctx as unknown as {
    current: { value: number };
    planeTrails: { id: number; samples: SquadronPlane[] }[];
    planeCarrierOf: Map<number, number | null>;
    trajById: Map<number, EntityTrajectory>;
  };
  obj.current = { value: T_RETURN };
  obj.planeTrails = sorties.map(([planeId, returning]) => sortie(planeId, returning));
  obj.planeCarrierOf = new Map(sorties.map(([planeId]) => [planeId, CARRIER]));
  obj.trajById = new Map([
    [CARRIER, { entityId: CARRIER, samples: carrierTrack() } as EntityTrajectory],
  ]);
  return ctx;
}

describe("pickLabelWedgePlane (a returning wing never carries the card)", () => {
  it("skips a returning formation's wedge even when it is nearest the camera", () => {
    const ctx = withPlanes(makeCtx([[7, LABEL], [9, LABEL]]), [[7, false], [9, true]]);
    ctx.planeWedge.set(9, { x: 1, y: 20, z: 1 });
    ctx.planeWedge.set(7, { x: 500, y: 20, z: 300 });
    expect(pickLabelWedgePlane(ctx, LABEL, { x: 0, y: 0, z: 0 })).toBe(7);
  });

  it("returns -1 when every rendered wedge of the carrier is returning", () => {
    // -1 hands the caller the sample fallback, which applies the SAME gate —
    // so an all-returning carrier ends up with no card (the model stays).
    const ctx = withPlanes(makeCtx([[9, LABEL]]), [[9, true]]);
    ctx.planeWedge.set(9, { x: 1, y: 20, z: 1 });
    expect(pickLabelWedgePlane(ctx, LABEL, { x: 0, y: 0, z: 0 })).toBe(-1);
  });

  it("still picks a strike-bound formation", () => {
    const ctx = withPlanes(makeCtx([[7, LABEL]]), [[7, false]]);
    ctx.planeWedge.set(7, { x: 1, y: 20, z: 1 });
    expect(pickLabelWedgePlane(ctx, LABEL, { x: 0, y: 0, z: 0 })).toBe(7);
  });
});
