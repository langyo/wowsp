/**
 * The aircraft card's anchor pick: a carrier with several sorties airborne
 * used to pick the "newest sample", which alternated between formations tick
 * to tick and made the card flicker. The pick is now by rendered wedge
 * (nearest the camera, deterministic tie-break).
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  behindCameraEdgeNdc,
  currentWingOfCarrier,
  pickLabelWedgePlane,
  planeCardAllowed,
  planeRowVisible,
  updateLabelPositions,
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
/* ── The card describes the carrier's CURRENT wing, not the nearest one ──
 * User report (14.5.0.0 Shokaku 37_Ridge, 03:10): following the recorder's
 * own CV, the aircraft card read "100% · ✈4" — the four planes of a WARD
 * fighter patrol loitering over the deck, picked because its rendered wedge
 * happened to be the closest to the camera — while the formation the chase
 * camera and the gold controlled-aircraft edge were following was the
 * 10-plane torpedo wing the carrier had just launched. One carrier, one
 * current wing: the card must read that one. */

/** Anchor trails for one carrier: `[planeId, born, lastSample]`. */
function carrierWings(
  ctx: MapInternals,
  wings: Array<[number, number, number]>,
): MapInternals {
  const obj = ctx as unknown as {
    planeLabelCarriers: Map<number, number>;
    planeTrails: { id: number; samples: SquadronPlane[] }[];
    planeCarrierOf: Map<number, number | null>;
    minimapTrailEnd: Map<number, number>;
    trajById: Map<number, EntityTrajectory>;
    planeWedge: Map<number, { x: number; y: number; z: number }>;
  };
  obj.planeLabelCarriers = new Map([[LABEL, CARRIER]]);
  obj.planeTrails = wings.map(([planeId, born, last]) => {
    const samples: SquadronPlane[] = [];
    for (let t = born; t <= last; t++) {
      samples.push({ time: t, planeId, index: 0, x: 60 * (t - born), y: 100, z: 0, yaw: 0 });
    }
    return { id: planeId * 16, samples };
  });
  obj.planeCarrierOf = new Map(wings.map(([planeId]) => [planeId, CARRIER]));
  obj.minimapTrailEnd = new Map();
  obj.trajById = new Map([
    [CARRIER, { entityId: CARRIER, samples: carrierTrack() } as EntityTrajectory],
  ]);
  obj.planeWedge = new Map();
  return ctx;
}

describe("currentWingOfCarrier (the card rides the followed wing)", () => {
  it("takes the carrier's newest launch, not the wedge nearest the camera", () => {
    // Both wings are up at t = 45; wing 9 is the fresher launch.
    const ctx = carrierWings(makeCtx([]), [[7, 0, 60], [9, 20, 60]]);
    // The OLDER wing's wedge sits right at the camera; the current wing's is
    // far away. Nearest-to-camera must not win.
    ctx.planeWedge.set(7, { x: 0, y: 20, z: 0 });
    ctx.planeWedge.set(9, { x: 900, y: 20, z: 900 });
    expect(currentWingOfCarrier(ctx, LABEL, 45)).toBe(9);
  });

  it("returns null for a carrier join it does not own", () => {
    const ctx = carrierWings(makeCtx([]), [[7, 0, 60]]);
    expect(currentWingOfCarrier(ctx, LABEL + 1, 30)).toBeNull();
  });

  it("returns null when nothing of the carrier is airborne at t", () => {
    const ctx = carrierWings(makeCtx([]), [[7, 10, 20]]);
    expect(currentWingOfCarrier(ctx, LABEL, 5)).toBeNull(); // before the launch
    expect(currentWingOfCarrier(ctx, LABEL, 40)).toBeNull(); // past expiry (20 + 5 s)
    expect(currentWingOfCarrier(ctx, LABEL, 15)).toBe(7); // the control
  });

  it("yields to the fallback scan when the current wing is homeward-bound", () => {
    const ctx = carrierWings(makeCtx([]), [[7, 0, 60]]);
    // Born 900 m out of a parked carrier and closing: a proven return leg, so
    // the card must not describe it (planeWarfare's visibility gate owns that
    // decision; this pick simply stops claiming the wing).
    ctx.planeTrails = [{ id: 7 * 16, samples: Array.from({ length: 31 }, (_, t) => ({
      time: 30 + t, planeId: 7, index: 0, x: 900 - 60 * t, y: 100, z: 0, yaw: 0,
    })) }];
    expect(currentWingOfCarrier(ctx, LABEL, 45)).toBeNull();
  });
});

/* ── Item C: the deployment countdown card sits on the patrol CIRCLE ─────
 * Before the fighters arrive there is no formation to follow; the card must
 * still exist, at the ward's own centre, with no HP bar (the content pass
 * blanks hp/planeAlive and prints the countdown). */
describe("updateLabelPositions — fighter deployment anchor", () => {
  function harness() {
    const cam = new THREE.PerspectiveCamera(60, 1, 1, 10000);
    cam.position.set(0, 0, 800);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const canvas = { clientWidth: 800, clientHeight: 600 };
    const slots = new Map<string, HTMLDivElement | null>();
    const slot = { style: { display: "none", transform: "" } } as unknown as HTMLDivElement;
    slots.set("l" + LABEL, slot);
    const label = {
      entityId: LABEL,
      x: 0,
      y: 0,
      visible: false,
      belowVisible: false,
      belowX: 0,
      belowY: 0,
      kind: "plane",
      planeType: "fighter",
    };
    const ctx = {
      api: { value: { camera: cam, renderer: { domElement: canvas } } },
      container: { value: { clientWidth: 800, clientHeight: 600 } },
      shipLabels: { value: [label] },
      shipMarkers: [],
      current: { value: 90 },
      labelSlotEls: slots,
      _projVec: new THREE.Vector3(),
      planeLabelOfPlane: new Map(),
      planeLabelCarriers: new Map([[LABEL, 845628]]),
      planeTrails: [],
      planeWedge: new Map(),
      planeLabelPicks: new Map<number, number>(),
      planeRecordedView: false,
      planeCarrierOf: new Map(),
      minimapTrailEnd: new Map(),
      planeWardAnchors: new Map([
        [
          LABEL,
          [
            {
              x: 0,
              y: 100,
              z: 0,
              t0: 82.4,
              arriveAt: 97.9,
              t1: 136.9,
              planeId: 1203,
              planeType: "fighter",
            },
          ],
        ],
      ]),
      followAircraftId: null,
    } as unknown as MapInternals;
    return { ctx, label, slot };
  }

  it("projects the deploying card at the ward centre and shows it", () => {
    const { ctx, label, slot } = harness();
    updateLabelPositions(ctx);
    expect(label.visible).toBe(true);
    // Horizontally centred (the ward sits straight ahead of the camera) and
    // lifted above the horizon by the patrol-altitude offset.
    expect(label.x).toBeCloseTo(400, 0);
    expect(label.y).toBeLessThan(300);
    expect(Number.isFinite(label.y)).toBe(true);
    expect(slot.style.display).toBe("block");
    expect(slot.style.transform).toContain("translate3d");
  });

  it("falls back to the wing path once the anchor belongs to another sortie", () => {
    const { ctx, label } = harness();
    // On station, but the carrier's card now describes a different wing: the
    // ward anchor must NOT hold the card hostage.
    (ctx as unknown as { current: { value: number } }).current.value = 110;
    ctx.planeLabelPicks.set(LABEL, 999);
    updateLabelPositions(ctx);
    expect(label.visible).toBe(false);
  });
});


/* ── Item B: no card flash across a mid-air re-created wing ──────────────
 * The 14.5.0.0 Shokaku capture re-adds squadrons mid-air (a survivor group
 * with a fresh planeId living 1.9–3.4 s). The old "newest launch" pick rode
 * that group for its whole life, so the card flashed ITS family for a couple
 * of seconds and vanished with it — "出现一下就又消失了". The card now holds
 * the older still-airborne wing until the newer one has flown for 3 s.
 */
describe("currentWingOfCarrier (no flash window across a mid-air group)", () => {
  it("holds the older wing for the whole life of a short re-created group", () => {
    // Wing 9 launches at 20 s, its stream stops at 22 s (expiry 27 s).
    const ctx = carrierWings(makeCtx([]), [[7, 0, 60], [9, 20, 22]]);
    for (let t = 20; t <= 27; t++) {
      expect(currentWingOfCarrier(ctx, LABEL, t)).toBe(7);
    }
  });

  it("takes the newer wing once it has been airborne for 3 s", () => {
    const ctx = carrierWings(makeCtx([]), [[7, 0, 60], [9, 20, 60]]);
    expect(currentWingOfCarrier(ctx, LABEL, 22)).toBe(7);
    expect(currentWingOfCarrier(ctx, LABEL, 23)).toBe(9);
  });

  it("is scrub-stable: the same playhead answers the same wing", () => {
    const ctx = carrierWings(makeCtx([]), [[7, 0, 60], [9, 20, 60]]);
    const fwd = [18, 21, 22, 23, 30].map((t) => currentWingOfCarrier(ctx, LABEL, t));
    const back = [30, 23, 22, 21, 18].map((t) => currentWingOfCarrier(ctx, LABEL, t)).reverse();
    expect(fwd).toEqual(back);
    expect(fwd).toEqual([7, 7, 7, 9, 9]);
  });
});
