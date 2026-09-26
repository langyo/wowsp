/**
 * Aircraft squadron construction, extracted verbatim from the heart of
 * HolographicMap.tsx's rebuildActors: the per-plane trail table (3D aerial
 * stream + minimap stream merge), the Points fallback cloud, the per-
 * formation GLB model pools, and the carrier-label/role resolution that
 * re-tints everything once controlling ships are known.
 */
import * as THREE from "three";
import { PLANE_TYPES } from "./tactical/shellTypes";
import { buildPropMarker } from "./propMarker";
import { resolvePlaneModelUrl } from "./modelLoader";
import { sampleAt } from "./trajectoryMath";
import { inferGrouping } from "./planeFormation";
import { TEAM_COLOR, type TeamRole } from "./teamColors";
import type { MapInternals } from "./mapInternals";
import type { ShipLabel } from "./shipLabel";
import type { MinimapSquadronAdd, SquadronPlane } from "@/api";

/** Assemble ctx.planeTrails from the 3D + minimap squadron streams and
 *  populate the type/index tables. Returns the first create per squadron
 *  — the carrier resolver needs it later in the same build. */
export function buildPlaneTrails(ctx: MapInternals): Map<number, MinimapSquadronAdd> {
  // Aircraft squadrons: one model per plane, positions come from the
  // avatar's receive_updateSquadron stream. Each update packet carries
  // one sample per aircraft (index 0..count-1), so (planeId, index)
  // uniquely identifies a single plane — a squadron of N planes becomes
  // N trails instead of one.
  const byPlane = new Map<number, SquadronPlane[]>();
  for (const sp of ctx.props.squadronPlanes) {
    const key = sp.planeId * 16 + (sp.index ?? 0);
    let list = byPlane.get(key);
    if (!list) {
      list = [];
      byPlane.set(key, list);
    }
    list.push(sp);
  }
  ctx.planeTrails = [...byPlane.entries()].map(([id, samples]) => ({
    id,
    samples: samples.sort((a, b) => a.time - b.time),
  }));
  // Minimap squadron stream (receive_add/update/removeMinimapSquadron):
  // the 2D trail the in-game minimap itself renders. Squadrons without
  // 3D aerial-path samples get their CENTER trail from here; the remove
  // events cap every trail's lifetime (landed / shot down / recalled).
  const minimapAddFirst = new Map<number, MinimapSquadronAdd>();
  for (const a of ctx.props.minimapSquadronAdds) {
    if (!minimapAddFirst.has(a.planeId)) minimapAddFirst.set(a.planeId, a);
  }
  ctx.minimapTrailEnd.clear();
  for (const r of ctx.props.minimapSquadronRemoves) {
    const prev = ctx.minimapTrailEnd.get(r.planeId);
    if (prev == null || r.time < prev) ctx.minimapTrailEnd.set(r.planeId, r.time);
  }
  {
    const extra = new Map<number, SquadronPlane[]>();
    const push = (planeId: number, time: number, x: number, z: number) => {
      const end = ctx.minimapTrailEnd.get(planeId);
      if (end != null && time > end) return;
      let list = extra.get(planeId);
      if (!list) {
        list = [];
        extra.set(planeId, list);
      }
      // Altitude ~20: the patrol orbit lifts anchors below this anyway.
      list.push({ time, planeId, index: 0, x, y: 20, z, yaw: 0 });
    };
    for (const a of ctx.props.minimapSquadronAdds) push(a.planeId, a.time, a.x, a.z);
    for (const m of ctx.props.minimapSquadronMoves) push(m.planeId, m.time, m.x, m.z);
    for (const [pid, list] of extra) {
      list.sort((a, b) => a.time - b.time);
      if (!ctx.planeTrails.some((tr) => Math.floor(tr.id / 16) === pid)) {
        ctx.planeTrails.push({ id: pid * 16, samples: list });
      }
    }
  }
  // (planeId, index) → aircraft type (via the squadron create's
  // paramsId). Trails keyed by planeId*16+index, so every formation
  // member maps to its squadron's type. The minimap stream names the
  // same paramsId and covers squadrons the 3D stream missed.
  ctx.planeTypesById.clear();
  const typesOf = (paramsId: number, planeId: number) => {
    const type = PLANE_TYPES[String(paramsId)]?.type ?? "attack";
    const index = PLANE_TYPES[String(paramsId)]?.index;
    for (let i = 0; i < 16; i++) {
      if (!ctx.planeTypesById.has(planeId * 16 + i)) {
        ctx.planeTypesById.set(planeId * 16 + i, type);
        if (index) ctx.planeIndexById.set(planeId * 16 + i, index);
      }
    }
  };
  for (const c of ctx.props.squadronCreates) typesOf(c.paramsId, c.planeId);
  for (const a of minimapAddFirst.values()) typesOf(a.paramsId, a.planeId);
  return minimapAddFirst;
}

/** Points fallback cloud: one slot per unique SQUADRON, team-tinted. */
export function buildPlaneCloud(ctx: MapInternals, scene: THREE.Scene) {
  if (ctx.planeTrails.length > 0) {
    // One cloud slot per unique SQUADRON (index-0 trails are anchors;
    // formation members share the squadron's point). Slots are assigned
    // in trail order — never derived from the composite id.
    ctx.planeCloudSlots.clear();
    const colors = new Float32Array(ctx.planeTrails.length * 3);
    ctx.colorsCloud = colors;
    let slot = 0;
    for (let i = 0; i < ctx.planeTrails.length; i++) {
      const planeId = Math.floor(ctx.planeTrails[i].id / 16);
      if (ctx.planeTrails[i].id % 16 !== 0) continue;
      if (ctx.planeCloudSlots.has(planeId)) continue;
      ctx.planeCloudSlots.set(planeId, slot);
      // Team colour (ally green / enemy red) instead of per-type tint —
      // the HUD paints aircraft by allegiance, not by airframe.
      const role = ctx.planeRoleById.get(planeId) ?? "enemy";
      const c = new THREE.Color(TEAM_COLOR[role as TeamRole] ?? 0x78d2ff);
      colors[slot * 3] = c.r;
      colors[slot * 3 + 1] = c.g;
      colors[slot * 3 + 2] = c.b;
      slot++;
    }
    const slotCount = Math.max(1, slot);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(slotCount * 3), 3),
    );
    pg.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    pg.computeBoundingSphere();
    // Round dot texture: raw Points render as SQUARES, which read as
    // strange blocks hovering over ships.
    const dotCanvas = document.createElement("canvas");
    dotCanvas.width = 32;
    dotCanvas.height = 32;
    const dctx = dotCanvas.getContext("2d")!;
    const grad = dctx.createRadialGradient(16, 16, 2, 16, 16, 15);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.7, "rgba(255,255,255,1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    dctx.fillStyle = grad;
    dctx.fillRect(0, 0, 32, 32);
    const dotTex = new THREE.CanvasTexture(dotCanvas);
    const pm = new THREE.PointsMaterial({
      size: 7,
      sizeAttenuation: false,
      vertexColors: true,
      map: dotTex,
      transparent: true,
      alphaTest: 0.4,
      depthWrite: false,
    });
    const points = new THREE.Points(pg, pm);
    points.visible = false;
    scene.add(points);
    ctx.planeCloud = points;
  }
}

/** Per-formation GLB model pools, launched async and epoch-guarded. */
export function buildPlaneFormations(ctx: MapInternals, scene: THREE.Scene, epoch: number) {
  // Real aircraft models: per FORMATION (one GLB clone per squadron slot —
  // the GameParams squadron size, e.g. 8), arranged in a wedge each frame.
  // Trails whose model fails/misses keep the Points fallback.
  ctx.planeMeshes.clear();
  ctx.planeFormations.clear();
  {
    // Group trails by planeId first.
    const byPlane = new Map<number, { idx: string; role: string; count: number; trail: { id: number; samples: SquadronPlane[] } }[]>();
    for (const trail of ctx.planeTrails) {
      const planeId = Math.floor(trail.id / 16);
      const idx = ctx.planeIndexById.get(trail.id);
      if (!idx) continue;
      const role = ctx.planeRoleById.get(planeId) ?? "enemy";
      let list = byPlane.get(planeId);
      if (!list) {
        list = [];
        byPlane.set(planeId, list);
      }
      const typeKey = PLANE_TYPES[String(
        ctx.props.squadronCreates.find((c) => c.planeId === planeId)?.paramsId,
      )];
      const count = (typeKey?.count ?? 3);
      if (list.length === 0) {
        ctx.planeFormations.set(planeId, { count, groupSize: 1, groupCount: count, meshes: [] });
      }
      list.push({ idx, role, count, trail });
    }
    const seenKey = new Set<string>();
    for (const [planeId, entries] of byPlane) {
      // Infer the group layout from the launch positions (clusters of
      // planes spawned together = one flight group).
      const grp = inferGrouping(entries, sampleAt);
      const formation = ctx.planeFormations.get(planeId)!;
      formation.groupSize = Math.max(1, Math.min(grp.groupSize, formation.count));
      formation.groupCount = Math.max(1, grp.groupCount);
      const first = entries[0];
      const url = resolvePlaneModelUrl(first.idx);
      if (!url) continue;
      const seen = `${first.idx}:${first.role}`;
      const build = seenKey.has(seen)
        ? null
        : buildPropMarker({
            url,
            color: TEAM_COLOR[first.role as TeamRole] ?? 0x78d2ff,
            axis: "z",
            targetLen: 7,
            opacity: 0.95,
          }).catch(() => null);
      seenKey.add(seen);
      if (!build) continue;
      const formationForPool = ctx.planeFormations.get(planeId)!;
      build.then((proto) => {
        if (epoch !== ctx.markerEpoch || !ctx.api.value?.scene || !proto) return;
        if (ctx.planeMeshes.has(planeId)) return;
        const pool: THREE.Object3D[] = [];
        for (let i = 0; i < formationForPool.count; i++) {
          const inst = proto.clone(true);
          inst.userData.sharedGeometry = true;
          inst.visible = false;
          scene.add(inst);
          pool.push(inst);
        }
        ctx.planeMeshes.set(planeId, pool);
      });
    }
  }
}

/** Resolve each squadron's controlling carrier (minimap ownerId → proximity
 *  heuristic), emit one label card per carrier, re-tint the plane layer to
 *  the final roles and fill the per-plane → labelId table. */
export function resolvePlaneCarriers(
  ctx: MapInternals,
  newLabels: ShipLabel[],
  minimapAddFirst: Map<number, MinimapSquadronAdd>,
) {
  // Aircraft labels: ONE card per controlling carrier (aircraft squadrons
  // re-launch constantly — 100+ sorties in a carrier match — so per-
  // squadron cards would explode the UI). The card shows the carrier's
  // name + HP with the plane-type icon. A squadron's carrier is the ship
  // nearest its FIRST create position (the create fires on the deck at
  // launch; later creates are mid-air sortie positions).
  ctx.planeLabelCarriers.clear();
  ctx.planeRoleById.clear();
  const planeCarrierOf = new Map<number, number | null>();
  const createFirst = new Map<number, { x: number; z: number; time: number; paramsId: number }>();
  for (const c of ctx.props.squadronCreates) {
    if (!createFirst.has(c.planeId)) {
      createFirst.set(c.planeId, { x: c.x, z: c.z, time: c.time, paramsId: c.paramsId });
    }
  }
  // The minimap stream's create events also seed the first-create table
  // (same launch semantics; covers squadrons the 3D stream never saw).
  for (const a of minimapAddFirst.values()) {
    if (!createFirst.has(a.planeId)) {
      createFirst.set(a.planeId, { x: a.x, z: a.z, time: a.time, paramsId: a.paramsId });
    }
  }
  for (const [planeId, first] of createFirst) {
    // Match against the ship's position AT LAUNCH TIME (ships move — the
    // current playhead position would pair a sortie with the wrong ship).
    // The create fires on the flight deck, so prefer a REAL carrier
    // (AirCarrier type) within carrier range; only fall back to any ship
    // within a much tighter radius when no CV is nearby (hybrid carriers
    // like Ise/Tone are typed Battleship, unknown offline ships have no
    // type). Without the type filter a sortie from a distant CV gets
    // pinned to whatever friendly ship sails nearest — e.g. a Vladivostok
    // ends up wearing a bomber label and squadrons flip to the wrong side.
    let cvId: number | null = null;
    let cvD = 1000;
    let anyId: number | null = null;
    let anyD = 400;
    for (const m of ctx.shipMarkers) {
      const tr = ctx.props.trajectories.find((t) => t.entityId === m.userData.entityId);
      if (!tr) continue;
      const s = sampleAt(tr, first.time);
      if (!s) continue;
      const d = Math.hypot(s.x - first.x, s.z - first.z);
      if (d < cvD) {
        const lbl = newLabels.find((l) => l.entityId === m.userData.entityId);
        if (/^AirCarrier/i.test(lbl?.type ?? "")) {
          cvD = d;
          cvId = m.userData.entityId as number;
        }
      }
      if (d < anyD) {
        anyD = d;
        anyId = m.userData.entityId as number;
      }
    }
    // The minimap stream names the owner outright (the carrier's vehicle
    // id is packed into the squadron id) — trust it over the proximity
    // heuristic, which can pin a sortie to a nearby hybrid/BB.
    const owner = minimapAddFirst.get(planeId)?.ownerId ?? null;
    const owned =
      owner != null && ctx.shipMarkers.some((m) => m.userData.entityId === owner);
    const carrierId = owned ? owner : (cvId ?? anyId);
    planeCarrierOf.set(planeId, carrierId);
    const carrierMarker = carrierId == null
      ? null
      : ctx.shipMarkers.find((m) => m.userData.entityId === carrierId);
    ctx.planeRoleById.set(planeId, carrierMarker?.userData.role ?? "enemy");
    const planeIdx = PLANE_TYPES[String(createFirst.get(planeId)?.paramsId)]?.index;
    if (planeIdx) ctx.planeIndexById.set(planeId * 16, planeIdx);
  }
  // One label per carrier that controls any aircraft.
  const carriersOfPlanes = new Map<number, { paramsId: number }>();
  for (const [planeId, carrierId] of planeCarrierOf) {
    if (carrierId == null) continue;
    const first = createFirst.get(planeId)!;
    const acc = carriersOfPlanes.get(carrierId) ?? { paramsId: first.paramsId };
    carriersOfPlanes.set(carrierId, acc);
  }
  for (const [carrierId, info] of carriersOfPlanes) {
    const planeType = PLANE_TYPES[String(info.paramsId)]?.type ?? "attack";
    newLabels.push({
      entityId: 2_000_000_000 + Number(carrierId),
      role: "self",
      name: "",
      shipName: "",
      tier: null,
      type: null,
      kind: "plane",
      planeType,
      hp: null,
      maxHp: null,
      x: 0, y: 0,
      visible: false,
      dead: false,
    });
    ctx.planeLabelCarriers.set(2_000_000_000 + Number(carrierId), carrierId);
  }
  // Re-tint the aircraft layer now that roles are final: the cloud and
  // formation builds ran EARLIER in this pass, when planeRoleById was
  // still empty (first build) or held the previous replay's mapping.
  {
    for (const [planeId, slotIdx] of ctx.planeCloudSlots) {
      const role = ctx.planeRoleById.get(planeId) ?? "enemy";
      const c = new THREE.Color(TEAM_COLOR[role as TeamRole] ?? 0x78d2ff);
      ctx.colorsCloud[slotIdx * 3] = c.r;
      ctx.colorsCloud[slotIdx * 3 + 1] = c.g;
      ctx.colorsCloud[slotIdx * 3 + 2] = c.b;
    }
    const cloudAttr = ctx.planeCloud?.geometry.getAttribute("color") as
      | THREE.BufferAttribute
      | undefined;
    if (cloudAttr) cloudAttr.needsUpdate = true;
    for (const [planeId, pool] of ctx.planeMeshes) {
      const role = ctx.planeRoleById.get(planeId) ?? "enemy";
      const c = new THREE.Color(TEAM_COLOR[role as TeamRole] ?? 0x78d2ff);
      for (const mesh of pool) {
        mesh.traverse((child) => {
          const mat = (child as THREE.Mesh).material as
            | THREE.MeshBasicMaterial
            | undefined;
          if (mat && mat.color) mat.color.copy(c);
        });
      }
    }
  }
  // Keep a per-plane → labelId map for the per-frame position update.
  ctx.planeLabelOfPlane.clear();
  for (const [planeId, carrierId] of planeCarrierOf) {
    if (carrierId != null) {
      ctx.planeLabelOfPlane.set(planeId, 2_000_000_000 + Number(carrierId));
    }
  }
}
