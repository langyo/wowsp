/**
 * RECORDED-VIEW aircraft placement (the camera menu's "original" mode).
 *
 * User report: watching a replay with the recorder's own camera ("original"
 * mode / the HUD's 跟随飞机 pill) showed NO aircraft in the 3D scene. Two
 * layers caused it:
 *   1. the aircraft GLB pools were placed on a SYNTHETIC patrol orbit (radius
 *      50, altitude floor 60) around the recorded anchor, so the recorded
 *      camera — which framed the real formation — stared at empty sky;
 *   2. for the reported 14.5.0.0 Shokaku replay the 3D
 *      `receive_updateSquadron` stream stops at launch (two samples) while
 *      the real sortie track only lives in the minimap stream, so
 *      planeTrailExpiry killed the formation ~5 s after launch and nothing
 *      rendered in ANY camera mode (buildPlaneTrails now pads the index-0
 *      trail with the minimap track — covered by planeWarfare.test.ts).
 *
 * The fix, in three steps (each regression-tested below):
 *   1. while `ctx.planeRecordedView` is on, the WEDGE hangs AHEAD of the
 *      recorded lens on its interpolated view axis — the recorder flew a
 *      PLANE camera, so its stream's centre track sits ~at the camera;
 *      placing the wedge there engulfed the lens and the models rendered as
 *      near-plane shards (the user's "broken triangles") and twitched with
 *      the minimap-rate anchor. The same offsets/cxm/czm layout math runs
 *      as the orbit, with the view axis as heading and the nearest slot
 *      RECORDED_PLANE_PAD units out;
 *   2. the applied camera itself interpolates the ~10 Hz 0x25 stream
 *      (recordedCameraAt) instead of snapping to the last sample;
 *   3. aircraft pools are tinted when their GLB resolves, from the FINAL
 *      role map (self white / ally green / enemy red) — the recorder's own
 *      planes used to render red because the async load outlived the
 *      re-tint pass (covered by planeWarfare.test.ts).
 * Free/follow camera modes keep the synthetic orbit (its regression test
 * lives at the bottom of this file).
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { MapInternals } from "./mapInternals";
import { updateMarkersAt } from "./markerUpdate";
import { buildPlaneTrails } from "./planeWarfare";
import type { CameraSample, SquadronPlane } from "@/api";

const PLANE_ID = 7;

/** One recorded pose (world coords, yaw in radians). */
const sp = (
  time: number,
  index: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
): SquadronPlane => ({ time, planeId: PLANE_ID, index, x, y, z, yaw });

/** planesHealth packing for k flying planes, every band at full (digit 1) —
 *  the live flying count markerUpdate renders. */
function packed(k: number): number {
  let acc = 0;
  for (let i = 0; i < k; i++) acc += 8 ** i;
  return acc;
}

/** Wrap an airframe rotation into [0, 2π) — the placement writes raw
 *  π − yaw + π values, so π and 3π are the same heading. */
const normalizeAngle = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

const poolOf = (n: number) =>
  Array.from({ length: n }, () => {
    const g = new THREE.Group();
    g.visible = false;
    return g;
  });

/** Points fallback cloud with one slot for the squadron. */
function cloudOf(): {
  points: THREE.Points;
  arr: Float32Array;
  active: Uint8Array;
} {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(3);
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial());
  points.visible = false;
  return { points, arr: positions, active: new Uint8Array(1) };
}

/** Minimal internals for the aircraft block of updateMarkersAt (same shape
 *  as planeCountRender.test.ts's fake). Tests assign the plane fields they
 *  need on the returned context. */
function makeCtx(): MapInternals {
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
    planeTrails: [],
    planeSmoothState: new Map(),
    planeMeshes: new Map(),
    squadronStates: null,
    planeFormations: new Map(),
    planeLaunchPoses: new Map(),
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

/** One formation's anchor trail: a lead plane parked at (100, y, −50) facing
 *  east (yaw π/2 → world forward +X), sampled at t = 10 s and 20 s. */
function anchorTrail(yaw = Math.PI / 2, y = 16): { id: number; samples: SquadronPlane[] } {
  return {
    id: PLANE_ID * 16,
    samples: [sp(10, 0, 100, y, -50, yaw), sp(20, 0, 100, y, -50, yaw)],
  };
}

/** One recorder-camera sample (0x25); only time + y matter to the altitude
 *  lookup, the rest carries the user's 147 s frame pose. */
const cameraFrame = (time: number, y: number): CameraSample => ({
  time,
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  rotW: 1,
  x: 193.04,
  y,
  z: -287.27,
  fov: 1,
});

describe("recorded/original camera view hangs the wedge on the recorded anchor", () => {
  it("places the wedge from the anchor pose, with the recorded heading", () => {
    const pool = poolOf(5);
    const ctx = makeCtx();
    ctx.planeTrails = [anchorTrail()];
    ctx.planeMeshes = new Map([[PLANE_ID, pool]]);
    ctx.planeFormations = new Map([
      [PLANE_ID, { count: 5, groupSize: 1, groupCount: 5, meshes: [] }],
    ]);
    // 3 of the 5 launch slots are still flying → slots 3/4 are surplus.
    ctx.squadronStates = {
      planesHealth: [{ time: 12, planeId: PLANE_ID, packed: packed(3) }],
    } as MapInternals["squadronStates"];
    ctx.planeRecordedView = true;
    updateMarkersAt(ctx, 15);
    // Layout math is the patrol orbit's own: offsets over 5 single-plane
    // groups = (0,0) (-10,-15) (10,-15) (-10,-30) (10,-30), centroid
    // (0, −18), heading (−sin π/2, cos π/2) → fwd (+X), right (+Z).
    // Recorded view: centre = anchor (100, −50), yBase = max(0, 16) = 16.
    expect(pool.filter((m) => m.visible)).toHaveLength(3);
    // Slot 0: centre + (18, 0) → (118, 16−2, −(−50) + 0).
    expect(pool[0].position.x).toBeCloseTo(118);
    expect(pool[0].position.y).toBeCloseTo(14);
    expect(pool[0].position.z).toBeCloseTo(50);
    // Slot 1: centre + (3, −10) → (103, 16+0, 40).
    expect(pool[1].position.x).toBeCloseTo(103);
    expect(pool[1].position.y).toBeCloseTo(16);
    expect(pool[1].position.z).toBeCloseTo(40);
    // Slot 2: centre + (3, 10) → (103, 16+2, 60).
    expect(pool[2].position.x).toBeCloseTo(103);
    expect(pool[2].position.y).toBeCloseTo(18);
    expect(pool[2].position.z).toBeCloseTo(60);
    // Recorded altitude is NOT lifted to the 60 m patrol floor.
    for (const m of pool.slice(0, 3)) expect(m.position.y).toBeLessThan(60);
    // Heading = the anchor's recorded yaw, through the plane airframe
    // convention (π − yaw + π), shared by the whole wedge.
    expect(pool[0].rotation.y).toBeCloseTo(2 * Math.PI - Math.PI / 2);
    expect(pool[1].rotation.y).toBe(pool[0].rotation.y);
    expect(pool[2].rotation.y).toBe(pool[0].rotation.y);
    // Surplus slots past the live count stay dark.
    expect(pool[3].visible).toBe(false);
    expect(pool[4].visible).toBe(false);
  });

  it("takes the recorded altitude from the recorder camera frame", () => {
    // The recorded plane camera rides AT the squadron, so its own y IS the
    // formation's altitude. The minimap-derived anchor sample's synthetic
    // y = 20 measured 47.9° off the recorded view axis (outside the 28.6°
    // half-fov frame — still "no planes") while y ≈ 16 sits 27.8° off-axis,
    // inside it. Recorded mode therefore uses the camera frame's y.
    const pool = poolOf(3);
    const ctx = makeCtx();
    ctx.planeTrails = [anchorTrail(Math.PI / 2, 20)];
    ctx.planeMeshes = new Map([[PLANE_ID, pool]]);
    ctx.planeFormations = new Map([
      [PLANE_ID, { count: 3, groupSize: 1, groupCount: 3, meshes: [] }],
    ]);
    // Two frames: the LAST one at/before the playhead wins (16.2, not 30).
    ctx.props.cameraFrames = [cameraFrame(5, 30), cameraFrame(12, 16.2)];
    ctx.planeRecordedView = true;
    updateMarkersAt(ctx, 15);
    expect(pool.filter((m) => m.visible)).toHaveLength(3);
    // yBase = 16.2 → the recorded wedge's −2 / 0 / +2 alternation.
    expect(pool[0].position.y).toBeCloseTo(14.2);
    expect(pool[1].position.y).toBeCloseTo(16.2);
    expect(pool[2].position.y).toBeCloseTo(18.2);
  });

  it("hangs the wedge AHEAD of the recorded lens with the pad clearance", () => {
    // User report: the plane camera showed the aircraft as shattered red
    // triangles and twitched. The recorder flew a PLANE camera, so its
    // centre track sits ~at the lens; placing the wedge AT the anchor put
    // the camera inside the models. The wedge now hangs on the interpolated
    // view axis, nearest slot RECORDED_PLANE_PAD units out.
    const pool = poolOf(5);
    const ctx = makeCtx();
    ctx.planeTrails = [anchorTrail(Math.PI / 2, 20)];
    ctx.planeMeshes = new Map([[PLANE_ID, pool]]);
    ctx.planeFormations = new Map([
      [PLANE_ID, { count: 5, groupSize: 1, groupCount: 5, meshes: [] }],
    ]);
    ctx.squadronStates = {
      planesHealth: [{ time: 12, planeId: PLANE_ID, packed: packed(5) }],
    } as MapInternals["squadronStates"];
    // Identity rotation, recorder frame at world (193.04, 16.2, −287.27):
    // scene pose (193.04, 16.2, 287.27), view axis down scene −Z.
    ctx.props.cameraFrames = [cameraFrame(5, 16.2)];
    ctx.planeRecordedView = true;
    updateMarkersAt(ctx, 15);
    const cam = new THREE.Vector3(193.04, 16.2, 287.27);
    const visible = pool.filter((m) => m.visible);
    expect(visible).toHaveLength(5);
    for (const m of visible) {
      // Ahead of the lens (scene −Z side) and clear of the near plane.
      expect(m.position.z).toBeLessThan(cam.z);
      expect(cam.distanceTo(m.position)).toBeGreaterThan(34 - 1e-6);
      // The wedge stays centred on the view axis.
      expect(Math.abs(m.position.x - cam.x)).toBeLessThan(40);
      expect(Math.abs(m.position.y - cam.y)).toBeLessThan(40);
    }
    // Heading = the camera's view axis. Identity rotation looks down scene
    // −Z and the placement's fwd is a SCENE direction ((sin yaw, −cos yaw)),
    // so yaw = atan2(0, 1) = 0 → the airframe convention writes 2π: the
    // wedge flies AWAY from the lens.
    expect(normalizeAngle(visible[0].rotation.y)).toBeCloseTo(0);
    expect(visible[1].rotation.y).toBe(visible[0].rotation.y);
  });

  it("turns the wedge to face away from a camera looking along scene +Z", () => {
    // The z-mirror trap: a yaw taken from the WORLD-frame conversion would
    // point the formation back at the lens here (0° instead of 180°).
    const pool = poolOf(2);
    const ctx = makeCtx();
    ctx.planeTrails = [anchorTrail(Math.PI / 2, 20)];
    ctx.planeMeshes = new Map([[PLANE_ID, pool]]);
    ctx.planeFormations = new Map([
      [PLANE_ID, { count: 2, groupSize: 1, groupCount: 2, meshes: [] }],
    ]);
    // 180° about +Y: the camera looks along scene +Z.
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI,
    );
    ctx.props.cameraFrames = [
      {
        ...cameraFrame(5, 16.2),
        rotX: q.x,
        rotY: q.y,
        rotZ: q.z,
        rotW: q.w,
      },
    ];
    ctx.planeRecordedView = true;
    updateMarkersAt(ctx, 15);
    const cam = new THREE.Vector3(193.04, 16.2, 287.27);
    for (const m of pool) {
      // Ahead = scene +Z now.
      expect(m.position.z).toBeGreaterThan(cam.z + 30);
    }
    // yaw = atan2(0, −1) = π → the airframe convention writes π.
    expect(normalizeAngle(pool[0].rotation.y)).toBeCloseTo(Math.PI);
  });

  it("follows the camera's view axis when the recorder looked sideways", () => {
    const pool = poolOf(2);
    const ctx = makeCtx();
    ctx.planeTrails = [anchorTrail(Math.PI / 2, 20)];
    ctx.planeMeshes = new Map([[PLANE_ID, pool]]);
    ctx.planeFormations = new Map([
      [PLANE_ID, { count: 2, groupSize: 1, groupCount: 2, meshes: [] }],
    ]);
    // Rotation about +Y by −90° → the camera looks along scene +X.
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      -Math.PI / 2,
    );
    ctx.props.cameraFrames = [
      {
        ...cameraFrame(5, 16.2),
        rotX: q.x,
        rotY: q.y,
        rotZ: q.z,
        rotW: q.w,
      },
    ];
    ctx.planeRecordedView = true;
    updateMarkersAt(ctx, 15);
    const cam = new THREE.Vector3(193.04, 16.2, 287.27);
    for (const m of pool) {
      // The view axis is scene +X now: ahead means larger scene x, and the
      // wedge must not slide off along z.
      expect(m.position.x).toBeGreaterThan(cam.x + 30);
      expect(Math.abs(m.position.z - cam.z)).toBeLessThan(40);
    }
  });

  it("falls back to the anchor altitude when there are no camera frames", () => {
    const pool = poolOf(3);
    const ctx = makeCtx();
    ctx.planeTrails = [anchorTrail(Math.PI / 2, 20)];
    ctx.planeMeshes = new Map([[PLANE_ID, pool]]);
    ctx.planeFormations = new Map([
      [PLANE_ID, { count: 3, groupSize: 1, groupCount: 3, meshes: [] }],
    ]);
    ctx.planeRecordedView = true;
    updateMarkersAt(ctx, 15);
    // No 0x25 stream: the anchor's minimap-derived y = 20 is the fallback
    // (still no 60 m patrol floor).
    expect(pool[0].position.y).toBeCloseTo(18);
    expect(pool[1].position.y).toBeCloseTo(20);
    expect(pool[2].position.y).toBeCloseTo(22);
  });

  it("keeps a sparse-3D squadron alive on its minimap-merged anchor", () => {
    // The user's Shokaku replay: `receive_updateSquadron` only streamed the
    // launch (two samples at 30.78/30.9 s); the whole 140 s sortie track only
    // lives in the minimap stream (add 32.6 s, moves up to 170.4 s). Before
    // the merge the anchor died at 30.9 + 5 s and the recorded camera — sitting
    // 2 units from the minimap position at the 147 s playhead — saw nothing.
    const ctx = makeCtx();
    ctx.props.squadronPlanes = [
      sp(30.78, 0, -120, 1, -530, 0.55),
      sp(30.9, 0, -119, 1, -529, 0.55),
      sp(30.78, 1, -118, 1, -532, 0.55),
      sp(30.9, 1, -117, 1, -531, 0.55),
    ];
    ctx.props.minimapSquadronAdds = [
      { time: 32.6, planeId: PLANE_ID, ownerId: 7, teamId: 1, paramsId: 0, x: -110, z: -520 },
    ];
    ctx.props.minimapSquadronMoves = [
      { time: 146.65, planeId: PLANE_ID, x: 193.55, z: 289.4 },
      { time: 170.4, planeId: PLANE_ID, x: 200, z: 300 },
    ];
    buildPlaneTrails(ctx);
    const anchor = ctx.planeTrails.find((tr) => tr.id === PLANE_ID * 16)!;
    // The merged anchor spans the real sortie instead of ending at launch.
    expect(anchor.samples[anchor.samples.length - 1].time).toBe(170.4);
    const pool = poolOf(4);
    ctx.planeMeshes = new Map([[PLANE_ID, pool]]);
    ctx.planeFormations = new Map([
      [PLANE_ID, { count: 4, groupSize: 1, groupCount: 4, meshes: [] }],
    ]);
    ctx.planeRecordedView = true;
    updateMarkersAt(ctx, 147);
    // The formation renders at the recorded track position at 147 s (the old
    // 3D-only trail expired at 35.9 s, so nothing showed in ANY camera mode).
    expect(pool.filter((m) => m.visible)).toHaveLength(4);
    const f = (147 - 146.65) / (170.4 - 146.65);
    const ax = 193.55 + (200 - 193.55) * f;
    const az = 289.4 + (300 - 289.4) * f;
    for (const m of pool) {
      // Wedge offsets are ≤ ~30 units; the anchor itself must be on the track.
      expect(Math.abs(m.position.x - ax)).toBeLessThan(60);
      expect(Math.abs(-m.position.z - az)).toBeLessThan(60);
      // Minimap altitude ~20 — no 60 m orbit floor.
      expect(m.position.y).toBeGreaterThan(14);
      expect(m.position.y).toBeLessThan(26);
    }
    // Heading comes from the minimap path's calibrated yaw = atan2(dx, dz),
    // interpolated between the last two centre samples.
    const yaw146 = Math.atan2(200 - -110, 300 - -520);
    const yaw170 = Math.atan2(200 - 193.55, 300 - 289.4);
    const yawAt147 = yaw146 + (yaw170 - yaw146) * f;
    for (const m of pool) {
      expect(m.rotation.y).toBeCloseTo(2 * Math.PI - yawAt147);
    }
    // One shared heading for the whole wedge (no per-slot poses anymore).
    expect(pool[1].rotation.y).toBe(pool[0].rotation.y);
    // Once the merged trail expires the pool hides like any other formation.
    updateMarkersAt(ctx, 200);
    expect(pool.filter((m) => m.visible)).toHaveLength(0);
  });

  it("keeps the Points fallback dot at the recorded anchor pose", () => {
    const ctx = makeCtx();
    const cloud = cloudOf();
    ctx.planeTrails = [anchorTrail(0)];
    ctx.planeFormations = new Map([
      [PLANE_ID, { count: 1, groupSize: 1, groupCount: 1, meshes: [] }],
    ]);
    ctx.planeCloud = cloud.points;
    ctx.planeCloudActive = cloud.active;
    ctx.planeCloudSlots = new Map([[PLANE_ID, 0]]);
    ctx.planeRecordedView = true;
    updateMarkersAt(ctx, 15);
    // Scene (x, y, −z) of the anchor — the recorded 16 m altitude, not 60.
    expect(cloud.arr[0]).toBeCloseTo(100);
    expect(cloud.arr[1]).toBeCloseTo(16);
    expect(cloud.arr[1]).toBeLessThan(60);
    expect(cloud.arr[2]).toBeCloseTo(50);
    expect(ctx.planeCloudActive[0]).toBe(1);
    expect(cloud.points.visible).toBe(true);
  });

  it("renders a minimap-only squadron at its centre-track anchor", () => {
    // A squadron the 3D stream never saw at all (e.g. another carrier's
    // aircraft): buildPlaneTrails grows the centre trail from the minimap
    // packets, and the recorded view must render the wedge there too.
    const ctx = makeCtx();
    ctx.props.minimapSquadronAdds = [
      { time: 10, planeId: PLANE_ID, ownerId: 7, teamId: 0, paramsId: 0, x: 100, z: -50 },
    ];
    ctx.props.minimapSquadronMoves = [
      { time: 20, planeId: PLANE_ID, x: 100, z: -50 },
    ];
    buildPlaneTrails(ctx);
    const pool = poolOf(2);
    ctx.planeMeshes = new Map([[PLANE_ID, pool]]);
    ctx.planeFormations = new Map([
      [PLANE_ID, { count: 2, groupSize: 1, groupCount: 2, meshes: [] }],
    ]);
    ctx.planeRecordedView = true;
    updateMarkersAt(ctx, 15);
    expect(pool.filter((m) => m.visible)).toHaveLength(2);
    for (const m of pool) {
      // Scene (x, y, −z): the centre trail's x/|z| anchor, wedge offsets
      // within ~40 units, minimap altitude 20 (no 60 m orbit floor).
      expect(Math.abs(m.position.x - 100)).toBeLessThan(40);
      expect(Math.abs(m.position.z - 50)).toBeLessThan(40);
      expect(m.position.y).toBeGreaterThan(16);
      expect(m.position.y).toBeLessThan(24);
    }
  });
});

describe("free/follow camera keeps the synthetic patrol orbit", () => {
  it("still renders the wedge on the 60 m orbit floor with one synthetic heading", () => {
    const pool = poolOf(3);
    const ctx = makeCtx();
    ctx.planeTrails = [anchorTrail()];
    ctx.planeMeshes = new Map([[PLANE_ID, pool]]);
    ctx.planeFormations = new Map([
      [PLANE_ID, { count: 3, groupSize: 1, groupCount: 3, meshes: [] }],
    ]);
    ctx.planeRecordedView = false;
    updateMarkersAt(ctx, 15);
    expect(pool.filter((m) => m.visible)).toHaveLength(3);
    // The anchor's recorded 16 m is lifted to the 60 m patrol floor, then the
    // existing −2 / 0 / +2 slot alternation applies.
    expect(pool[0].position.y).toBeCloseTo(58);
    expect(pool[1].position.y).toBeCloseTo(60);
    expect(pool[2].position.y).toBeCloseTo(62);
    // One synthetic ORBIT heading shared by the whole wedge (the recorded
    // trail's yaw is π/2, so a per-side heading here would mean the recorded
    // branch leaked into the orbit path).
    expect(pool[1].rotation.y).toBe(pool[0].rotation.y);
    expect(pool[2].rotation.y).toBe(pool[0].rotation.y);
    expect(pool[0].rotation.y).not.toBeCloseTo(2 * Math.PI - Math.PI / 2);
    // The R=50 orbit keeps the wedge away from the recorded anchor pose.
    const anchorDist = Math.hypot(pool[0].position.x - 100, pool[0].position.z - 50);
    expect(anchorDist).toBeGreaterThan(20);
  });
});
