/**
 * Rendered-model count vs the squadron LIVE flying strength.
 *
 * User report (item 2 of the plane fix wave): a squadron must show exactly
 * the planes still airborne - shot-down planes disappear from the 3D wedge as
 * they die. E27 planesHealth packs one 3-bit digit per plane (LSB first), so
 * its digit count IS the flying count; markerUpdate renders the first N slots.
 *
 * Regression this guards: the pass renders N slots but never hides the SURPLUS
 * pool slots of a STILL-ANCHORED formation. The hide pass only runs for
 * formations that LEFT the anchor table, so slots N..count-1 keep the pose the
 * previous (full-strength) tick gave them - visible: true. A squadron that lost
 * planes therefore keeps its whole wedge on screen.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { MapInternals } from "./mapInternals";
import { updateMarkersAt } from "./markerUpdate";
import { PLANE_CARD_LABEL_ID_BASE } from "./planeWarfare";
import type { EntityTrajectory, PositionSample, SquadronPlane } from "@/api";

const PLANE_ID = 7;

/** One sample set for a formation of count planes at t = 10..20 s. */
function trails(count: number): { id: number; samples: SquadronPlane[] }[] {
  const out: { id: number; samples: SquadronPlane[] }[] = [];
  for (let index = 0; index < count; index++) {
    out.push({
      id: PLANE_ID * 16 + index,
      samples: [10, 20].map((time) => ({
        time,
        planeId: PLANE_ID,
        index,
        x: index * 5,
        y: 100,
        z: 0,
        yaw: 0,
      })),
    });
  }
  return out;
}

/** planesHealth packing for k flying planes, every band at full (digit 1). */
function packed(k: number): number {
  let acc = 0;
  for (let i = 0; i < k; i++) acc += 8 ** i;
  return acc;
}

const poolOf = (n: number) =>
  Array.from({ length: n }, () => {
    const g = new THREE.Group();
    g.visible = false;
    return g;
  });

function makeCtx(pool: THREE.Object3D[]): MapInternals {
  return {
    props: {
      squadronCreates: [],
      squadronPlanes: [],
      minimapSquadronAdds: [],
      minimapSquadronMoves: [],
      minimapSquadronRemoves: [],
      cameraFrames: [],
      operation: false,
      chatMessages: [],
      achievements: [],
      weaponLocks: [],
      battleResults: "",
      encyclopedia: new Map(),
      vehicles: [],
    },
    api: { value: null },
    container: { value: null },
    current: { value: 15 },
    followStats: { value: new Map() },
    selectedEntityId: { value: null },
    minimapCanvas: { value: null },
    zoomCanvas: { value: null },
    mmView: { value: { x: 0, z: 0, zoom: 1 } },
    minimapZoom: { value: false },
    minimapShowTrails: { value: true },
    minimapShowGrid: { value: true },
    mmRotationDeg: { value: 0 },
    aiAnalysisOn: { value: false },
    decisionReport: { value: null },
    debugReport: { value: null },
    showCapEta: { value: false },
    capStatus: { value: [] },
    allyAlive: { value: 0 },
    enemyAlive: { value: 0 },
    allyTotal: { value: 0 },
    enemyTotal: { value: 0 },
    capDisplay: { value: [] },
    allyScore: { value: 0 },
    enemyScore: { value: 0 },
    feed: { value: [] },
    capZones: { value: [] },
    scoringZones: { value: [] },
    selfTeam: { value: null },
    shipLabels: { value: [] },
    trajectoryLines: [],
    shipMarkers: [],
    loadedModelPool: [],
    modelWaiters: [],
    smokeClusters: [],
    smokeDiscs: null,
    shellStates: [],
    shellTraceSlots: [],
    wardRings: [],
    torpedoMeshes: [],
    shipStatus: new Map(),
    _shellUp: new THREE.Vector3(0, 1, 0),
    _shellDir: new THREE.Vector3(),
    lockLine: null,
    planeCloud: null,
    colorsCloud: new Float32Array(0),
    planeCloudActive: new Uint8Array(0),
    planeAnchorAnim: new Map(),
    planeAnchorScratch: new Map(),
    planeTrails: trails(6),
    planeSmoothState: new Map(),
    planeMeshes: new Map([[PLANE_ID, pool]]),
    squadronStates: null,
    planeFormations: new Map([
      [PLANE_ID, { count: 6, groupSize: 1, groupCount: 6, meshes: [] }],
    ]),
    planeLaunchPoses: new Map(),
    planeWedge: new Map(),
    planeBank: new Map(),
    planeLabelPicks: new Map(),
    planeLensActive: false,
    planeLensHeading: null,
    planeLensY: null,
    planeRecordedView: false,
    capRings: [],
    capLetterSprites: [],
    rangeRingSlots: [],
    selfRings: [],
    overlayLineMats: [],
    mapModel: null,
    waterFloor: null,
    seaSurface: null,
    stormZone: null,
    moveAdviceArrows: [],
    bounds: null,
    trajById: new Map(),
    rosterAssignments: new Map(),
    shipEntityIds: [],
    arenaIdentities: null,
    arenaSelfTeam: 0,
    planeCloudSlots: new Map(),
    minimapTrailEnd: new Map(),
    planeTypesById: new Map(),
  planeRoleByTrail: new Map(),
    planeIndexById: new Map(),
    planeLabelCarriers: new Map(),
    planeRoleById: new Map(),
    planeLabelOfPlane: new Map(),
    planeCarrierOf: new Map(),
    minimapImage: null,
    minimapBounds: null,
    minimapEpoch: 0,
    _mmCtx: null,
    markerEpoch: 1,
    pbCache: null,
    feedSeq: 0,
    chatPtr: 0,
    achPtr: 0,
    reportedSinks: new Set(),
    capSim: new Map(),
    _projVec: new THREE.Vector3(),
    _wakeTail: new THREE.Vector3(),
    labelSlotEls: new Map(),
    labelContentAt: 0,
    _capDisplaySig: "",
    osd: null,
  } as unknown as MapInternals;
}

describe("rendered plane count follows the live flying strength", () => {
  it("renders the launch count when nothing has been lost yet", () => {
    const pool = poolOf(6);
    const ctx = makeCtx(pool);
    ctx.squadronStates = {
      planesHealth: [{ time: 12, planeId: PLANE_ID, packed: packed(6) }],
    } as MapInternals["squadronStates"];
    updateMarkersAt(ctx, 15);
    expect(pool.filter((m) => m.visible)).toHaveLength(6);
  });

  it("hides the surplus slots once planes are shot down", () => {
    const pool = poolOf(6);
    const ctx = makeCtx(pool);
    ctx.squadronStates = {
      planesHealth: [{ time: 12, planeId: PLANE_ID, packed: packed(6) }],
    } as MapInternals["squadronStates"];
    // Full strength first: every slot is on screen already (the real
    // sequence — a squadron launches whole, then loses planes one by one).
    updateMarkersAt(ctx, 15);
    expect(pool.filter((m) => m.visible)).toHaveLength(6);
    // Three planes die: the wedge must drop to three models on the next tick.
    ctx.squadronStates = {
      planesHealth: [{ time: 12, planeId: PLANE_ID, packed: packed(3) }],
    } as MapInternals["squadronStates"];
    updateMarkersAt(ctx, 16);
    expect(pool.filter((m) => m.visible)).toHaveLength(3);
  });
});
/* ── Returning (homeward-bound) wings: MODEL stays, floating card hides ──
 * User requirement: "3d 视角下也只是有模型没悬浮标签". markerUpdate is where
 * both halves live — the formation placement pass (planeWedge + the pool's
 * visible flags) and the per-carrier aircraft card's visibility — so this
 * pins the pair end to end: the tick that hides the card must still render
 * the wedge. */

const CARRIER = 700;
const CARD_LABEL = PLANE_CARD_LABEL_ID_BASE + CARRIER;
const T_LATE = 45; // the return leg is proven at 40 (planeFormation's tests)

/** Out at 60 m/s, a −35° attack dive at t 21/22, then home. */
function sortie(returning: boolean): SquadronPlane[] {
  const samples: SquadronPlane[] = [];
  for (let t = 0; t <= 48; t++) {
    const x = returning ? (t <= 20 ? 60 * t : t < 23 ? 1200 : 1200 - 60 * (t - 23)) : 60 * t;
    samples.push({
      time: t,
      planeId: PLANE_ID,
      index: 0,
      x,
      y: 100,
      z: 0,
      yaw: 0,
      pitch: returning && t > 20 && t < 23 ? -35 : 0,
    });
  }
  return samples;
}

/** A parked carrier track (a real CV makes ~10 m/s against the wing's ~60). */
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

/** Give the context a wing plus the carrier card that floats over it, and
 *  return that very card object so the assertions see what the pass wrote. */
function withCarrierCard(
  ctx: MapInternals,
  returning: boolean,
): { visible: boolean } {
  const label = {
    entityId: CARD_LABEL,
    kind: "plane",
    planeType: "attack",
    name: "Carrier",
    shipName: "Shokaku",
    tier: 8,
    visible: true,
    dead: false,
    belowVisible: false,
    x: 0,
    y: 0,
    belowX: 0,
    belowY: 0,
  };
  ctx.planeTrails = [{ id: PLANE_ID * 16, samples: sortie(returning) }];
  ctx.planeFormations = new Map([
    [PLANE_ID, { count: 6, groupSize: 1, groupCount: 6, meshes: [] }],
  ]);
  ctx.shipLabels = { value: [label] } as unknown as MapInternals["shipLabels"];
  ctx.planeLabelCarriers = new Map([[CARD_LABEL, CARRIER]]);
  ctx.planeLabelOfPlane = new Map([[PLANE_ID, CARD_LABEL]]);
  ctx.planeCarrierOf = new Map([[PLANE_ID, CARRIER]]);
  ctx.trajById = new Map([
    [CARRIER, { entityId: CARRIER, samples: carrierTrack() } as EntityTrajectory],
  ]);
  return label;
}

describe("returning wings keep the model and lose the floating card", () => {
  it("hides the card while the wedge stays rendered", () => {
    const pool = poolOf(6);
    const ctx = makeCtx(pool);
    const card = withCarrierCard(ctx, true);
    updateMarkersAt(ctx, T_LATE);
    expect(pool.filter((m) => m.visible)).toHaveLength(6); // models stay
    expect(ctx.planeWedge.has(PLANE_ID)).toBe(true); // wedge still placed
    expect(card.visible).toBe(false); // card hidden
  });

  it("keeps the card for a strike-bound wing", () => {
    const pool = poolOf(6);
    const ctx = makeCtx(pool);
    const card = withCarrierCard(ctx, false);
    updateMarkersAt(ctx, T_LATE);
    expect(pool.filter((m) => m.visible)).toHaveLength(6);
    expect(card.visible).toBe(true);
  });

  it("keeps the card while the return leg is not yet proven", () => {
    const pool = poolOf(6);
    const ctx = makeCtx(pool);
    const card = withCarrierCard(ctx, true);
    updateMarkersAt(ctx, 30);
    expect(card.visible).toBe(true);
  });
});
