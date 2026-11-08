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
 * propMarker + modelLoader are mocked: pool geometry is irrelevant here,
 * and the repo tree ships no plane GLBs for the real resolvers to find.
 */
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ref } from "vue";

vi.mock("./modelLoader", () => ({
  resolvePlaneModelUrl: vi.fn((idx: string | undefined) =>
    idx ? `/models/planes/${idx}.glb` : null),
}));
vi.mock("./propMarker", () => ({
  buildPropMarker: vi.fn(async () => new THREE.Object3D()),
}));

import type { MinimapSquadronAdd, SquadronCreate, SquadronPlane } from "@/api";
import type { MapInternals } from "./mapInternals";
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

/** A trail pair long enough for the grouping sampler. */
const trail = (planeId: number, index = 0) => ({
  id: planeId * 16 + index,
  samples: [sp(planeId, index, 10), sp(planeId, index, 20)],
});

/** Minimal internals: only the fields the two passes touch. */
const makeCtx = (props: {
  squadronCreates?: SquadronCreate[];
  minimapSquadronAdds?: MinimapSquadronAdd[];
}) =>
  ({
    props: {
      squadronCreates: props.squadronCreates ?? [],
      squadronPlanes: [],
      minimapSquadronAdds: props.minimapSquadronAdds ?? [],
      minimapSquadronMoves: [],
      minimapSquadronRemoves: [],
    },
    api: { value: null },
    markerEpoch: 1,
    planeTrails: [],
    planeMeshes: new Map(),
    planeFormations: new Map(),
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
});
