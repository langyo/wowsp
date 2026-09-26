/**
 * Scene actor construction, extracted verbatim from HolographicMap.tsx:
 * rebuildActors builds every pool the map renders — smoke-screen clusters,
 * ship markers with hull outlines + async GLB models (incl. the substitute-
 * hull pool and waiter draining), the floating label set, the capture-zone
 * rings + letter sprites, the dev introspection hook and the opening camera
 * defaults. Shell/torpedo/ward/lock/plane construction live in
 * shellWarfare.ts / planeWarfare.ts; per-frame state in markerUpdate.ts.
 */
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import {
  resolveShipModelForEntry,
  resolveShipModelByShipId,
  shipNameFromModelDb,
  shipNameFromOfflineDb,
  shipOfflineEntry,
  type ShipModelSpec,
} from "./modelLoader";
import { buildShipMarker, buildMarkerFromSource, shipClassTargetLen } from "./shipMarker";
import { makeHullOutline } from "./hullOutline";
import { TEAM_COLOR, type TeamRole } from "./teamColors";
import { resolveMarkerContext, resolveRosterAssignments } from "./rosterRoles";
import { sampleAt } from "./trajectoryMath";
import {
  CAP_RING_PX, SMOKE_RING_PX, WARD_RING_PX,
  circlePositions, makeOverlayRing, paintCapSprite,
} from "./screenOverlays";
import { clearActors, fitCamera, resolveRoleQuick, type MapInternals } from "./mapInternals";
import { updateMarkersAt } from "./markerUpdate";
import { updateLabelPositions } from "./labelOverlay";
import { buildShellStates, buildShellTracePool, buildTorpedoTraces, swapTracePropModels } from "./shellWarfare";
import { buildPlaneTrails, buildPlaneCloud, buildPlaneFormations, resolvePlaneCarriers } from "./planeWarfare";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useLanguage } from "@/i18n/useLanguage";
import type { EntityTrajectory } from "@/api";
import type { ShipLabel } from "./shipLabel";
import { parsePostBattle } from "@/features/replay/postBattle";

/** Build the trajectory lines + ship markers from the decoded data.
 *
 *  Each ship gets a colored trajectory line (team-tinted) and a marker.
 *  The marker starts as a small cone (instant, correct color), then an
 *  async GLB load swaps in the actual ship model (or a tier/nation/type
 *  fallback) tinted to the team color. If the model fails to load, the
 *  cone stays.
 *
 *  Also populates `ctx.shipLabels` — per-ship display data for the floating
 *  HTML labels overlaid on the canvas. Labels track player name, ship
 *  name, tier, type icon, role colour, and death state. */
export function rebuildActors(ctx: MapInternals) {
  clearActors(ctx);
  ctx.followStats.value.clear();
  const scene = ctx.api.value?.scene;
  if (!scene || ctx.props.trajectories.length === 0) { ctx.shipLabels.value = []; return; }
  const epoch = ctx.markerEpoch;

  // Encyclopedia as the fallback pool for tier/nation/type resolution.
  const encSpecs: ShipModelSpec[] = [...ctx.props.encyclopedia.values()];

  // Ships = EntityCreate type 2 that moved at least once. No sample-count
  // threshold: planes/torpedoes/smokes arrive on OTHER entity types, so a
  // type-2 entity with 2+ position samples IS a vessel — ships that sank
  // or sailed unobserved early carry few samples and must stay counted.
  // Zero/one-sample type-2 entities are re-creation duplicates with no
  // usable trajectory; skipping them prevents double-counting players.
  const isShip = (t: EntityTrajectory) =>
    t.kind?.entityType === 2 && t.samples.length > 1;
  const shipTrajs = ctx.props.trajectories.filter(isShip);
  ctx.shipEntityIds = shipTrajs.map((t) => t.entityId).sort((a, b) => a - b);
  ctx.rosterAssignments = resolveRosterAssignments(shipTrajs, ctx.props.vehicles);
  const assignments = ctx.rosterAssignments;

  // Smoke screens (entityType 4 = SmokeScreen): white ring markers at
  // the smoke's START point (and END point when the drift exceeds 1 km)
  // with a floating remaining-seconds tag. No volumetric puffs — the
  // rings trace the smoke band. WoWS smoke lasts ~90s; without a destroy
  // packet each puff expires 90s after its last recorded position
  // update. While dissipating, the start ring walks from the launch
  // point toward the end point. Clusters of puffs at (almost) the same
  // spot collapse into one marker: the one with the longest lifetime.
  ctx.smokeClusters.length = 0;
  {
    const smokes = ctx.props.trajectories
      .filter((t) => t.kind?.entityType === 4 && t.samples.length >= 1)
      .sort((a, b) => (a.samples[0]?.time ?? 0) - (b.samples[0]?.time ?? 0));
    for (const tr of smokes) {
      const t0 = tr.samples[0].time;
      const lastT = tr.samples[tr.samples.length - 1].time;
      const endT = ctx.props.leavesMap[tr.entityId] ?? lastT + 90;
      const s0 = sampleAt(tr, t0);
      if (!s0) continue;
      let cluster = ctx.smokeClusters.find(
        (c) => Math.hypot(c.sx - s0.x, c.sz - s0.z) < 300,
      );
      if (!cluster) {
        cluster = {
          traj: tr,
          t0,
          lastT,
          endT,
          sx: s0.x,
          sz: s0.z,
          rings: [],
          timeSprite: null,
        };
        ctx.smokeClusters.push(cluster);
      } else if (endT > cluster.endT) {
        cluster.traj = tr;
        cluster.t0 = t0;
        cluster.lastT = lastT;
        cluster.endT = endT;
      }
    }
    // Screen-space ring (constant pixel width) shared by every cluster of
    // this build; the old world-space RingGeometry turned into a fat
    // donut when the camera dollied in. 43 = the old RingGeometry(40, 46)
    // centerline radius.
    const smokeRingGeom = new LineGeometry();
    smokeRingGeom.setPositions(circlePositions(43));
    const smokeRingMat = new LineMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      linewidth: SMOKE_RING_PX,
    });
    ctx.overlayLineMats.push(smokeRingMat);
    for (const cl of ctx.smokeClusters) {
      for (let i = 0; i < 2; i++) {
        const ring = new Line2(smokeRingGeom, smokeRingMat);
        ring.visible = false;
        scene.add(ring);
        cl.rings.push(ring);
      }
      // 4x supersampled relative to its constant on-screen height so the
      // countdown stays crisp at any zoom.
      const cvs = document.createElement("canvas");
      cvs.width = 256;
      cvs.height = 128;
      const tex = new THREE.CanvasTexture(cvs);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          depthWrite: false,
        }),
      );
      sprite.visible = false;
      sprite.userData.canvas = cvs;
      sprite.userData.text = "";
      scene.add(sprite);
      cl.timeSprite = sprite;
    }
  }

  const killFor = buildShellStates(ctx);
  buildShellTracePool(ctx, scene);
  buildTorpedoTraces(ctx, scene, killFor);
  swapTracePropModels(ctx, scene, epoch);

  // Fighter-patrol wards (receive_wardAdded): flat rings at the patrol
  // centre. World metres map straight onto scene units — position (x, h,
  // -z), radius as-is; a zero radius falls back to the reference's 60 m
  // default. Colour follows the owning carrier's role, like squadron
  // markers.
  if (ctx.props.wards.length > 0) {
    for (const w of ctx.props.wards) {
      const owner = ctx.props.trajectories.find((tr) => tr.entityId === w.ownerId);
      const role = owner ? resolveRoleQuick(ctx, owner) : "enemy";
      const color = TEAM_COLOR[role as TeamRole] ?? 0x78d2ff;
      const radius = Math.max(60, w.radius || 0);
      // Screen-space ring outline (constant pixel width) + translucent
      // world-space area fill.
      const ring = makeOverlayRing(radius, WARD_RING_PX, 0.8);
      (ring.material as LineMaterial).color.set(color);
      const fill = new THREE.Mesh(
        new THREE.CircleGeometry(radius, 64),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.08,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      // Patrol altitude: the ward centre's own height (never below the
      // water so the ring stays visible against the sea plane).
      const h = Math.max(6, w.y ?? 0);
      // The Line2 circle is already built in the XZ plane (no rotation);
      // the fill disc lies in XY and needs the flat spin.
      fill.rotation.x = -Math.PI / 2;
      for (const m of [ring, fill]) {
        m.position.set(w.x, h, -w.z);
        m.visible = false;
        scene.add(m);
      }
      ctx.overlayLineMats.push(ring.material as LineMaterial);
      // Alive from the add until the first remove for this patrol after
      // it (wards can be re-deployed under the same id).
      let end: number | null = null;
      for (const r of ctx.props.wardRemoves) {
        // Strictly after the add: a remove in the same tick as a re-add
        // belongs to the PREVIOUS deployment of this id.
        if (r.planeId === w.squadronId && r.time > w.time && (end == null || r.time < end)) {
          end = r.time;
        }
      }
      ctx.wardRings.push({ ring, fill, t0: w.time, t1: end });
    }
  }

  // Recorder aim line: thin line from the own ship to the locked target
  // entity (SetWeaponLock 0x30 timeline), updated per frame. Same render
  // path as shell traces (line + bounding sphere) which is known-good.
  if (ctx.props.weaponLocks.length > 0) {
    const lockGeom = new THREE.BufferGeometry();
    lockGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(6), 3),
    );
    lockGeom.computeBoundingSphere();
    const lockMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });
    const line = new THREE.Line(lockGeom, lockMat);
    line.visible = false;
    scene.add(line);
    ctx.lockLine = line as unknown as THREE.Mesh;
  }

  const minimapAddFirst = buildPlaneTrails(ctx);
  buildPlaneCloud(ctx, scene);
  buildPlaneFormations(ctx, scene, epoch);

  const newLabels: ShipLabel[] = [];

  for (const traj of ctx.props.trajectories) {
    if (traj.samples.length < 2) continue;
    // Only render ships (EntityCreate type 2 with many samples); skip
    // zones/avatars/planes/torpedoes.
    if (!isShip(traj)) continue;

    const { role, shipInfo, entry: rosterEntry } = resolveMarkerContext(
      traj,
      ctx.shipEntityIds,
      assignments,
      ctx.props.encyclopedia,
    );
    const color = TEAM_COLOR[role];
    const offline = shipOfflineEntry((rosterEntry?.shipId ?? traj.kind?.shipId) ?? undefined);
    const shipType = shipInfo?.type ?? offline?.type ?? null;

    // Marker: class-scaled HULL OUTLINE (vector line loop — reads at any
    // zoom and never depends on GLB availability) plus a small cone+dot
    // so the heading stays visible before/outside the outline. Cone
    // points +Z (forward) at yaw 0. Placeholder sizes track the class's
    // true hull length so small classes (DD/SS) don't carry a BB-sized
    // cone while their model loads.
    const marker = new THREE.Group();
    const hull = makeHullOutline(color, shipType);
    hull.userData.hullOutline = true;
    marker.add(hull);
    marker.userData.hull = hull;
    const clsLen = shipClassTargetLen(shipType);
    const coneGeom = new THREE.ConeGeometry(clsLen * 0.14, clsLen * 0.36, 6);
    const coneMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 });
    const cone = new THREE.Mesh(coneGeom, coneMat);
    cone.rotation.x = Math.PI / 2; // cone tip along +Z
    cone.position.z = clsLen * 0.12; // shift forward so sphere is behind the tip
    marker.add(cone);
    const dotGeom = new THREE.SphereGeometry(clsLen * 0.16, 10, 6);
    const dotMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 });
    const dot = new THREE.Mesh(dotGeom, dotMat);
    dot.position.z = 0;
    marker.add(dot);
    marker.userData.entityId = traj.entityId;
    marker.userData.role = role;
    marker.userData.type = shipType;
    marker.userData.modelLoaded = false;
    marker.userData.isDot = true;
    marker.userData.deathTime = traj.deathTime ?? null;
    marker.userData.spawnX = traj.kind?.initialX ?? 0;
    marker.userData.spawnZ = traj.kind?.initialZ ?? 0;
    marker.userData.firstT = traj.samples[0]?.time ?? Infinity;
    // Ghost: the same class-scaled hull outline marking an unobserved /
    // sunk ship's last-known position — GREEN for allies, red for
    // enemies (the game's "not spotted" marker; white stays reserved
    // for the recorder's own hull). Enemy ships that were never seen
    // stay invisible.
    {
      const ghostCol = role === "enemy" ? 0xcc3333 : TEAM_COLOR.ally;
      const ghost = makeHullOutline(ghostCol, shipType, 0.85);
      ghost.position.set(traj.kind?.initialX ?? 0, 0, -(traj.kind?.initialZ ?? 0));
      ghost.rotation.y = Math.PI - (traj.samples[0]?.yaw ?? 0);
      ghost.visible = false;
      scene.add(ghost);
      marker.userData.ghost = ghost;
    }
    marker.visible = false;
    scene.add(marker);
    ctx.shipMarkers.push(marker);

    const modelUrl =
      resolveShipModelForEntry(shipInfo, encSpecs) ??
      (rosterEntry?.shipId != null
        ? resolveShipModelByShipId(rosterEntry.shipId)
        : null);
    // The marker's cone stays as-is until a model arrives; ships whose
    // own GLB is missing/unloadable still get a hull — a same-role model
    // already loaded for another ship, cloned and re-tinted — instead of
    // a bare cone.
    const installModel = (target: THREE.Group, model: THREE.Group) => {
      for (const child of [...target.children]) {
        // The hull outline survives the model swap — it is the tactical
        // marker, not placeholder art.
        if ((child.userData?.hullOutline as boolean) === true) continue;
        target.remove(child);
        child.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        });
      }
      target.add(model);
      target.userData.modelLoaded = true;
      target.userData.isDot = false;
      // Re-run the per-frame visibility rules (opening-phase enemy
      // hiding, creation time) instead of forcing the marker on.
      updateMarkersAt(ctx, ctx.current.value);
      initMarkerPosition(target, traj, ctx.current.value);
      updateLabelPositions(ctx);
    };
    const buildFromLoadedPool = () => {
      // Prefer a model from the same side (self/ally vs enemy).
      const sub =
        ctx.loadedModelPool.find((p) => p.role === role) ??
        ctx.loadedModelPool[0];
      if (!sub) return false;
      try {
        const replacement = buildMarkerFromSource(sub.model, role, shipType);
        ctx.loadedModelPool.push({ model: replacement, role });
        installModel(marker, replacement);
        return true;
      } catch (e) {
        console.warn(`[HolographicMap] substitute model for entity ${traj.entityId} failed:`, e);
        return false;
      }
    };
    const drainModelWaiters = () => {
      for (let i = ctx.modelWaiters.length - 1; i >= 0; i--) {
        const w = ctx.modelWaiters[i];
        if (w.marker.userData.modelLoaded) {
          ctx.modelWaiters.splice(i, 1);
          continue;
        }
        const sub =
          ctx.loadedModelPool.find((p) => p.role === w.marker.userData.role) ??
          ctx.loadedModelPool[0];
        if (!sub) continue;
        try {
          const replacement = buildMarkerFromSource(
            sub.model,
            w.marker.userData.role as TeamRole,
            w.marker.userData.type as string | null,
          );
          ctx.loadedModelPool.push({ model: replacement, role: w.marker.userData.role });
          installModel(w.marker, replacement);
          ctx.modelWaiters.splice(i, 1);
        } catch (e) {
          console.warn(`[HolographicMap] substitute model for entity ${w.traj.entityId} failed:`, e);
        }
      }
    };
    if (!modelUrl) {
      console.warn(`[HolographicMap] no model URL for entity ${traj.entityId}`
        + ` (ship: ${shipInfo?.name ?? "?"}, shipId: ${rosterEntry?.shipId}, encyclopedia: ${encSpecs.length} entries)`);
      if (!buildFromLoadedPool()) ctx.modelWaiters.push({ marker, traj });
    } else {
      buildShipMarker({ url: modelUrl, role, type: shipType })
        .then((shipModel) => {
          if (epoch !== ctx.markerEpoch || !ctx.api.value?.scene) return;
          ctx.loadedModelPool.push({ model: shipModel, role });
          installModel(marker, shipModel);
          // Fill every marker still waiting on a hull from the model
          // pool (same-role first), newest models included.
          drainModelWaiters();
        })
        .catch((e) => {
          console.warn(`[HolographicMap] failed to load marker model for entity ${traj.entityId}:`, e);
          if (epoch !== ctx.markerEpoch) return;
          if (!buildFromLoadedPool()) ctx.modelWaiters.push({ marker, traj });
        });
    }

    const name = rosterEntry?.name ?? `#${traj.entityId}`;
    const encStore = useEncyclopediaStore();
    const dataLang = useLanguage().dataLanguage.value;
    // Name/tier/type: the WG encyclopedia when it knows the ship, else the
    // complete offline DB (GameParams + game gettext catalogs — covers
    // event/clone ships), else the baked model DB's English base name.
    const shipName =
      (shipInfo ? encStore.shipDisplayName(shipInfo) : null) ??
      shipNameFromOfflineDb((rosterEntry?.shipId ?? traj.kind?.shipId) ?? undefined, dataLang) ??
      rosterEntry?.shipName ??
      shipInfo?.name ??
      shipNameFromModelDb((rosterEntry?.shipId ?? traj.kind?.shipId) ?? undefined) ??
      "?";
    // Max HP: the peak of the entity's own HP stream — authoritative for
    // the battle's actual scaling (event/asymmetric modes cut bot HP to a
    // fraction of the encyclopedia hull value; upgraded hulls raise it).
    // Ships without any HP stream fall back to the encyclopedia hull value
    // so their label still shows a (static) health line.
    const streamMax =
      traj.hpSamples && traj.hpSamples.length > 0
        ? Math.max(...traj.hpSamples.map((s) => s.value))
        : null;
    const dp = shipInfo?.defaultProfile as
      | Record<string, Record<string, unknown>>
      | undefined;
    const encHealth =
      dp?.hull?.health != null && typeof dp.hull.health === "number"
        ? dp.hull.health
        : null;
    // Fallback chain: battle stream (authoritative) → encyclopedia hull →
    // offline DB hull HP (GameParams) → none (label hides the HP row).
    const maxHp = streamMax ?? encHealth ?? offline?.hp ?? null;
    newLabels.push({
      entityId: traj.entityId,
      role,
      name,
      shipName,
      shipId: (rosterEntry?.shipId ?? traj.kind?.shipId) ?? undefined,
      tier: shipInfo?.tier ?? offline?.tier ?? null,
      type: shipInfo?.type ?? offline?.type ?? null,
      hp: maxHp,
      maxHp,
      ghostText: null,
      x: 0, y: 0,
      visible: false,
      dead: false,
    });
  }
  resolvePlaneCarriers(ctx, newLabels, minimapAddFirst);
  ctx.shipLabels.value = newLabels;

  // Dev-only scene introspection hook (vite debug page: window.__holoDebug).
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__holoDebug = {
      get scene() {
        return ctx.api.value?.scene ?? null;
      },
      get t() {
        return ctx.current.value;
      },
      get shellStates() {
        return ctx.shellStates;
      },
      get shellTraceSlots() {
        return ctx.shellTraceSlots;
      },
      get planeTrails() {
        return ctx.planeTrails;
      },
      get planeMeshes() {
        return ctx.planeMeshes;
      },
      get wardRings() {
        return ctx.wardRings;
      },
      get bounds() {
        return ctx.bounds;
      },
      get torpedoMeshes() {
        return ctx.torpedoMeshes;
      },
    };
  }

  // Opening view: aim the camera at the allied fleet and skip any
  // pre-battle countdown (ships frozen before the first movement).
  openSceneDefaults(ctx);

  // Capture zones: entityType 14 circles on the XZ plane.
  // Capture zones are static and may have no position samples; use the
  // initial position from EntityCreate metadata. Points that share the
  // same center (concentric inner/outer-ring layouts, e.g. two cap zones
  // on one spot) are merged visually: their rings are pushed side by side
  // with tiered radii so both letters stay readable instead of stacking
  // on top of each other. The number of points is data-driven (PvE
  // scenarios create new points mid-battle).
  // Only real domination points (those with an ownership/progress stream)
  // get 3D rings + letters — non-capture InteractiveZones are filtered by
  // ctx.capZones. The number of points is data-driven (PvE scenarios create
  // new points mid-battle).
  const capEntries = ctx.capZones.value.map((t, idx) => ({
    x: t.kind!.initialX,
    z: t.kind!.initialZ,
    // Domination rings are ~100-120 m on ctx.current clients; fall back to
    // a same-order default when the create state yields no candidate.
    radius: t.kind!.radius ?? 150,
    order: idx,
  }));
  if (capEntries.length === 0) {
    console.warn("[HolographicMap] no capture zone data found in trajectory kinds");
  }
  // Group by shared center (within 30 m).
  const groups: { x: number; z: number; members: { x: number; z: number; radius: number; order: number }[] }[] = [];
  for (const e of capEntries) {
    const g = groups.find(
      (gr) => Math.abs(gr.x - e.x) < 30 && Math.abs(gr.z - e.z) < 30,
    );
    if (g) g.members.push(e);
    else groups.push({ x: e.x, z: e.z, members: [e] });
  }
  groups.sort((a, b) => a.members[0].order - b.members[0].order);
  let letterIdx = 0;
  for (const g of groups) {
    const n = g.members.length;
    for (let k = 0; k < n; k++) {
      // Concentric group: offset each member along x, outer ring larger.
      // Use the REAL radius (create-state InteractiveZone.radius, 80..140 m
      // typical on ctx.current maps) — clamping to a big minimum made adjacent
      // points' rings overlap and diverged from the minimap proportions.
      const spread = n > 1 ? 55 * (k - (n - 1) / 2) : 0;
      const radius = Math.max(g.members[k].radius, 25);
      const cx = g.x + spread;
      const cz = g.z;
      const ring = makeOverlayRing(radius, CAP_RING_PX, 0.55);
      ring.position.set(cx, 0.6, -cz);
      scene.add(ring);
      ctx.trajectoryLines.push(ring as unknown as THREE.Line);
      ctx.capRings.push(ring);
      ctx.overlayLineMats.push(ring.material as LineMaterial);
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      paintCapSprite(canvas, String.fromCharCode(65 + letterIdx++), "");
      const tex = new THREE.CanvasTexture(canvas);
      const spriteMat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.position.set(cx, 30, -cz);
      // World scale is derived from the camera each frame
      // (updateOverlayScale) so the letter occupies a constant number of
      // screen pixels at any zoom.
      sprite.scale.set(1, 1, 1);
      scene.add(sprite);
      ctx.trajectoryLines.push(sprite as unknown as THREE.Line);
      ctx.capLetterSprites.push(sprite);
    }
  }
}

/** Set a freshly-loaded marker to the correct world position at the ctx.current
 *  playback time so it snaps to the right spot immediately. */
export function initMarkerPosition(
  marker: THREE.Group,
  traj: EntityTrajectory,
  t: number,
) {
  const s = sampleAt(traj, t);
  if (s) {
    marker.position.set(s.x, 0, -s.z);
    // WoWS yaw: 0=north(+worldZ), clockwise. three.js north is -z, so the
    // yaw maps to rotation.y = PI - yaw on the mirrored coordinate frame.
    marker.rotation.y = Math.PI - s.yaw;
    marker.userData.yaw = s.yaw;
  }
}

/** Point the opening camera at the allied fleet (not map centre) and pull
 *  back far enough that every friendly ship is in view. Runs once after
 *  the scene is built. */
export function fitCameraToAllies(ctx: MapInternals) {
  const ctrl = ctx.api.value?.controls;
  const cam = ctx.api.value?.camera;
  if (!ctrl || !cam || ctx.shipMarkers.length === 0) return;
  const set = ctx.shipMarkers.filter((m) => {
    const r = m.userData.role as TeamRole;
    return r === "self" || r === "ally";
  });
  const use = set.length > 0 ? set : ctx.shipMarkers;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const m of use) {
    const p = m.position;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const span = Math.max(maxX - minX, maxZ - minZ, 500);
  const dist = Math.min(4500, Math.max(900, span * 1.3));
  ctrl.target.set(cx, 0, cz);
  cam.position.set(cx, dist * 0.55, cz + dist);
  ctrl.update();
}

export function openSceneDefaults(ctx: MapInternals) {
  // Eager post-battle parse: opening cap colours need the recorder's team.
  if (ctx.props.battleResults) ctx.pbCache ??= parsePostBattle(ctx.props.battleResults);
  // Frame the ACTIVE battle area (mode-restricted maps like brawls/duels
  // play inside a small region of the full map) — the allies are inside
  // it, so this also satisfies the "open on our fleet" requirement.
  // Playback starts at the replay's raw time (no auto-skip).
  if (ctx.bounds) {
    fitCamera(ctx, ctx.bounds);
  } else {
    fitCameraToAllies(ctx);
  }
}
