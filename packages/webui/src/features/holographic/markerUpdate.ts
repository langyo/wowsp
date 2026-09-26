/**
 * The per-frame marker refresh, extracted verbatim from HolographicMap.tsx:
 * position/orient every ship marker, ghost + sink bookkeeping (kill feed
 * entries with killer resolution), cap ring/letter repaints, smoke cluster
 * rings + countdown sprites, aircraft formation placement, pooled shell
 * traces, torpedo runs (incl. homing re-anchoring), ward visibility, the
 * recorder aim line and the chat/achievement event feed advance.
 */
import * as THREE from "three";
import { parsePostBattle } from "@/features/replay/postBattle";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useLanguage } from "@/i18n/useLanguage";
import { t as i18nT } from "@/i18n";
import achievementNamesRaw from "@/data/achievement_names.json";
import { sampleAt, hpAtTime } from "./trajectoryMath";
import { clampXZ } from "./sceneUtils";
import type { TeamRole } from "./teamColors";
import { paintCapSprite } from "./screenOverlays";
import { shipOfflineEntry, shipNameFromOfflineDb, shipNameFromModelDb } from "./modelLoader";
import { sceneMapRect } from "./mapInternals";
import { updateCapsAndScore } from "./capSimulator";
import { updateLabelPositions } from "./labelOverlay";
import { formationOffsets } from "./planeFormation";
import { captureSecondsRemaining, formatEta } from "@wowsp/holo";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { ShipInfo, SquadronPlane, VehicleEntry } from "@/api";
import type { FeedEntry } from "./HoloEventFeed";
import type { MapInternals, ShellTraceSlot } from "./mapInternals";

/** Widest of the per-kind caps — chat can burst, so keep a little headroom
 *  over the old kill-only limit of 4. */
const FEED_CAP = 6;
const FEED_TTL_MS = 4000;

/** Achievement id → localized display name (GameParams-derived bundle; the
 *  same per-locale shape as ribbon_names.json). Falls back to the raw id. */
const achievementNames = achievementNamesRaw as Record<
  string,
  { key: string; type: string; names: Partial<Record<string, string>> }
>;

/** Roster entry by player id — chat/achievement events carry roster ids
 *  (descriptor `vehicles[].id`), not vehicle entity ids. */
function rosterById(ctx: MapInternals, pid: number): VehicleEntry | undefined {
  return ctx.props.vehicles.find((v) => v.id === pid);
}
/** Push one ctx.feed entry (newest first) and schedule its expiry. */
function pushFeed(ctx: MapInternals, entry: FeedEntry) {
  ctx.feed.value.unshift(entry);
  if (ctx.feed.value.length > FEED_CAP) ctx.feed.value.pop();
  window.setTimeout(() => {
    ctx.feed.value = ctx.feed.value.filter((e) => e.id !== entry.id);
  }, FEED_TTL_MS);
}
/** Fire chat + achievement ctx.feed entries crossed by playhead `t`. */
function advanceEventFeed(ctx: MapInternals, t: number) {
  const chats = ctx.props.chatMessages;
  while (ctx.chatPtr < chats.length && chats[ctx.chatPtr].time <= t) {
    const c = chats[ctx.chatPtr++];
    if (c.playerId <= 0) continue; // system rows the client itself ignores
    const roster = rosterById(ctx, c.playerId);
    pushFeed(ctx, {
      kind: "chat",
      id: ++ctx.feedSeq,
      sender: roster?.name ?? `#${c.playerId}`,
      enemy: (roster?.relation ?? 0) >= 2,
      message: c.message,
    });
  }
  const achs = ctx.props.achievements;
  const dataLang = useLanguage().dataLanguage.value;
  while (ctx.achPtr < achs.length && achs[ctx.achPtr].time <= t) {
    const a = achs[ctx.achPtr++];
    if (a.playerId <= 0) continue;
    const roster = rosterById(ctx, a.playerId);
    const bundle = achievementNames[String(a.achievementId)];
    pushFeed(ctx, {
      kind: "achievement",
      id: ++ctx.feedSeq,
      sender: roster?.name ?? `#${a.playerId}`,
      enemy: (roster?.relation ?? 0) >= 2,
      name:
        bundle?.names[dataLang] ??
        bundle?.names["en-US"] ??
        bundle?.key ??
        `#${a.achievementId}`,
      grade: bundle?.type ?? "",
    });
  }
}
/** Position + orient each ship marker at the ctx.current playback time.
 *  Ships whose model hasn't loaded yet are skipped; ships that have been
 *  destroyed (time ≥ deathTime) are frozen at their last position and
 *  their materials desaturated to a faint grey tint. */
export function updateMarkersAt(ctx: MapInternals, t: number) {
  // Chat + achievement ctx.feed events fire here too — the playhead is the
  // single clock every bottom-left notification hangs off.
  advanceEventFeed(ctx, t);
  const labels = ctx.shipLabels.value;
  // Alive counts are recomputed every frame from the markers' death times
  // (not incremented) so scrubbing backward restores sunk ships.
  let allyAliveNow = 0;
  let enemyAliveNow = 0;
  for (const m of ctx.shipMarkers) {
    const dt = m.userData.deathTime as number | null;
    if (dt == null || t < dt) {
      const role = m.userData.role as TeamRole;
      if (role === "ally" || role === "self") allyAliveNow++;
      else if (role === "enemy") enemyAliveNow++;
    }
  }
  ctx.allyAlive.value = allyAliveNow;
  ctx.enemyAlive.value = enemyAliveNow;
  for (let i = 0; i < ctx.shipMarkers.length; i++) {
    const marker = ctx.shipMarkers[i];
    const label = labels[i];
    const entityId = marker.userData.entityId as number;
    const traj = ctx.props.trajectories.find((tr) => tr.entityId === entityId);
    if (!traj || traj.samples.length === 0) {
      marker.visible = false;
      if (label) label.visible = false;
      continue;
    }
    // Ghost policy: an unobserved enemy (never seen once) is NOT rendered
    // at all; an unobserved ally shows a hollow WHITE box at its spawn.
    // Sunk ships (observed before dying) keep a hollow box at their last
    // position — white for allies, red for enemies.
    const role = marker.userData.role as TeamRole;
    const ghostBox = marker.userData.ghost as THREE.LineLoop | undefined;
    const firstT = marker.userData.firstT as number;
    // NOTE: no creationTime gate. A ship's EntityCreate fires when the
    // recorder FIRST OBSERVES it (creationTime tracks the first sample),
    // so gating on it would hide not-yet-spotted ALLIES for the whole
    // opening. The game shows teammates' last-known position from t=0 —
    // we do the same via the spawn ghost below. Unobserved enemies are
    // already fully hidden by the firstT rule.
    const deathTime = marker.userData.deathTime as number | null;
    const dead = deathTime != null && t >= deathTime;
    if (label) label.dead = dead;
    const tEff = dead ? deathTime! : t;
    const observed = tEff >= firstT;

    if (!observed) {
      if (role === "enemy") {
        if (ghostBox) ghostBox.visible = false;
        marker.visible = false;
        if (label) label.visible = false;
      } else {
        marker.position.set(traj.kind?.initialX ?? 0, 0, -(traj.kind?.initialZ ?? 0));
        marker.rotation.y = Math.PI - (traj.samples[0]?.yaw ?? 0);
        marker.visible = false;
        if (ghostBox) {
          ghostBox.visible = true;
          ghostBox.position.set(traj.kind?.initialX ?? 0, 0, -(traj.kind?.initialZ ?? 0));
        }
        if (label) {
          label.visible = true;
          label.ghostText = i18nT("replay.legend.gone", { n: t.toFixed(0) });
        }
      }
      continue;
    }
    if (ghostBox) ghostBox.visible = false;

    // After death the ship is gone from the water: hollow box at the
    // LIVE position (sinking ships keep drifting in the samples) + a
    // "sunk" label that keeps tracking the actual coordinates.
    const s: ReturnType<typeof sampleAt> | null = sampleAt(traj, dead ? t : tEff);
    if (!s) {
      marker.visible = false;
      if (label) label.visible = false;
      continue;
    }
    // Show the dot marker even before the ship model loads; hide only
    // when model is missing entirely (not dot, not loaded).
    const hasModel = marker.userData.modelLoaded as boolean;
    const hasDot = marker.userData.isDot as boolean;
    if (!hasModel && !hasDot) continue;
    if (dead) {
      if (ghostBox) {
        ghostBox.visible = true;
        ghostBox.position.set(s.x, 0, -s.z);
      }
      marker.visible = false;
      // Keep the marker transform in sync so the floating label projects
      // to the ship's actual position (not the death instant).
      marker.position.set(s.x, 0, -s.z);
      marker.rotation.y = Math.PI - s.yaw;
      if (label) {
        // Sunk ships keep the dead tag — no "gone for N s" counter.
        label.visible = true;
        label.ghostText = null;
      }
      if (!marker.userData._countedDead) {
        marker.userData._countedDead = true;
        const role = marker.userData.role as TeamRole;
        // Kill ctx.feed + score tick. The killer's identity lives in the
        // post-battle payload (killerId, index 408) — resolve it to a
        // nickname, ship name and ship type at sink time.
        if (!ctx.reportedSinks.has(entityId)) {
          ctx.reportedSinks.add(entityId);
          const who = label?.name ?? `#${entityId}`;
          // Killer resolution: the killer's account id lives in the
          // post-battle payload (index 408); map it back to a nickname
          // via the same playersPublicInfo table.
          let killerName: string | null = null;
          let killerShipId: number | null = null;
          let killerShipName = "";
          let killerShipType: string | null = null;
          if (ctx.props.battleResults) {
            ctx.pbCache ??= parsePostBattle(ctx.props.battleResults);
          }
          if (ctx.pbCache?.players && who) {
            const vn = who.trim().toLowerCase();
            const victim = ctx.pbCache.players.find(
              (p) => (p.name ?? "").trim().toLowerCase() === vn,
            );
            if (victim?.killerId != null) {
              const killer = ctx.pbCache.players.find(
                (p) => p.accountId === victim.killerId,
              );
              killerName = killer?.name ?? null;
              killerShipId = killer?.shipId ?? null;
            }
          }
          if (killerShipId != null) {
            const encStore = useEncyclopediaStore();
            const dataLang = useLanguage().dataLanguage.value;
            const kinfo = ctx.props.encyclopedia.get(killerShipId) as ShipInfo | undefined;
            const koff = shipOfflineEntry(killerShipId);
            killerShipName =
              (kinfo ? encStore.shipDisplayName(kinfo) : null) ??
              shipNameFromOfflineDb(killerShipId, dataLang) ??
              shipNameFromModelDb(killerShipId) ??
              "";
            killerShipType = kinfo?.type ?? koff?.type ?? null;
          }
          const feedId = ++ctx.feedSeq;
          ctx.feed.value.unshift({
            kind: "kill",
            id: feedId,
            text: who,
            shipName: label?.shipName ?? "",
            shipType: label?.type ?? null,
            killerShipName,
            killerShipType,
            killerName,
            role,
          });
          if (ctx.feed.value.length > FEED_CAP) ctx.feed.value.pop();
          window.setTimeout(() => {
            ctx.feed.value = ctx.feed.value.filter((k) => k.id !== feedId);
          }, FEED_TTL_MS);
        }
      }
      continue;
    }
    marker.visible = true;
    marker.position.set(s.x, 0, -s.z);
    marker.rotation.y = Math.PI - s.yaw;
    // Keep the minimap's heading in sync — userData.yaw must track the
    // playhead, not just the initial load.
    marker.userData.yaw = s.yaw;
    if (label) {
      label.ghostText = null;
      const currentHp = hpAtTime(traj.hpSamples, tEff);
      if (currentHp != null) label.hp = currentHp;
      label.maxHp ??= currentHp ?? label.maxHp;
    }
  }
  // Capture-zone ownership + estimated score at this instant.
  updateCapsAndScore(ctx, t);
  // Repaint the 3D cap rings by live state (owner color, capture pulse).
  ctx.capDisplay.value.forEach((c, i) => {
    const ring = ctx.capRings[i];
    if (!ring) return;
    const mat = ring.material as LineMaterial;
    if (c.owner === 1) mat.color.set(0x4ade80);
    else if (c.owner === 2) mat.color.set(0xcc3333);
    else mat.color.set(0xffffff);
    mat.opacity = c.capturing ? 0.7 : c.contested ? 0.5 : 0.35;
  });
  // Cap letters: Alt held → redraw with the shared point timer (capture
  // seconds while capturing; idle neutral points stay clean).
  const capAlt = ctx.showCapEta.value;
  ctx.capDisplay.value.forEach((c, i) => {
    const sprite = ctx.capLetterSprites[i];
    if (!sprite) return;
    if (!sprite.userData.canvas) return;
    const text = String(c.letter);
    let etaLine = "";
    if (capAlt) {
      const teamShips = c.captureTeam === 1 ? c.alliesIn : c.enemiesIn;
      const rem = captureSecondsRemaining(c.progress, teamShips, c.contested);
      if (c.capturing && rem.seconds != null) etaLine = formatEta(rem.seconds);
    }
    const quickEta =
      c.etaSeconds != null && c.etaSeconds > 0
        ? Math.ceil(c.etaSeconds) + " s"
        : "";
    const key = `${text}|${etaLine}|${quickEta}`;
    if (sprite.userData.text === key) return;
    sprite.userData.text = key;
    paintCapSprite(
      sprite.userData.canvas as HTMLCanvasElement,
      text,
      quickEta || etaLine,
    );
    (sprite.material as THREE.SpriteMaterial).map!.needsUpdate = true;
  });
  // Smoke screens: white start/end rings + a floating remaining-seconds
  // tag. The start ring walks toward the end while the smoke dissipates
  // (WoWS smoke fades from the launch point); each cluster shows both
  // endpoints only when the drift is >= 1 km, otherwise a single puff.
  for (const cl of ctx.smokeClusters) {
    const hide = () => {
      cl.rings[0].visible = false;
      cl.rings[1].visible = false;
      if (cl.timeSprite) cl.timeSprite.visible = false;
    };
    if (t < cl.t0 || t > cl.endT) {
      hide();
      continue;
    }
    // Dissipation walk: after the last recorded update the start point
    // slides from the launch position toward the end position.
    let cur = t;
    if (t > cl.lastT) {
      const span = Math.max(1, cl.lastT - cl.t0);
      cur = cl.t0 + ((t - cl.lastT) * span) / Math.max(1, cl.endT - cl.lastT);
      if (cur > cl.lastT) cur = cl.lastT;
    }
    const pStart = sampleAt(cl.traj, cur);
    if (!pStart) {
      hide();
      continue;
    }
    const pEnd = sampleAt(cl.traj, cl.lastT);
    const drift =
      pEnd != null ? Math.hypot(pStart.x - pEnd.x, pStart.z - pEnd.z) : 0;
    const showBoth = pEnd != null && drift >= 1000;
    cl.rings[0].visible = true;
    cl.rings[0].position.set(pStart.x, 2.5, -pStart.z);
    cl.rings[1].visible = showBoth;
    if (showBoth && pEnd) cl.rings[1].position.set(pEnd.x, 2.5, -pEnd.z);
    const sprite = cl.timeSprite;
    if (sprite) {
      const secs = Math.ceil(cl.endT - t);
      const text = `${secs}s`;
      if (sprite.userData.text !== text) {
        sprite.userData.text = text;
        const cvs = sprite.userData.canvas as HTMLCanvasElement;
        const c2d = cvs.getContext("2d")!;
        c2d.clearRect(0, 0, cvs.width, cvs.height);
        c2d.fillStyle = "rgba(255,255,255,0.9)";
        c2d.font = "bold 80px sans-serif";
        c2d.textAlign = "center";
        c2d.textBaseline = "middle";
        c2d.shadowColor = "rgba(0,0,0,0.9)";
        c2d.shadowBlur = 12;
        c2d.fillText(text, cvs.width / 2, cvs.height / 2);
        (sprite.material as THREE.SpriteMaterial).map!.needsUpdate = true;
      }
      sprite.position.set(pStart.x, 34, -pStart.z);
      sprite.visible = true;
    }
  }
  // Aircraft formations: full squadrons (GameParams size, e.g. 8 planes)
  // arranged in a wedge and slowly circling. Modeled formations drive
  // their GLB pool; the rest fall back to Points.
  {
    const attr = ctx.planeCloud
      ? (ctx.planeCloud.geometry.getAttribute("position") as THREE.BufferAttribute)
      : null;
    const arr = attr ? (attr.array as Float32Array) : null;
    let anyPoints = false;
    // Sample helper: last sample at or before t.
    const sampleOf = (samples: SquadronPlane[]): SquadronPlane | null => {
      let s: SquadronPlane | null = null;
      for (const sp of samples) {
        if (sp.time > t) break;
        s = sp;
      }
      return s;
    };
    // Formation anchors: index-0 trail of each planeId (position + yaw),
    // alive between its first update and ~2 min after the last one.
    const formationAnchor = new Map<number, { s: SquadronPlane; born: number; expiry: number }>();
    for (const trail of ctx.planeTrails) {
      const planeId = Math.floor(trail.id / 16);
      if (trail.id % 16 !== 0) continue;
      const s = sampleOf(trail.samples);
      if (!s) continue;
      const born = trail.samples[0].time;
      const removed = ctx.minimapTrailEnd.get(planeId);
      const expiry = Math.min(
        trail.samples[trail.samples.length - 1].time + 5,
        removed ?? Infinity,
      );
      if (t >= born && t <= expiry) {
        formationAnchor.set(planeId, { s, born, expiry });
      }
    }
    for (const [planeId, anchor] of formationAnchor) {
      const pool = ctx.planeMeshes.get(planeId);
      const formation = ctx.planeFormations.get(planeId);
      const total = formation?.count ?? 3;
      const gCount = formation?.groupCount ?? total;
      const gSize = formation?.groupSize ?? 1;
      // Filled-wedge layout over flight groups (leader front, groups
      // stepping back 1-2-3-…, leftover groups centered in the last row).
      const offsets = formationOffsets(gCount, gSize);
      const n = Math.min(total, offsets.length);
      // Slow circle so airborne squadrons visibly hold a patrol orbit.
      const ang = t * 0.22 + (planeId % 7) * 0.9;
      const R = 50;
      // Heading follows the patrol-circle TANGENT (the direction the
      // formation is actually moving) so the wedge turns as it orbits
      // instead of sliding sideways pointing at a fixed heading.
      const yaw = Math.atan2(-Math.sin(ang), Math.cos(ang));
      const fwd = { x: Math.sin(yaw), z: -Math.cos(yaw) };
      const right = { x: Math.cos(yaw), z: Math.sin(yaw) };
      // Orbit CENTRE = the formation's geometric centroid (not the lead
      // plane) — a filled wedge visibly spins around its middle, like the
      // in-game flight circle. The centroid sits at the anchor plus the
      // (heading-rotated) mean offset of all aircraft.
      const cxm = offsets.reduce((a, o) => a + o.ox, 0) / Math.max(1, offsets.length);
      const czm = offsets.reduce((a, o) => a + o.oz, 0) / Math.max(1, offsets.length);
      const ccx = anchor.s.x + cxm * right.x + czm * fwd.x;
      const ccz = anchor.s.z + cxm * right.z + czm * fwd.z;
      const cx = ccx + Math.cos(ang) * R;
      const cz = ccz + Math.sin(ang) * R;
      const yBase = Math.max(60, anchor.s.y);
      if (pool && pool.length >= n) {
        for (let i = 0; i < n; i++) {
          const mesh = pool[i];
          mesh.visible = true;
          const o = offsets[i];
          const ox = (o.ox - cxm) * right.x + (o.oz - czm) * fwd.x;
          const oz = (o.ox - cxm) * right.z + (o.oz - czm) * fwd.z;
          const yOff = (i % 3) * 2 - 2; // -2 / 0 / +2 alternating
          mesh.position.set(cx + ox, yBase + yOff, -cz + oz);
          mesh.rotation.y = Math.PI - yaw;
        }
      } else {
        // No model pool (yet): fall back to a point at the centroid.
        const cloudSlot = ctx.planeCloudSlots.get(planeId);
        if (arr && cloudSlot != null) {
          arr[cloudSlot * 3] = cx;
          arr[cloudSlot * 3 + 1] = yBase;
          arr[cloudSlot * 3 + 2] = -cz;
          anyPoints = true;
        }
      }
    }
    // Hide pools of formations currently not anchored.
    for (const [planeId, pool] of ctx.planeMeshes) {
      if (formationAnchor.has(planeId)) continue;
      for (const m of pool) m.visible = false;
    }
    if (ctx.planeCloud && attr) {
      ctx.planeCloud.visible = anyPoints;
      attr.needsUpdate = true;
    }
  }
  // Shell traces: ballistic arc from the firing ship to the impact
  // point, shown while the shell is airborne [t0, t1]. Pool slots are
  // assigned to whichever shells are airborne THIS frame (a match
  // carries 10k+ shells; only a few dozen fly at once). Elements outside
  // the fitted battle bounds are stray data — hidden so they can't flash
  // out in empty space.
  const mapRect = sceneMapRect(ctx);
  const inBounds = (x: number, z: number) =>
    !ctx.bounds || (x >= ctx.bounds.minX && x <= ctx.bounds.maxX && z >= ctx.bounds.minZ && z <= ctx.bounds.maxZ);
  const hideSlot = (slot: ShellTraceSlot) => {
    slot.line.visible = false;
    slot.dots.visible = false;
    slot.shell.visible = false;
  };
  let slotIdx = 0;
  for (const st of ctx.shellStates) {
    if (slotIdx >= ctx.shellTraceSlots.length) break;
    // Only airborne shells render; pre-flight and landed states skip
    // without consuming a slot.
    const inFlight = t >= st.t0 && t <= st.t1;
    if (!inFlight) continue;
    // Traces whose launch OR impact point lies outside the fitted battle
    // bounds are stray data — hide the whole trace so it can't flash out
    // in empty space (both endpoints must be in-bounds). Endpoints are
    // guarded rather than assumed: a trace that somehow lacks one hides
    // its slot instead of crashing the whole refresh.
    const impactIn = !!st.to && !!st.from && inBounds(st.to.x, st.to.z) && inBounds(st.from.x, st.from.z);
    const slot = ctx.shellTraceSlots[slotIdx];
    if (!impactIn || !st.from) {
      hideSlot(slot);
      slotIdx++;
      continue;
    }
    slotIdx++;
    const from = st.from;
    // Drawn points are clamped to the true map rect so even an aim point
    // beyond the edge (server aim overshoot, matched-splash noise) keeps
    // the whole arc inside the playable map.
    const arcPoint = (k: number) => {
      const px = from.x + (st.to.x - from.x) * k;
      const pz = from.z + (st.to.z - from.z) * k;
      const kx = k * 2 - 1;
      const py = Math.max(0, st.h * (1 - kx * kx));
      const c = clampXZ(px, pz, mapRect);
      return { x: c.x, y: py, z: c.z };
    };
    slot.lineMat.color.setHex(st.color);
    slot.dotMat.color.setHex(st.color);
    // Cone or swapped GLB — tint whatever material it now wears.
    slot.shell.traverse((child) => {
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (mat && mat.color) mat.color.setHex(st.color);
    });
    slot.line.visible = true;
    slot.dots.visible = true;
    slot.shell.visible = true;
    {
      const attr = slot.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let i = 0; i < 28; i++) {
        const p = arcPoint(i / 27);
        arr[i * 3] = p.x;
        arr[i * 3 + 1] = p.y;
        arr[i * 3 + 2] = p.z;
      }
      attr.needsUpdate = true;
      const dotAttr = slot.dots.geometry.getAttribute("position") as THREE.BufferAttribute;
      dotAttr.needsUpdate = true;
      // Shell position + orientation: interpolate k across the flight,
      // tip pointing along the local tangent.
      const k = Math.min(1, Math.max(0, (t - st.t0) / (st.t1 - st.t0)));
      const p = arcPoint(k);
      slot.shell.position.set(p.x, p.y, p.z);
      const p2 = arcPoint(Math.min(1, k + 0.03));
      const tx = p2.x - p.x;
      const ty = p2.y - p.y;
      const tz = p2.z - p.z;
      const len = Math.hypot(tx, ty, tz) || 1;
      ctx._shellDir.set(tx / len, ty / len, tz / len);
      slot.shell.quaternion.setFromUnitVectors(ctx._shellUp, ctx._shellDir);
    }
  }
  for (; slotIdx < ctx.shellTraceSlots.length; slotIdx++) {
    hideSlot(ctx.shellTraceSlots[slotIdx]);
  }
  // Torpedoes: advance straight along the launch direction. The capsule
  // geometry runs along +Y, so orient it flat along the travel direction
  // (a plain rotation.y would leave it standing upright). Homing fish
  // re-anchor at each guidance update as the playhead passes it.
  // Speed 7 u/s ≈ 31 m/s ≈ 60 kn at the engine scale (1 u ≈ 4.5 m) — the
  // old 33 u/s constant ran fish ~5× too fast and shot them clean off
  // the map; the map-rect clamp below is the hard guarantee they stop at
  // the edge regardless.
  const torpedoPos = (
    tm: { base: THREE.Vector3; dir: THREE.Vector3 },
    age: number,
  ) =>
    clampXZ(
      tm.base.x + tm.dir.x * 7 * age,
      tm.base.z + tm.dir.z * 7 * age,
      mapRect,
    );
  for (const tm of ctx.torpedoMeshes) {
    // Backward scrub rewinds the guidance anchors so replays stay correct
    // in both directions; the while-loop then re-applies every past steer.
    if (tm.steerIdx > 0 && t < tm.steers[tm.steerIdx - 1].time) {
      tm.steerIdx = 0;
      tm.t0 = tm.launchT0;
      tm.base.copy(tm.launchBase);
      tm.dir.copy(tm.launchDir);
    }
    while (tm.steerIdx < tm.steers.length && t >= tm.steers[tm.steerIdx].time) {
      const st = tm.steers[tm.steerIdx++];
      tm.base.set(st.x, 0, -st.z);
      tm.t0 = st.time;
      // Ship yaw convention: heading = (sin yaw, cos yaw) in world XZ.
      tm.dir.set(Math.sin(st.targetYaw), 0, -Math.cos(st.targetYaw)).normalize();
    }
    const age = t - tm.t0;
    const on = age >= 0 && t <= tm.endT;
    tm.mesh.visible = on;
    tm.wake.visible = on;
    if (on) {
      const p = torpedoPos(tm, age);
      tm.mesh.position.set(p.x, 1.2, p.z);
      tm.mesh.quaternion.setFromUnitVectors(ctx._shellUp, tm.dir);
      const wakeAttr = tm.wake.geometry.getAttribute("position") as THREE.BufferAttribute;
      const tail = tm.dir.clone().multiplyScalar(40);
      wakeAttr.setXYZ(0, p.x - tail.x, 0.4, p.z - tail.z);
      wakeAttr.setXYZ(1, p.x, 0.4, p.z);
      wakeAttr.needsUpdate = true;
    }
  }
  // Fighter-patrol wards: alive between their add and remove events.
  for (const w of ctx.wardRings) {
    const on = t >= w.t0 && (w.t1 == null || t <= w.t1);
    w.ring.visible = on;
    w.fill.visible = on;
  }
  // Recorder aim line: from the own ship to the currently locked target.
  if (ctx.lockLine) {
    const cur = ctx.props.weaponLocks.filter((l) => l.time <= t);
    const last = cur.length > 0 ? cur[cur.length - 1] : null;
    const selfMarker = ctx.shipMarkers.find((m) => m.userData.role === "self");
    const targetMarker = last
      ? ctx.shipMarkers.find((m) => m.userData.entityId === last.targetId)
      : null;
    const on =
      last != null &&
      last.lockType === 3 &&
      selfMarker != null &&
      targetMarker != null;
    ctx.lockLine.visible = on;
    if (on && selfMarker && targetMarker) {
      const a = selfMarker.position;
      const b = targetMarker.position;
      const attr = ctx.lockLine.geometry.getAttribute("position") as THREE.BufferAttribute;
      attr.setXYZ(0, a.x, 30, a.z);
      attr.setXYZ(1, b.x, 30, b.z);
      attr.needsUpdate = true;
    }
  }
  // Aircraft labels (one per carrier): sync name/HP from the carrier and
  // show while any of its squadrons is in the air (visible window =
  // first update .. last update + 2 min).
  {
    const labels = ctx.shipLabels.value;
    for (const [labelId, carrierId] of ctx.planeLabelCarriers) {
      const label = labels.find((l) => l.entityId === labelId);
      if (!label) continue;
      const carrierIdx = carrierId == null ? -1 : ctx.shipMarkers.findIndex(
        (m) => m.userData.entityId === carrierId,
      );
      const carrierLabel = carrierIdx >= 0 ? labels[carrierIdx] : null;
      if (carrierLabel) {
        label.name = carrierLabel.name;
        label.shipName = carrierLabel.shipName;
        label.tier = carrierLabel.tier;
        label.hp = carrierLabel.hp;
        label.maxHp = carrierLabel.maxHp;
        // Aircraft have no "sunk" state — planes are simply gone when
        // shot down, so the card never shows the ship's dead tag.
        label.dead = false;
      }
      // Any of this carrier's squadrons airborne?
      let visible = false;
      for (const [planeId, labelOf] of ctx.planeLabelOfPlane) {
        if (labelOf !== labelId) continue;
        const trail = ctx.planeTrails.find((tr) => Math.floor(tr.id / 16) === planeId);
        if (!trail || trail.samples.length === 0) continue;
        const first = trail.samples[0].time;
        const last = trail.samples[trail.samples.length - 1].time;
        // Squadron is gone 5s after its last sample — no lingering labels.
        if (t >= first && t <= last + 5) {
          visible = true;
          break;
        }
      }
      label.visible = visible;
    }
  }
  // Update screen-space positions of floating labels from marker world positions.
  updateLabelPositions(ctx);
}
