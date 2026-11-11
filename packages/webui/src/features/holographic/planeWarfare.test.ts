/**
 * Unit tests for the aircraft layer's construction passes (planeWarfare.ts):
 * the trail/type/idx tables (buildPlaneTrails) and the per-squadron GLB
 * model pools (buildPlaneFormations).
 *
 * The pool tests pin the two fixes the dots/×1 reports demanded: EVERY
 * squadron of a shared airframe gets its own pool (the old seenKey dedupe
 * left all-but-the-first as Points), and the pool is sized by the DECODED
 * launch size (SquadronCreate.numPlanes) — the GameParams group count is
 * the attack-group size (often 1) and never the flying strength.
 * The merge tests pin the sparse-3D-stream fix: a squadron whose
 * receive_updateSquadron stream stops at launch must keep its anchor trail
 * alive on the minimap centre track (padded at both ends), or the aircraft
 * vanished from every view 5 s after launch.
 *
 * propMarker + modelLoader are mocked: pool geometry is irrelevant here,
 * and the repo tree ships no plane GLBs for the real resolvers to find.
 */
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ref } from "vue";

// Orientation table stub: the tests drive the sign per case (see the
// "counter-rotates" test); everything else behaves as nose +Z.
const planeForwardState = vi.hoisted(() => ({ sign: 1 as 1 | -1 | 0 }));
vi.mock("./modelLoader", () => ({
  resolvePlaneModelUrl: vi.fn((idx: string | undefined) =>
    idx ? `/models/planes/${idx}.glb` : null),
  planeForwardSign: vi.fn(() => planeForwardState.sign),
}));
vi.mock("./propMarker", () => ({
  // A proto shaped like a loaded GLB: one mesh carrying a material, so the
  // per-pool tint pass has something to recolor.
  buildPropMarker: vi.fn(async () => {
    const mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x123456 }),
    );
    mesh.name = "boundingbox";
    const group = new THREE.Group();
    group.add(mesh);
    return group;
  }),
}));

import type {
  MinimapSquadronAdd,
  MinimapSquadronMove,
  MinimapSquadronRemove,
  SquadronCreate,
  SquadronPlane,
} from "@/api";
import type { MapInternals } from "./mapInternals";
import { planeTrailExpiry } from "./planeFormation";
import { buildPlaneFormations, buildPlaneTrails } from "./planeWarfare";

/** Real plane_types.json entries (baked GameParams): PJAF408 is the
 *  attack-group-size-1 trap (count: 1), PJAF208 a size-9 airframe. */
const WARD_PARAMS_ID = 3866984144; // PJAF408, GameParams count 1
const TOP_FIGHTER_PARAMS_ID = 4076699344; // PJAF208, GameParams count 9
const UNKNOWN_PARAMS_ID = 1; // absent from plane_types.json

const create = (
  planeId: number,
  paramsId: number,
  numPlanes?: number,
  totalNumPlanes?: number,
): SquadronCreate => ({
  time: 10,
  planeId,
  paramsId,
  ...(numPlanes != null ? { numPlanes } : {}),
  ...(totalNumPlanes != null ? { totalNumPlanes } : {}),
  x: 0,
  y: 100,
  z: 0,
});

const add = (planeId: number, paramsId: number): MinimapSquadronAdd => ({
  time: 10,
  planeId,
  ownerId: 7,
  teamId: 1,
  paramsId,
  x: 0,
  z: 0,
});

const sp = (planeId: number, index: number, time: number): SquadronPlane => ({
  time,
  planeId,
  index,
  x: index * 5,
  y: 100,
  z: 0,
  yaw: 0,
});

/** A 3D airborne sample at an explicit pose. */
const spAt = (
  planeId: number,
  index: number,
  time: number,
  x: number,
  y: number,
  z: number,
  yaw = 0,
): SquadronPlane => ({ time, planeId, index, x, y, z, yaw });

/** A minimap centre sample (add) at an explicit time/position. */
const addAt = (
  planeId: number,
  time: number,
  x: number,
  z: number,
): MinimapSquadronAdd => ({
  time,
  planeId,
  ownerId: 7,
  teamId: 1,
  paramsId: TOP_FIGHTER_PARAMS_ID,
  x,
  z,
});

/** A minimap centre-track move at an explicit time/position. */
const move = (
  planeId: number,
  time: number,
  x: number,
  z: number,
): MinimapSquadronMove => ({ time, planeId, x, z });

/** A trail pair long enough for the grouping sampler. */
const trail = (planeId: number, index = 0) => ({
  id: planeId * 16 + index,
  samples: [sp(planeId, index, 10), sp(planeId, index, 20)],
});

/** Minimal internals: only the fields the two passes touch. */
const makeCtx = (props: {
  squadronCreates?: SquadronCreate[];
  squadronPlanes?: SquadronPlane[];
  minimapSquadronAdds?: MinimapSquadronAdd[];
  minimapSquadronMoves?: MinimapSquadronMove[];
  minimapSquadronRemoves?: MinimapSquadronRemove[];
}) =>
  ({
    props: {
      squadronCreates: props.squadronCreates ?? [],
      squadronPlanes: props.squadronPlanes ?? [],
      minimapSquadronAdds: props.minimapSquadronAdds ?? [],
      minimapSquadronMoves: props.minimapSquadronMoves ?? [],
      minimapSquadronRemoves: props.minimapSquadronRemoves ?? [],
    },
    api: { value: null },
    markerEpoch: 1,
    planeTrails: [],
    planeMeshes: new Map(),
    planeFormations: new Map(),
    planeLaunchPoses: new Map(),
    minimapTrailEnd: new Map(),
    planeTypesById: new Map(),
    planeIndexById: new Map(),
    planeRoleById: new Map(),
  }) as unknown as MapInternals;

describe("buildPlaneTrails", () => {
  it("maps a create's paramsId to every formation slot's idx", () => {
    const ctx = makeCtx({ squadronCreates: [create(100, TOP_FIGHTER_PARAMS_ID)] });
    buildPlaneTrails(ctx);
    expect(ctx.planeIndexById.get(100 * 16)).toBe("PJAF208");
    expect(ctx.planeIndexById.get(100 * 16 + 3)).toBe("PJAF208");
    expect(ctx.planeTypesById.get(100 * 16)).toBe("fighter");
  });

  it("joins minimap-only squadrons (the 2D stream names the same paramsId)", () => {
    const ctx = makeCtx({ minimapSquadronAdds: [add(200, TOP_FIGHTER_PARAMS_ID)] });
    buildPlaneTrails(ctx);
    expect(ctx.planeIndexById.get(200 * 16)).toBe("PJAF208");
    // The minimap-only squadron also grows a centre trail (index 0).
    expect(ctx.planeTrails.some((tr) => tr.id === 200 * 16)).toBe(true);
  });

  it("repairs a slot poisoned by a paramsId plane_types.json misses", () => {
    // The 3D stream names an unknown paramsId first; the minimap stream's
    // good one for the SAME planeId must still land the model idx (the old
    // first-writer-wins guard made the miss permanent).
    const ctx = makeCtx({
      squadronCreates: [create(300, UNKNOWN_PARAMS_ID)],
      minimapSquadronAdds: [add(300, TOP_FIGHTER_PARAMS_ID)],
    });
    buildPlaneTrails(ctx);
    expect(ctx.planeIndexById.get(300 * 16)).toBe("PJAF208");
  });

  it("keeps the good idx when only the second stream misses", () => {
    const ctx = makeCtx({
      squadronCreates: [create(310, TOP_FIGHTER_PARAMS_ID)],
      minimapSquadronAdds: [add(310, UNKNOWN_PARAMS_ID)],
    });
    buildPlaneTrails(ctx);
    expect(ctx.planeIndexById.get(310 * 16)).toBe("PJAF208");
  });

  it("clears the previous replay's stale idx entries", () => {
    const ctx = makeCtx({});
    // A dead replay's leftover: same small trail id, different airframe.
    ctx.planeIndexById.set(400 * 16, "PJXX999");
    ctx.planeTypesById.set(400 * 16, "bomber");
    buildPlaneTrails(ctx);
    expect(ctx.planeIndexById.has(400 * 16)).toBe(false);
    expect(ctx.planeTypesById.has(400 * 16)).toBe(false);
  });
});

describe("buildPlaneTrails minimap-stream merge", () => {
  it("pads an existing anchor trail at both ends, leaving the 3D middle intact", () => {
    // The 14.5.0.0 Shokaku reference: receive_updateSquadron stops at launch
    // while the sortie track only lives in the minimap centre stream. The
    // index-0 trail must span the REAL sortie, or planeTrailExpiry kills the
    // formation 5 s after the last 3D sample and no camera mode shows it.
    const three3d = [
      spAt(500, 0, 10, -100, 1, -400),
      spAt(500, 0, 20, -98, 1.5, -395),
    ];
    const ctx = makeCtx({
      squadronPlanes: [
        ...three3d,
        spAt(500, 1, 10, -90, 1, -410),
        spAt(500, 1, 20, -88, 1.5, -405),
      ],
      minimapSquadronAdds: [addAt(500, 8, 0, 0)],
      minimapSquadronMoves: [
        move(500, 12, 10, 0), // inside the 3D span → dropped (no interleave)
        move(500, 30, 20, 10), // after the 3D span → padded
        move(500, 40, 20, 30), // after the 3D span → padded
      ],
    });
    buildPlaneTrails(ctx);
    const anchor = ctx.planeTrails.find((tr) => tr.id === 500 * 16)!;
    // Ascending merged timeline: minimap-before, the untouched 3D middle,
    // minimap-after.
    expect(anchor.samples.map((s) => s.time)).toEqual([8, 10, 20, 30, 40]);
    // The 3D launch samples are the very same objects, in their own slots.
    expect(anchor.samples[1]).toBe(three3d[0]);
    expect(anchor.samples[2]).toBe(three3d[1]);
    // Padded minimap samples: synthetic altitude 20 + explicit pose.
    expect(anchor.samples[0]).toMatchObject({ x: 0, y: 20, z: 0 });
    expect(anchor.samples[3]).toMatchObject({ x: 20, y: 20, z: 10 });
    expect(anchor.samples[4]).toMatchObject({ x: 20, y: 20, z: 30 });
    // The move INSIDE the 3D span was not interleaved.
    expect(anchor.samples.some((s) => s.time === 12)).toBe(false);
    // ...and the wingman's 3D trail was left alone entirely.
    const wing = ctx.planeTrails.find((tr) => tr.id === 500 * 16 + 1)!;
    expect(wing.samples.map((s) => s.time)).toEqual([10, 20]);
    // The trail now lives to 40 s (+5 s grace) instead of the old 3D-only
    // expiry at 20 s (+5 s) — the formation survives the whole sortie.
    expect(planeTrailExpiry(anchor.samples[4].time, ctx.minimapTrailEnd.get(500))).toBe(45);
    // Heading derived from the MINIMAP path's neighbours: atan2(dx, dz).
    expect(anchor.samples[0].yaw).toBeCloseTo(Math.PI / 2); // (10−0, 0−0)
    expect(anchor.samples[3].yaw).toBeCloseTo(Math.atan2(10, 30)); // (20−10, 30−0)
    expect(anchor.samples[4].yaw).toBeCloseTo(0); // (0, 20)
  });

  it("derives the heading for a minimap-only centre trail", () => {
    // Minimap packets carry no heading. Without the derivation the recorded
    // view and the follow camera's anchor fallback would fly every
    // minimap-only squadron at yaw 0.
    const ctx = makeCtx({
      minimapSquadronAdds: [addAt(600, 10, 0, 0)],
      minimapSquadronMoves: [move(600, 20, 20, 0), move(600, 30, 20, 20)],
    });
    buildPlaneTrails(ctx);
    const trail = ctx.planeTrails.find((tr) => tr.id === 600 * 16)!;
    expect(trail.samples.map((s) => s.time)).toEqual([10, 20, 30]);
    // Calibrated convention: atan2(dx, dz) over the centre path's neighbours.
    expect(trail.samples[0].yaw).toBeCloseTo(Math.PI / 2); // (20, 0)
    expect(trail.samples[1].yaw).toBeCloseTo(Math.atan2(20, 20)); // (20, 20)
    expect(trail.samples[2].yaw).toBeCloseTo(0); // (0, 20)
    // The existing minimap-only contract (single list, y = 20) is unchanged.
    for (const s of trail.samples) expect(s.y).toBe(20);
  });

  it("records the PRE-merge launch pose for the grouping inference", () => {
    // buildPlaneFormations clusters the launch poses; sampling the merged
    // trail instead would mix the padded centre-track pose with the
    // wingmen's launch poses and flip the wedge layout (14 of 64
    // multi-member squadrons on the reference capture).
    const ctx = makeCtx({
      squadronPlanes: [
        spAt(700, 0, 10, -100, 1, -400),
        spAt(700, 0, 20, -98, 1.5, -395),
      ],
      minimapSquadronAdds: [addAt(700, 6, 50, 60)],
      minimapSquadronMoves: [move(700, 8, 52, 62)],
    });
    buildPlaneTrails(ctx);
    const anchor = ctx.planeTrails.find((tr) => tr.id === 700 * 16)!;
    // The trail itself IS padded at the front with the centre track...
    expect(anchor.samples[0].time).toBe(6);
    expect(anchor.samples[0]).toMatchObject({ x: 50, z: 60 });
    // ...while the grouping pose stays the 3D launch pose.
    expect(ctx.planeLaunchPoses.get(700 * 16)).toEqual({ x: -100, z: -400 });
  });

  it("derives yaw 0 and a launch pose for a single-sample minimap trail", () => {
    const ctx = makeCtx({ minimapSquadronAdds: [add(800, TOP_FIGHTER_PARAMS_ID)] });
    buildPlaneTrails(ctx);
    const centre = ctx.planeTrails.find((tr) => tr.id === 800 * 16)!;
    expect(centre.samples).toHaveLength(1);
    expect(centre.samples[0].yaw).toBe(0);
    expect(ctx.planeLaunchPoses.get(800 * 16)).toEqual({ x: 0, z: 0 });
  });

  it("does not pad minimap samples that coincide with the 3D span boundaries", () => {
    const ctx = makeCtx({
      squadronPlanes: [spAt(900, 0, 10, 0, 1, 0), spAt(900, 0, 20, 0, 1, 0)],
      minimapSquadronAdds: [addAt(900, 10, 0, 0)],
      minimapSquadronMoves: [move(900, 20, 0, 0), move(900, 30, 0, 0)],
    });
    buildPlaneTrails(ctx);
    const anchor = ctx.planeTrails.find((tr) => tr.id === 900 * 16)!;
    // Strictly-before/after only: an equal boundary time is already covered
    // by a 3D sample, so the merge must not double-insert it.
    expect(anchor.samples.map((s) => s.time)).toEqual([10, 20, 30]);
  });
});

describe("buildPlaneFormations", () => {
  it("builds a pool for EVERY squadron sharing an airframe and role", async () => {
    // Three squadrons of the SAME type on the SAME side: the old seenKey
    // dedupe built one pool and left the others as dots.
    const ctx = makeCtx({
      squadronCreates: [
        create(1, WARD_PARAMS_ID, 6),
        create(2, WARD_PARAMS_ID, 6),
        create(3, WARD_PARAMS_ID, 6),
      ],
    });
    ctx.planeTrails = [trail(1), trail(2), trail(3)];
    for (const tr of ctx.planeTrails) ctx.planeIndexById.set(tr.id, "PJAF408");
    const scene = new THREE.Scene();
    ctx.api = ref({ scene }) as unknown as MapInternals["api"];
    buildPlaneFormations(ctx, scene, ctx.markerEpoch);
    await vi.waitFor(() => expect(ctx.planeMeshes.size).toBe(3));
  });

  it("sizes the pool by the decoded launch size, not the GameParams group count", async () => {
    // PJAF408's GameParams count is 1 — the attack-group size that used to
    // render ONE model per squadron. Six planes actually launched.
    const ctx = makeCtx({
      squadronCreates: [create(1, WARD_PARAMS_ID, 6, 9)],
    });
    ctx.planeTrails = [trail(1)];
    ctx.planeIndexById.set(1 * 16, "PJAF408");
    const scene = new THREE.Scene();
    ctx.api = ref({ scene }) as unknown as MapInternals["api"];
    buildPlaneFormations(ctx, scene, ctx.markerEpoch);
    await vi.waitFor(() => expect(ctx.planeMeshes.get(1)).toBeDefined());
    expect(ctx.planeFormations.get(1)?.count).toBe(6);
    expect(ctx.planeMeshes.get(1)).toHaveLength(6);
  });

  it("falls back to the GameParams count when the decoded stream is absent", async () => {
    // Pre-field create payloads (no numPlanes/totalNumPlanes): the old
    // fallback is preserved — formation size from plane_types.json.
    const ctx = makeCtx({
      squadronCreates: [create(1, TOP_FIGHTER_PARAMS_ID)],
    });
    ctx.planeTrails = [trail(1)];
    ctx.planeIndexById.set(1 * 16, "PJAF208");
    const scene = new THREE.Scene();
    ctx.api = ref({ scene }) as unknown as MapInternals["api"];
    buildPlaneFormations(ctx, scene, ctx.markerEpoch);
    await vi.waitFor(() => expect(ctx.planeMeshes.get(1)).toBeDefined());
    expect(ctx.planeFormations.get(1)?.count).toBe(9);
  });

  it("drops a pool resolved after an epoch bump (stale build)", async () => {
    const ctx = makeCtx({ squadronCreates: [create(1, WARD_PARAMS_ID, 6)] });
    ctx.planeTrails = [trail(1)];
    ctx.planeIndexById.set(1 * 16, "PJAF408");
    const scene = new THREE.Scene();
    ctx.api = ref({ scene }) as unknown as MapInternals["api"];
    buildPlaneFormations(ctx, scene, 1);
    ctx.markerEpoch = 2; // a rebuild started while the clone was in flight
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.planeMeshes.size).toBe(0);
  });

  it("tints the pool at LOAD time from the FINAL role", async () => {
    // User report: the recorder's own aircraft rendered RED. The pool is
    // tinted when the GLB resolves, which is long after resolvePlaneCarriers
    // filled planeRoleById — reading the role captured when the build
    // STARTED (the empty-map default "enemy") painted every finished pool
    // wrong. Team rule: self white, ally green, enemy red.
    const ctx = makeCtx({
      squadronCreates: [create(1, WARD_PARAMS_ID, 2), create(2, WARD_PARAMS_ID, 2)],
    });
    ctx.planeTrails = [trail(1), trail(2)];
    for (const tr of ctx.planeTrails) {
      ctx.planeIndexById.set(tr.id, "PJAF408");
    }
    ctx.planeRoleById.set(1, "self");
    ctx.planeRoleById.set(2, "ally");
    const scene = new THREE.Scene();
    ctx.api = ref({ scene }) as unknown as MapInternals["api"];
    buildPlaneFormations(ctx, scene, ctx.markerEpoch);
    await vi.waitFor(() => expect(ctx.planeMeshes.size).toBe(2));
    const meshOf = (planeId: number) =>
      ctx.planeMeshes.get(planeId)![0].children[0] as THREE.Mesh;
    const colorOf = (planeId: number) =>
      (meshOf(planeId).material as THREE.MeshBasicMaterial).color.getHex();
    expect(colorOf(1)).toBe(0xffffff);
    expect(colorOf(2)).toBe(0x4ade80);
    // The pools own their materials (propMarker's cache shares one proto
    // per URL): tinting one squadron must not recolor the other side.
    expect(meshOf(1).material).not.toBe(meshOf(2).material);
  });

  it("counter-rotates a nose-−Z model so every aircraft flies nose-first", async () => {
    // The pack is authored BOTH ways (plane_forward.json: 482 of 872 face
    // −Z). The pool turns the −Z half 180° inside the proto so the shared
    // placement convention (rotation.y = π − yaw, nose at local +Z) holds.
    planeForwardState.sign = -1;
    const ml = await import("./modelLoader");
    expect(ml.planeForwardSign("PJAF408")).toBe(-1);
    const ctx = makeCtx({ squadronCreates: [create(1, WARD_PARAMS_ID, 1)] });
    ctx.planeTrails = [trail(1)];
    ctx.planeIndexById.set(1 * 16, "PJAF408");
    const scene = new THREE.Scene();
    ctx.api = ref({ scene }) as unknown as MapInternals["api"];
    buildPlaneFormations(ctx, scene, ctx.markerEpoch);
    await vi.waitFor(() => expect(ctx.planeMeshes.get(1)).toBeDefined());
    const { buildPropMarker } = await import("./propMarker");
    expect(vi.mocked(buildPropMarker)).toHaveBeenLastCalledWith(
      expect.objectContaining({ yawOffset: Math.PI }),
    );
    expect(ctx.planeMeshes.get(1)).toBeDefined();
    // A +Z model passes no offset.
    planeForwardState.sign = 1;
    const ctx2 = makeCtx({ squadronCreates: [create(2, WARD_PARAMS_ID, 1)] });
    ctx2.planeTrails = [trail(2)];
    ctx2.planeIndexById.set(2 * 16, "PJAF408");
    ctx2.api = ref({ scene }) as unknown as MapInternals["api"];
    buildPlaneFormations(ctx2, scene, ctx2.markerEpoch);
    await vi.waitFor(() => expect(ctx2.planeMeshes.get(2)).toBeDefined());
    expect(vi.mocked(buildPropMarker)).toHaveBeenLastCalledWith(
      expect.objectContaining({ yawOffset: 0 }),
    );
  });
});
