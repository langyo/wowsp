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
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import {
  resolveShipModelCandidatesForEntry,
  shipModelUrlCandidates,
  shipNameFromModelDb,
  shipNameFromOfflineDb,
  shipOfflineEntry,
  type ShipModelSpec,
} from "./modelLoader";
import { buildShipMarker, buildMarkerFromSource, shipClassTargetLen } from "./shipMarker";
import { makeHullOutline } from "./hullOutline";
import { TEAM_COLOR, type TeamRole } from "./teamColors";
import {
  arenaIdentities,
  resolveMarkerContext,
  resolveRosterAssignments,
} from "./rosterRoles";
import { sampleAt } from "./trajectoryMath";
import { capLetter } from "./capZones";
import {
  CAP_RING_PX, WARD_RING_PX,
  makeOverlayRing, OVERLAY_RING_ORDER, paintCapSprite,
} from "./screenOverlays";
import { clearActors, fitCamera, resolveRoleQuick, type MapInternals } from "./mapInternals";
import { updateMarkersAt } from "./markerUpdate";
import { updateLabelPositions } from "./labelOverlay";
import { buildShellStates, buildShellTracePool, buildTorpedoTraces, swapTracePropModels } from "./shellWarfare";
import { buildPlaneTrails, buildPlaneCloud, buildPlaneFormations, resolvePlaneCarriers } from "./planeWarfare";
import { buildShipStatusIndex } from "./shipStatusModel";
import { peakHpOf, resolveMaxHp, encyclopediaHullHealth } from "./shipHp";
import { ammoOfColor } from "./tactical/shellTypes";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useLanguage } from "@/i18n/useLanguage";
import { isScriptedUnitName } from "@/utils/aiNames";
import { asIndexable } from "@/utils/typing";
import type { EntityTrajectory } from "@/api";
import type { ShipLabel } from "./shipLabel";
import { parsePostBattle } from "@/features/replay/postBattle";

/** WoWS smoke lifetime per puff (s) — each SmokeScreen update point
 *  fades out 90 s after it was laid, capped by the entity's leave. */
const SMOKE_PUFF_LIFE_S = 90;
/** Per-entity puff cap after stride thinning — bounds the shared disc
 *  pool against dense recorder streams (first + last always kept). */
const SMOKE_PUFFS_PER_ENTITY = 32;
/** InstancedMesh capacity of the shared smoke-disc pool. 64 clusters ×
 *  32 puffs fits comfortably; overflows are dropped per tick (the band
 *  thins instead of failing). */
const SMOKE_DISC_CAP = 2048;

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
  // entityId → trajectory join table for the hot per-frame lookups
  // (marker refresh, cap simulator, plane carrier resolution). First
  // entry wins, matching the linear `trajectories.find` this replaces —
  // malformed dumps with duplicate entity ids keep resolving to the same
  // trajectory they always did.
  ctx.trajById.clear();
  for (const tr of ctx.props.trajectories) {
    if (!ctx.trajById.has(tr.entityId)) ctx.trajById.set(tr.entityId, tr);
  }
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
  ctx.arenaIdentities = arenaIdentities(ctx.props.arenaPlayers);
  ctx.arenaSelfTeam =
    [...(ctx.arenaIdentities?.values() ?? [])].find((i) => i.isSelf)?.team ?? 0;
  ctx.rosterAssignments = resolveRosterAssignments(
    shipTrajs,
    ctx.props.vehicles,
    ctx.props.operation,
    ctx.arenaIdentities,
  );
  const assignments = ctx.rosterAssignments;

  // Smoke screens (entityType 4 = SmokeScreen): each entity update the
  // recorder observed drops one PUFF at the laying ship's position, and
  // the puffs together form the smoke band — rendered as translucent
  // discs from one shared instanced pool (the old 1-2 ring markers could
  // not read as smoke). WoWS smoke lasts ~90 s per puff; without a
  // destroy packet that is the whole life, with one it caps every puff.
  // Clusters of puffs at (almost) the same spot collapse into one
  // cluster: its countdown sprite follows the longest lifetime.
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
      // Puff points from this entity's update track, thinned to a bounded
      // stride so a dense recorder stream cannot balloon the disc pool
      // (first + last kept — the band's head and tail anchor the shape).
      const leave = ctx.props.leavesMap[tr.entityId];
      let puffs = tr.samples.map((s) => ({
        x: s.x,
        z: s.z,
        t0: s.time,
        endT: Math.min(s.time + SMOKE_PUFF_LIFE_S, leave ?? s.time + SMOKE_PUFF_LIFE_S),
      }));
      if (puffs.length > SMOKE_PUFFS_PER_ENTITY) {
        const stride = (puffs.length - 1) / (SMOKE_PUFFS_PER_ENTITY - 1);
        const thinned: typeof puffs = [];
        for (let i = 0; i < SMOKE_PUFFS_PER_ENTITY; i++) {
          thinned.push(puffs[Math.round(i * stride)]);
        }
        puffs = thinned;
      }
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
          puffs,
          timeSprite: null,
        };
        ctx.smokeClusters.push(cluster);
      } else {
        cluster.puffs.push(...puffs);
        if (endT > cluster.endT) {
          cluster.traj = tr;
          cluster.t0 = t0;
          cluster.lastT = lastT;
          cluster.endT = endT;
        }
      }
    }
    // Shared translucent-disc pool: one InstancedMesh rewritten per tick
    // (markerUpdate) instead of a ring mesh per cluster. Screen-space
    // size is gone on purpose — the band is world-scaled (45 m puffs), so
    // dollying in now reads as smoke rather than a fat donut. The discs
    // ride above the weather mask like the other gameplay overlays
    // (see weatherScene.STORM_ORDER).
    const discGeom = new THREE.CircleGeometry(1, 20);
    discGeom.rotateX(-Math.PI / 2);
    const discMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const discs = new THREE.InstancedMesh(discGeom, discMat, SMOKE_DISC_CAP);
    discs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    discs.count = 0;
    discs.frustumCulled = false;
    discs.renderOrder = OVERLAY_RING_ORDER;
    discs.raycast = () => {}; // never intercept picks
    scene.add(discs);
    ctx.smokeDiscs = discs;
    for (const cl of ctx.smokeClusters) {
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
      // Countdown letters ride above the weather mask (see weatherScene).
      sprite.renderOrder = OVERLAY_RING_ORDER;
      scene.add(sprite);
      cl.timeSprite = sprite;
    }
  }

  const killFor = buildShellStates(ctx);
  buildShellTracePool(ctx, scene);
  buildTorpedoTraces(ctx, scene, killFor);
  swapTracePropModels(ctx, scene, epoch);

  // Below-hull combat status rows: per-ship action/hit/dot index derived
  // from the same decoded signals the traces above already resolved
  // (joined shell impacts, torpedo detonations, smoke clusters, HP
  // timelines). Queried per playhead tick by updateMarkersAt. Ship classes
  // ride along so fire/flood countdowns start from the class-true base
  // durations (fire 60/30 s, flood 40/30 s) instead of the observed burn.
  const shipTypes = new Map<number, string | null>();
  for (const tr of ctx.props.trajectories) {
    if (!isShip(tr)) continue;
    const { shipInfo, entry } = resolveMarkerContext(
      tr,
      ctx.shipEntityIds,
      assignments,
      ctx.props.encyclopedia,
      ctx.arenaIdentities,
    );
    const offline = shipOfflineEntry((entry?.shipId ?? tr.kind?.shipId) ?? undefined);
    shipTypes.set(tr.entityId, shipInfo?.type ?? offline?.type ?? null);
  }
  ctx.shipStatus = buildShipStatusIndex({
    trajectories: ctx.props.trajectories,
    shellLaunches: ctx.props.shellLaunches,
    torpedoes: ctx.props.torpedoes,
    // DoT-tick classification thresholds key on the ship's true total HP:
    // the arena build health first, the stream peak only when the arena
    // state is missing (a late-spotted ship's peak makes every tick read
    // "big" and hides its fires/floods).
    maxHpByEntity: (() => {
      const m = new Map<number, number>();
      for (const tr of ctx.props.trajectories) {
        if (tr.kind?.entityType !== 2) continue;
        const v =
          ctx.arenaIdentities?.get(tr.entityId)?.maxHealth ??
          peakHpOf(tr.hpSamples) ??
          undefined;
        if (v != null && v > 0) m.set(tr.entityId, v);
      }
      return m;
    })(),
    shellImpacts: ctx.shellStates
      .filter((st) => st.joined)
      .map((st) => ({
        t: st.t1,
        x: st.to.x,
        z: -st.to.z,
        ownerId: st.ownerId,
        ammo: ammoOfColor(st.color),
      })),
    torpImpacts: ctx.torpedoMeshes
      .filter((tm) => tm.killX != null && tm.killZ != null)
      .filter((tm) => {
        // Shot ids recycle across the shared shotKills stream and the
        // torpedo join scans a 240 s window, so a same-owner shell impact
        // can masquerade as the fish's detonation. Reject kills outside
        // the straight-run envelope (homing bends get a generous slack).
        const launchX = tm.launchBase.x;
        const launchZ = -tm.launchBase.z; // scene z is mirrored
        const dx = (tm.killX as number) - launchX;
        const dz = (tm.killZ as number) - launchZ;
        const reach = 7 * (tm.endT - tm.t0) * 2.5 + 300;
        return Math.hypot(dx, dz) <= reach;
      })
      .map((tm) => ({ t: tm.endT, x: tm.killX as number, z: tm.killZ as number, ownerId: tm.ownerId })),
    smokes: ctx.smokeClusters.map((cl) => ({ t0: cl.t0, endT: cl.endT, x: cl.sx, z: cl.sz })),
    shipTypes,
  });

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
      // Both the outline and its fill ride above the weather mask, so a
      // ward reads as one unit inside the storm (see weatherScene).
      fill.renderOrder = OVERLAY_RING_ORDER;
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
    ctx.lockLine = line;
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
      ctx.arenaIdentities,
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
    // stay invisible; in operations (行动) a spotted-then-dark enemy
    // reuses it at its last-known pose (see markerUpdate's ghost policy).
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

    // Ordered candidate chain: the entry's own model (ship chain + tier/
    // nation/type substitute + encyclopedia last resort), then the roster
    // shipId's own chain — the encyclopedia may not know roster-only ships
    // at all. Deduped, order preserved; loadGlbModel walks it and only a
    // total failure drops through to the same-role clone pool below.
    const modelUrl = [
      ...resolveShipModelCandidatesForEntry(shipInfo, encSpecs),
      ...(rosterEntry?.shipId != null ? shipModelUrlCandidates(rosterEntry.shipId) : []),
    ].filter((u, i, all) => all.indexOf(u) === i);
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
    if (modelUrl.length === 0) {
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
    // The map still RENDERS scripted scenario NPCs (their ships really sail
    // — story-mode flagships, escort waves), but their roster "nickname" is
    // the raw `IDS_*` text key the client would localize: the floating
    // label and the follow menu read the ship name instead.
    const scriptedRoster = rosterEntry != null && isScriptedUnitName(rosterEntry.name);
    const name =
      (!scriptedRoster ? rosterEntry?.name : null) ??
      (shipName !== "?" ? shipName : null) ??
      `#${traj.entityId}`;
    // Max HP: the arena's starting health of this exact build — the
    // authoritative source (upgrades and event/asymmetric mode scaling are
    // already baked in, and it is always a clean integer). The HP stream's
    // peak is only the fallback for replays whose arena state did not
    // decode (it under-reports enemies first spotted after taking damage);
    // encyclopedia / offline hull values stand in when neither knows the
    // ship so the label still shows a (static) health line.
    const arenaMax = ctx.arenaIdentities?.get(traj.entityId)?.maxHealth ?? null;
    const maxHp = resolveMaxHp(
      arenaMax,
      traj.hpSamples,
      encyclopediaHullHealth(shipInfo),
      offline?.hp ?? null,
    );
    newLabels.push({
      entityId: traj.entityId,
      role,
      name,
      scripted: scriptedRoster || undefined,
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
      status: null,
      belowX: 0,
      belowY: 0,
      belowVisible: false,
    });
  }
  resolvePlaneCarriers(ctx, newLabels, minimapAddFirst);
  ctx.shipLabels.value = newLabels;

  // Dev-only scene introspection hook (vite debug page: window.__holoDebug).
  if (import.meta.env.DEV) {
    asIndexable(window).__holoDebug = {
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
    traj: t,
  }));
  if (capEntries.length === 0) {
    console.warn("[HolographicMap] no capture zone data found in trajectory kinds");
  }
  // Group by shared center (within 30 m).
  const groups: {
    x: number;
    z: number;
    members: { x: number; z: number; radius: number; order: number; traj: EntityTrajectory }[];
  }[] = [];
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
      ctx.trajectoryLines.push(ring);
      ctx.capRings.push(ring);
      ctx.overlayLineMats.push(ring.material as LineMaterial);
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      paintCapSprite(canvas, capLetter(g.members[k].traj, letterIdx++), "");
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
      // Zone letters ride above the weather mask (see weatherScene).
      sprite.renderOrder = OVERLAY_RING_ORDER;
      scene.add(sprite);
      ctx.trajectoryLines.push(sprite);
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
