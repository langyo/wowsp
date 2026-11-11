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
import { planeForwardSign, resolvePlaneModelUrl } from "./modelLoader";
import { sampleAt } from "./trajectoryMath";
import { inferGrouping } from "./planeFormation";
import { TEAM_COLOR, type TeamRole } from "./teamColors";
import type { MapInternals } from "./mapInternals";
import type { ShipLabel } from "./shipLabel";
import type { MinimapSquadronAdd, SquadronPlane } from "@/api";

/** First synthetic label id of the per-carrier aircraft cards (one card per
 *  carrier, see resolvePlaneCarriers). The camera menu's aircraft rows reuse
 *  the same namespace to name the carrier they chase. Real entity ids are
 *  far below it, so the namespace can never collide. */
export const PLANE_CARD_LABEL_ID_BASE = 2_000_000_000;

/** Aircraft heading convention, calibrated against every consecutive 3D
 *  aircraft sample pair of the 14.5.0.0 reference capture (5,274 straight-
 *  flight segments): yaw = atan2(dx, dz) over the WORLD-frame travel delta —
 *  the same atan2(vx, vz) the synthetic patrol tangent uses in markerUpdate.
 *  Minimap squadron packets carry no heading, so the centre path's neighbours
 *  are the only source. Without it every minimap-derived pose ships yaw 0,
 *  which the recorded/original camera view (wedge on the recorded heading)
 *  and the follow camera's anchor fallback both read. */
function deriveMinimapYaws(list: SquadronPlane[]): void {
  const n = list.length;
  for (let i = 0; i < n; i++) {
    const prev = list[i > 0 ? i - 1 : 0];
    const next = list[i + 1 < n ? i + 1 : n - 1];
    list[i].yaw = Math.atan2(next.x - prev.x, next.z - prev.z);
  }
}

/** Assemble ctx.planeTrails from the 3D + minimap squadron streams and
 *  populate the type/index tables. Returns the first create per squadron
 *  — the carrier resolver needs it later in the same build. The two streams
 *  are merged so a squadron's anchor trail spans its REAL sortie: the 3D
 *  airborne stream can stop at launch while the minimap centre track keeps
 *  running (see the end-padding block below). */
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
  // Launch poses for the GROUPING inference: captured BEFORE the minimap
  // merge below pads the anchor trail, so the clustering always sees the
  // real launch formation (see MapInternals.planeLaunchPoses).
  ctx.planeLaunchPoses.clear();
  for (const trail of ctx.planeTrails) {
    if (trail.samples.length === 0) continue;
    ctx.planeLaunchPoses.set(trail.id, {
      x: trail.samples[0].x,
      z: trail.samples[0].z,
    });
  }
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
      // Altitude ~20: the minimap stream carries no altitude; the free/follow
      // patrol orbit lifts anchors below 60 anyway, and the recorded camera
      // view renders this nominal height as-is (below the old 60 m floor).
      // yaw starts at 0 and is derived from the path below.
      list.push({ time, planeId, index: 0, x, y: 20, z, yaw: 0 });
    };
    for (const a of ctx.props.minimapSquadronAdds) push(a.planeId, a.time, a.x, a.z);
    for (const m of ctx.props.minimapSquadronMoves) push(m.planeId, m.time, m.x, m.z);
    for (const [pid, list] of extra) {
      list.sort((a, b) => a.time - b.time);
      deriveMinimapYaws(list);
      const anchorId = pid * 16;
      const anchor = ctx.planeTrails.find((tr) => tr.id === anchorId);
      if (!anchor) {
        // Minimap-only squadron: the centre trail IS the whole track.
        ctx.planeTrails.push({ id: anchorId, samples: list });
        if (list.length > 0) {
          ctx.planeLaunchPoses.set(anchorId, { x: list[0].x, z: list[0].z });
        }
        continue;
      }
      // The 3D receive_updateSquadron stream can stop long before the sortie
      // does (the 14.5.0.0 Shokaku reference carries exactly two launch
      // samples for a ~140 s sortie; the real track only lives in the minimap
      // stream). Left unmerged, planeTrailExpiry killed the formation 5 s
      // after that last 3D sample and the aircraft vanished from EVERY view —
      // the reported "original camera shows no planes" defect. PAD the
      // index-0 trail at BOTH ends with the minimap samples outside the 3D
      // stream's own time span. The middle stays 3D-untouched (no
      // interleaving): the streams carry different reference points (lead
      // plane vs squadron centre), so mixing them would make the anchor jump
      // sideways between packets.
      const samples = anchor.samples;
      if (samples.length === 0) {
        anchor.samples = list;
        continue;
      }
      const before = list.filter((s) => s.time < samples[0].time);
      const after = list.filter((s) => s.time > samples[samples.length - 1].time);
      if (before.length > 0 || after.length > 0) {
        // Both slices are time-ordered, so the merged list stays ascending —
        // every samplesUpTo/sampleAt binary search relies on that.
        anchor.samples = [...before, ...samples, ...after];
      }
    }
  }
  // (planeId, index) → aircraft type (via the squadron create's
  // paramsId). Trails keyed by planeId*16+index, so every formation
  // member maps to its squadron's type. The minimap stream names the
  // same paramsId and covers squadrons the 3D stream missed.
  ctx.planeTypesById.clear();
  // The idx map must clear with the type map: trail ids are small ints
  // that collide across replays, so a previous replay's entries would
  // survive (and the conditional set below cannot overwrite them with a
  // paramsId whose PLANE_TYPES lookup misses) — the next squadron of the
  // same id would wear the dead replay's model.
  ctx.planeIndexById.clear();
  const typesOf = (paramsId: number, planeId: number) => {
    const info = PLANE_TYPES[String(paramsId)];
    const type = info?.type ?? "attack";
    const index = info?.index;
    for (let i = 0; i < 16; i++) {
      const key = planeId * 16 + i;
      // Last DEFINED writer wins, per map: both streams carry the same
      // paramsId per planeId in practice, but when one stream's lookup
      // misses PLANE_TYPES the old first-writer-wins guard let it poison
      // the slot forever — the other stream's good paramsId could never
      // repair the type or the model idx.
      ctx.planeTypesById.set(key, type);
      if (index) ctx.planeIndexById.set(key, index);
    }
  };
  for (const c of ctx.props.squadronCreates) typesOf(c.paramsId, c.planeId);
  for (const a of minimapAddFirst.values()) typesOf(a.paramsId, a.planeId);
  return minimapAddFirst;
}

/** Y coordinate a cloud slot is parked at while its squadron has nothing
 *  airborne — deep below the seabed, out of every legal camera angle (the
 *  orbit caps at ~85°, never below the horizon). Expired squadrons' dots
 *  used to freeze at their last centroid for the whole replay (the
 *  "inexplicable floating dots" report); see markerUpdate's park pass. */
export const PLANE_DOT_PARKED_Y = -100000;

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
    // Per-frame activity flags (markerUpdate): slots not written on a tick
    // are parked below the sea instead of lingering at their last position.
    ctx.planeCloudActive = new Uint8Array(slotCount);
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
    // Parked/teleporting slot positions invalidate the build-time bounding
    // sphere every frame — culling is skipped instead of recomputing it.
    points.frustumCulled = false;
    scene.add(points);
    ctx.planeCloud = points;
  }
}

/** Per-formation GLB model pools, launched async and epoch-guarded. */
export function buildPlaneFormations(ctx: MapInternals, scene: THREE.Scene, epoch: number) {
  // Real aircraft models: per FORMATION (one GLB clone per squadron slot —
  // the squadron's DECODED launch size, e.g. 8), arranged in a wedge each
  // frame. Trails whose model fails/misses keep the Points fallback.
  ctx.planeMeshes.clear();
  ctx.planeFormations.clear();
  {
    // Decoded launch size per planeId (E27): SquadronCreate.numPlanes is the
    // planes actually LAUNCHED. The GameParams `count` this used to fall back
    // to is the ATTACK-GROUP size (423/936 plane_types entries are 1), never
    // the flying squadron strength — sizing pools from it rendered ONE model
    // where a dozen planes flew. Max over the planeId's creates (re-launches
    // may differ); the GameParams entry stays the last-resort fallback for
    // squadrons the decoded stream never saw.
    const launchOf = new Map<number, number>();
    const paramsOf = new Map<number, number>();
    for (const c of ctx.props.squadronCreates) {
      const n = c.numPlanes ?? c.totalNumPlanes ?? 0;
      const prev = launchOf.get(c.planeId) ?? 0;
      if (n > prev) launchOf.set(c.planeId, n);
      if (!paramsOf.has(c.planeId)) paramsOf.set(c.planeId, c.paramsId);
    }
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
      const typeKey = PLANE_TYPES[String(paramsOf.get(planeId))];
      const count = Math.max(1, launchOf.get(planeId) ?? typeKey?.count ?? 3);
      if (list.length === 0) {
        ctx.planeFormations.set(planeId, { count, groupSize: 1, groupCount: count, meshes: [] });
      }
      list.push({ idx, role, count, trail });
    }
    for (const [planeId, entries] of byPlane) {
      // Infer the group layout from the launch positions (clusters of
      // planes spawned together = one flight group). The launch poses are
      // captured BEFORE the minimap merge pads the anchor trail — sampling
      // the merged trail at a padded centre-squadron sample would flip the
      // grouping on real replays (see MapInternals.planeLaunchPoses).
      const grp = inferGrouping(entries, (trail) =>
        ctx.planeLaunchPoses.get(trail.id),
      );
      const formation = ctx.planeFormations.get(planeId)!;
      formation.groupSize = Math.max(1, Math.min(grp.groupSize, formation.count));
      formation.groupCount = Math.max(1, grp.groupCount);
      const first = entries[0];
      const url = resolvePlaneModelUrl(first.idx);
      if (!url) continue;
      // EVERY squadron clones its own pool — a CV match flies many sorties
      // of the SAME airframe on the SAME side, and the shared-build dedupe
      // that used to stand here left every later squadron of a seen
      // (idx, role) pair without a pool, i.e. as dots. propMarker's glbCache
      // already collapses the fetch + parse per URL; only the cheap clone
      // is per squadron.
      // The pack's aircraft art is authored both ways (see
      // planeForwardSign): a nose-−Z model gets a π yaw offset INSIDE the
      // marker wrapper, so every pool's nose is at local +Z — the frame
      // markerUpdate's π − yaw placement and the follow camera's yaw
      // derivation assume. The outer group stays free for that per-tick yaw.
      const forward = planeForwardSign(first.idx);
      const build = buildPropMarker({
        url,
        color: TEAM_COLOR[first.role as TeamRole] ?? 0x78d2ff,
        axis: "z",
        targetLen: 7,
        yawOffset: forward < 0 ? Math.PI : 0,
        // Opaque: the plane GLB is a closed solid; a translucent,
        // depth-write-off material painted its own faces through each other
        // (the "shattered triangles" the user reported on the aircraft).
        opacity: 1,
      }).catch(() => null);
      const formationForPool = ctx.planeFormations.get(planeId)!;
      build.then((proto) => {
        if (epoch !== ctx.markerEpoch || !ctx.api.value?.scene || !proto) return;
        if (ctx.planeMeshes.has(planeId)) return;
        // Tint at LOAD time, not at build time: the GLB resolves long
        // after resolvePlaneCarriers ran its re-tint pass, so the role
        // captured when this build STARTED (the empty-map default, i.e.
        // enemy red) painted the finished pool — the recorder's OWN
        // aircraft rendered red (user report; team rule: self white, ally
        // green, enemy red). Read the final role here instead, and give the
        // pool its OWN material copies: propMarker's cache shares one proto
        // per URL, so tinting its materials would recolor the squadrons on
        // the other side too.
        const role = (ctx.planeRoleById.get(planeId) ?? first.role) as TeamRole;
        const tint = new THREE.Color(TEAM_COLOR[role] ?? 0x78d2ff);
        const mats = new Map<THREE.Material, THREE.Material>();
        const pool: THREE.Object3D[] = [];
        for (let i = 0; i < formationForPool.count; i++) {
          const inst = proto.clone(true);
          inst.userData.sharedGeometry = true;
          inst.traverse((child) => {
            const mesh = child as THREE.Mesh;
            const raw = mesh.material as
              | THREE.Material
              | THREE.Material[]
              | undefined;
            if (!raw) return;
            const retint = (m: THREE.Material) => {
              let copy = mats.get(m);
              if (!copy) {
                copy = m.clone();
                const colored = copy as THREE.MeshBasicMaterial;
                if (colored.color) colored.color.copy(tint);
                mats.set(m, copy);
              }
              return copy;
            };
            mesh.material = Array.isArray(raw)
              ? raw.map(retint)
              : retint(raw);
          });
          // The per-frame heading is markerUpdate's (rotation.y = π − yaw,
          // nose at local +Z); the inner group's orientation was normalised
          // above. Don't touch the outer group's rotation here — the
          // placement overwrites it every tick.
          inst.visible = false;
          scene.add(inst);
          pool.push(inst);
        }
        ctx.planeMeshes.set(planeId, pool);
      });
    }
    if (import.meta.env.VITE_WOWSP_DEBUG_PLANE_JOIN) {
      // Env-gated diagnostic (the webui twin of replay_core's WOWSP_TEST_*
      // gates): how many squadrons entered the pool build and how many
      // trail ids still lack a model idx. Run the dev server with
      // VITE_WOWSP_DEBUG_PLANE_JOIN=1 to trace a replay whose squadrons
      // stay in the Points cloud.
      const noIdx = ctx.planeTrails.filter((t) => !ctx.planeIndexById.get(t.id)).length;
      console.debug(
        `[planeWarfare] plane pools: ${byPlane.size} squadrons with a model idx, ${noIdx} trails without one, epoch ${epoch}`,
      );
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
  ctx.planeCarrierOf.clear();
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
      const tr = ctx.trajById.get(m.userData.entityId as number);
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
    // Persist the join for the follow camera / AI-report aircraft jump:
    // the local map dies with this build pass.
    ctx.planeCarrierOf.set(planeId, carrierId);
    const carrierMarker = carrierId == null
      ? null
      : ctx.shipMarkers.find((m) => m.userData.entityId === carrierId);
    // Carrier unresolved → enemy red (the air owner defaults hostile —
    // see teamColors.roleFromRelation for the relation split).
    ctx.planeRoleById.set(
      planeId,
      carrierMarker?.userData.role ?? "enemy",
    );
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
      entityId: PLANE_CARD_LABEL_ID_BASE + Number(carrierId),
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
      status: null,
      belowX: 0,
      belowY: 0,
      belowVisible: false,
    });
    ctx.planeLabelCarriers.set(PLANE_CARD_LABEL_ID_BASE + Number(carrierId), carrierId);
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
      ctx.planeLabelOfPlane.set(planeId, PLANE_CARD_LABEL_ID_BASE + Number(carrierId));
    }
  }
}
