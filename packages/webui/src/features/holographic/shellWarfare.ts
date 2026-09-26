/**
 * Shell + torpedo warfare construction, extracted verbatim from the heart
 * of HolographicMap.tsx's rebuildActors: the ballistic shell-state table
 * (artillery-shot stream with the explosion-proximity fallback, shot-kill
 * joining and unjoined-splash snapping), the fixed GPU trace-slot pool, the
 * straight-running torpedo meshes with their homing-guidance tables, and
 * the GLB prop swaps that replace the primitive placeholders.
 */
import * as THREE from "three";
import { shellAmmoOf } from "./tactical/shellTypes";
import { buildPropMarker } from "./propMarker";
import { resolvePropModelUrl } from "./modelLoader";
import { sampleAt } from "./trajectoryMath";
import { resolveRoleQuick, type MapInternals } from "./mapInternals";
import type { EntityTrajectory, ExplosionEvent, ShotKillEvent, TorpedoSteer } from "@/api";

/** Shot-kill lookup for one (owner, shot) pair within a flight window —
 *  see buildShellStates for the matching rules. */
export type KillFor = (
  ownerId: number,
  shotId: number,
  t0: number,
  t1: number,
) => ShotKillEvent | null;

/** Build the shell flight states (see ShellTraceState in mapInternals.ts).
 *  Returns the shot-kill lookup built from the same receiveShotKills stream
 *  — the torpedo builder joins its fish with the very same table. */
export function buildShellStates(ctx: MapInternals): KillFor {
  // Shell flight states: ballistic arcs from launch to impact. Primary
  // source: the avatar's receiveArtilleryShots stream (per-shell muzzle
  // point, server aim point and flight time — no guessing). Fallback for
  // streams without it (pre-table replays): reconstruct flights from the
  // receiveExplosions impact points by proximity-matching a firing ship.
  const shellAmmoColor = (paramsId?: number) => shellAmmoOf(paramsId).color;
  if (ctx.props.shellLaunches.length > 0) {
    for (const sh of ctx.props.shellLaunches) {
      const dist = Math.hypot(sh.targetX - sh.x, sh.targetZ - sh.z);
      ctx.shellStates.push({
        t0: sh.time,
        // Flight time from the server's own clock (raw units — battle
        // seconds = value / 2.75, the minimap_renderer calibration).
        t1: sh.time + sh.serverTimeLeft / 2.75,
        // Ballistic height: steep enough to read as a shell arc, growing
        // with range (a flat 10-unit curve looks like a laser beam).
        h: Math.min(420, 60 + dist * 0.16),
        from: new THREE.Vector3(sh.x, 0, -sh.z),
        to: new THREE.Vector3(sh.targetX, 0, -sh.targetZ),
        color: shellAmmoColor(sh.paramsId),
        ownerId: sh.ownerId,
        shotId: sh.shotId,
        joined: false, // set by the kill-join pass below
      });
    }
  } else {
    // Fallback — for every explosion find the nearest ship that was
    // alive, within 15 km, and pointed within ~25° of the impact at the
    // estimated launch time; draw a ballistic arc from its position to
    // the impact point (launch time estimated with ~800 m/s muzzle
    // velocity).
    const shipForImpact = (e: ExplosionEvent) => {
      let best: { tr: EntityTrajectory; score: number; t0: number; h: number } | null = null;
      for (const tr of ctx.props.trajectories) {
        if (tr.kind?.entityType !== 2 || tr.samples.length < 2) continue;
        const s = sampleAt(tr, e.time);
        if (!s) continue;
        const dist = Math.hypot(s.x - e.x, s.z - e.z);
        // A main-battery round can't come from 300 m away — requiring a
        // minimum range rejects near-impact ships that merely sail past
        // the splash (those read as short, flat, "not a shell" streaks).
        if (dist < 300 || dist > 15000) continue;
        const flightT = Math.min(8, Math.max(0.8, dist / 800));
        const t0 = e.time - flightT;
        const s0 = sampleAt(tr, t0);
        if (!s0) continue;
        const dx = e.x - s0.x;
        const dz = e.z - s0.z;
        const aim = Math.atan2(dx, dz);
        let dYaw = Math.abs(aim - s0.yaw);
        if (dYaw > Math.PI) dYaw = 2 * Math.PI - dYaw;
        if (dYaw > 0.45) continue; // ~25°
        const score = dist + dYaw * 4000;
        if (!best || score < best.score) {
          best = { tr, score: score, t0, h: Math.min(420, 60 + dist * 0.16) };
        }
      }
      return best;
    };
    // The enemy ship nearest the impact point at impact time, INSIDE the
    // launch-direction cone — arcs end at the TARGET SHIP (not the bare
    // water splash) so they read as fire against the opposing fleet. The
    // cone keeps the endpoint on the shell's actual heading: a nearby
    // enemy that is off to the side must not bend the arc sideways.
    const targetShipAt = (e: ExplosionEvent, from: { x: number; z: number }) => {
      let best: { x: number; z: number } | null = null;
      let bestD = 500;
      const baseAim = Math.atan2(e.x - from.x, e.z - from.z);
      for (const tr of ctx.props.trajectories) {
        if (tr.kind?.entityType !== 2 || resolveRoleQuick(ctx, tr) !== "enemy") continue;
        const s = sampleAt(tr, e.time);
        if (!s) continue;
        const d = Math.hypot(s.x - e.x, s.z - e.z);
        if (d > bestD) continue;
        const aim = Math.atan2(s.x - from.x, s.z - from.z);
        let dAim = Math.abs(aim - baseAim);
        if (dAim > Math.PI) dAim = 2 * Math.PI - dAim;
        if (dAim > 0.35) continue; // ~20° cone around the launch heading
        bestD = d;
        best = { x: s.x, z: s.z };
      }
      return best;
    };
    for (const e of ctx.props.explosions) {
      const match = shipForImpact(e);
      if (!match) continue;
      const launch = sampleAt(match.tr, match.t0);
      const target = targetShipAt(e, {
        x: launch?.x ?? e.x,
        z: launch?.z ?? e.z,
      });
      ctx.shellStates.push({
        t0: match.t0,
        t1: e.time,
        h: match.h,
        // Launch point is fixed at the firing ship's position at t0 —
        // using a later position would drag the arc across the map.
        from: launch ? new THREE.Vector3(launch.x, 0, -launch.z) : null,
        to: new THREE.Vector3(target?.x ?? e.x, 0, -(target?.z ?? e.z)),
        color: shellAmmoColor(e.paramsId),
        ownerId: match.tr.entityId,
        shotId: null,
        joined: false,
      });
    }
  }
  // Projectile kills (receiveShotKills) joined by (owner, shot): each
  // shell's arc endpoint snaps onto the victim at the ACTUAL hit instant —
  // the server aim point is where the shell would splash; the kill
  // position is where it connected. Flight end tightens to the hit too.
  const killsByOwnerShot = new Map<string, ShotKillEvent[]>();
  for (const k of ctx.props.shotKills) {
    const key = `${k.ownerId}:${k.shotId}`;
    const list = killsByOwnerShot.get(key);
    if (list) list.push(k);
    else killsByOwnerShot.set(key, [k]);
  }
  for (const list of killsByOwnerShot.values()) list.sort((a, b) => a.time - b.time);
  const killFor = (
    ownerId: number,
    shotId: number,
    t0: number,
    t1: number,
  ): ShotKillEvent | null => {
    const list = killsByOwnerShot.get(`${ownerId}:${shotId}`);
    if (!list) return null;
    // Shot ids recycle across salvos, so the window must be TIGHT: a kill
    // matches when it lands within the flight and no later than ~1s past
    // the predicted splash (kill times align with serverTimeLeft/2.75 to
    // well under a second; impacts BEFORE the predicted end are real —
    // the shell hit a closer ship than it was aimed at). Anything later
    // belongs to the next salvo reusing the same shot id.
    for (const k of list) {
      if (k.time >= t0 && k.time <= t1 + 1) return k;
    }
    return null;
  };
  for (const st of ctx.shellStates) {
    if (st.shotId == null) continue;
    const k = killFor(st.ownerId, st.shotId, st.t0, st.t1);
    if (!k) continue;
    st.to.set(k.x, 0, -k.z);
    if (k.time > st.t0) st.t1 = k.time;
    st.joined = true;
  }
  // Unjoined shells (misses / bounced / shattered — no receiveShotKills
  // entry): the aim point is only a launch-time prediction, so the tail
  // trailing past the target into empty water is noise. When a ship sits
  // at the predicted splash point at landing time, end the arc at that
  // ship instead — the shell is visually absorbed by the hull.
  const shipAt = (x: number, z: number, t: number, excludeId: number) => {
    let best: { x: number; z: number; d: number } | null = null;
    for (const tr of ctx.props.trajectories) {
      if (tr.kind?.entityType !== 2 || tr.entityId === excludeId) continue;
      const sp = sampleAt(tr, t);
      if (!sp) continue;
      const d = Math.hypot(sp.x - x, sp.z - z);
      if (d <= 200 && (!best || d < best.d)) best = { x: sp.x, z: sp.z, d };
    }
    return best;
  };
  for (const st of ctx.shellStates) {
    if (st.joined || !st.from) continue;
    const p = shipAt(st.to.x, -st.to.z, st.t1, st.ownerId);
    if (p) st.to.set(p.x, 0, -p.z);
  }
  return killFor;
}

/** Fixed pool of trace GPU objects (see buildShellStates). */
export function buildShellTracePool(ctx: MapInternals, scene: THREE.Scene) {
  // Fixed pool of trace GPU objects. Only a few dozen shells are airborne
  // at once even in heavy matches, so 220 slots cover the busiest frames;
  // overflow shells are simply not drawn that frame.
  // Shared cone geometry for in-flight shells (tip pointing +Y; oriented
  // along the trajectory tangent each frame for a smooth arc).
  const shellGeom = new THREE.ConeGeometry(0.9, 4, 8);
  ctx.shellTraceSlots = [];
  if (ctx.shellStates.length > 0) {
    for (let i = 0; i < 220; i++) {
      const curveArr = new Float32Array(28 * 3);
      // Manual BufferGeometry has no bounding sphere; without computing
      // one (or disabling culling) the frustum culler skips these lines.
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute("position", new THREE.BufferAttribute(curveArr, 3));
      lineGeo.computeBoundingSphere();
      const lineMat = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const line = new THREE.Line(lineGeo, lineMat);
      line.visible = false;
      scene.add(line);
      // Same curve rendered as fixed-pixel points so the flight reads
      // even at full-map zoom (a 1px line vanishes at that distance).
      const dotGeo = new THREE.BufferGeometry();
      dotGeo.setAttribute("position", new THREE.BufferAttribute(curveArr.slice(), 3));
      dotGeo.computeBoundingSphere();
      const dotMat = new THREE.PointsMaterial({
        size: 3.5,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      });
      const dots = new THREE.Points(dotGeo, dotMat);
      dots.visible = false;
      scene.add(dots);
      // In-flight shell: a pointed cone sliding along the arc (swapped
      // for the real shell GLB once loaded; driven identically).
      const shell = new THREE.Mesh(
        shellGeom,
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false }),
      );
      shell.visible = false;
      scene.add(shell);
      ctx.shellTraceSlots.push({ line, lineMat, dots, dotMat, shell });
      ctx.trajectoryLines.push(line);
    }
  }
}

/** Torpedo meshes + wakes with guidance tables; fish stop at their kill. */
export function buildTorpedoTraces(
  ctx: MapInternals,
  scene: THREE.Scene,
  killFor: KillFor,
) {
  // Torpedoes: straight white capsules from the firing ship's position at
  // launch time along the launch direction, running at the true engine
  // speed (~7 u/s ≈ 60 kn; see the per-frame loop). Each torpedo carries
  // a white wake line so it reads at full-map zoom.
  const torpedoGeom = new THREE.CapsuleGeometry(0.9, 4, 2, 8);
  const torpedoMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  const wakeGeom = new THREE.BufferGeometry();
  wakeGeom.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(6), 3),
  );
  const wakeMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  // Torpedo guidance updates keyed by (owner, shot) — the pair uniquely
  // identifies one fish across its salvo.
  const steerByFish = new Map<string, TorpedoSteer[]>();
  for (const st of ctx.props.torpedoSteers) {
    const key = `${st.ownerId}:${st.shotId}`;
    const list = steerByFish.get(key);
    if (list) list.push(st);
    else steerByFish.set(key, [st]);
  }
  for (const list of steerByFish.values()) list.sort((a, b) => a.time - b.time);
  for (const tp of ctx.props.torpedoes) {
    const mesh = new THREE.Mesh(torpedoGeom, torpedoMat);
    const wake = new THREE.Line(wakeGeom, wakeMat);
    mesh.visible = false;
    wake.visible = false;
    scene.add(mesh);
    scene.add(wake);
    ctx.torpedoMeshes.push({
      mesh,
      wake,
      t0: tp.time,
      endT: tp.time + 240,
      base: new THREE.Vector3(tp.x, 0, -tp.z),
      dir: new THREE.Vector3(tp.dirX, 0, -tp.dirZ).normalize(),
      steers: steerByFish.get(`${tp.ownerId}:${tp.shotId}`) ?? [],
      steerIdx: 0,
      launchT0: tp.time,
      launchBase: new THREE.Vector3(tp.x, 0, -tp.z),
      launchDir: new THREE.Vector3(tp.dirX, 0, -tp.dirZ).normalize(),
      ownerId: tp.ownerId,
      shotId: tp.shotId,
    });
  }
  // Torpedoes stop at their kill: a fish that connects detonates instead
  // of running out its full ~240 s lane. Absolute end time — steering
  // rebases t0 forward, so a relative life would extend the swim past
  // the detonation.
  for (const tm of ctx.torpedoMeshes) {
    const k = killFor(tm.ownerId, tm.shotId, tm.t0, tm.t0 + 240);
    if (k) tm.endT = Math.max(tm.t0, k.time);
  }
}

/** Swap the primitive placeholders for the real game models (baked GLBs
 *  from scripts/model_convert/bake_planes.py). Each swap keeps driving the
 *  replacement exactly like the primitive it replaces. */
export function swapTracePropModels(
  ctx: MapInternals,
  scene: THREE.Scene,
  epoch: number,
) {
  // Swap the primitive placeholders for the real game models (baked GLBs
  // from scripts/model_convert/bake_planes.py). Each swap keeps driving
  // the replacement exactly like the primitive it replaces.
  const shellPropUrl = resolvePropModelUrl("shell");
  if (shellPropUrl) {
    for (const slot of ctx.shellTraceSlots) {
      buildPropMarker({ url: shellPropUrl, color: 0xffffff, axis: "y", targetLen: 4 })
        .then((g) => {
          if (epoch !== ctx.markerEpoch || !ctx.api.value?.scene) return;
          g.visible = slot.shell.visible;
          g.position.copy(slot.shell.position);
          g.quaternion.copy(slot.shell.quaternion);
          scene.add(g);
          scene.remove(slot.shell);
          slot.shell = g;
        })
        .catch(() => { /* keep the cone fallback */ });
    }
  }
  const torpedoPropUrl = resolvePropModelUrl("torpedo");
  if (torpedoPropUrl) {
    for (const tm of ctx.torpedoMeshes) {
      buildPropMarker({ url: torpedoPropUrl, color: 0xffffff, axis: "y", targetLen: 5, opacity: 1 })
        .then((g) => {
          if (epoch !== ctx.markerEpoch || !ctx.api.value?.scene) return;
          g.visible = tm.mesh.visible;
          g.position.copy(tm.mesh.position);
          g.quaternion.copy(tm.mesh.quaternion);
          scene.add(g);
          scene.remove(tm.mesh);
          tm.mesh = g;
        })
        .catch(() => { /* keep the capsule fallback */ });
    }
  }
}
