/**
 * The per-frame marker refresh, extracted verbatim from HolographicMap.tsx:
 * position/orient every ship marker, ghost + sink bookkeeping (kill feed
 * entries with killer resolution), cap ring/letter repaints, smoke cluster
 * rings + countdown sprites, aircraft formation placement, pooled shell
 * traces, torpedo runs (incl. homing re-anchoring), ward visibility, the
 * recorder aim line and the chat/achievement event feed advance.
 */
import * as THREE from "three";
import { findNpcVictimRow, parsePostBattle } from "@/features/replay/postBattle";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useLanguage } from "@/i18n/useLanguage";
import { t as i18nT } from "@/i18n";
import achievementNamesRaw from "@/data/achievement_names.json";
import { sampleAt, hpAtTime, angleDiff, UNSEEN_GAP_S } from "./trajectoryMath";
import { SCENE_THEMES, scenePalette } from "./useThreeScene";
import { clampXZ } from "./sceneUtils";
import { SHELL_TRACE_SAMPLES, shellTrailAlpha } from "./shellWarfare";
import type { TeamRole } from "./teamColors";
import { paintCapSprite, paintSmokeCountdown } from "./screenOverlays";
import { lastSquadronEventAt, squadronFlyingAt } from "./planeFollow";
import { shipOfflineEntry, shipNameFromOfflineDb, shipNameFromModelDb } from "./modelLoader";
import { isAiName, isAiSinkVictim, isScriptedUnitName } from "@/utils/aiNames";
import { sceneMapRect } from "./mapInternals";
import { updateCapsAndScore } from "./capSimulator";
import { formationOffsets, planeTrailExpiry } from "./planeFormation";
import { updateStormZone } from "./weatherScene";
import { syncMoveAdvisories } from "./moveAdvisories";
import { PLANE_DOT_PARKED_Y } from "./planeWarfare";
import type { OsdTone } from "./osdContrast";
import { captureSecondsRemaining, formatEta } from "@wowsp/holo";
import { recordedCameraAt, recordedCameraForward } from "./recordedCamera";
import { shipStatusAt } from "./shipStatusModel";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { ShipInfo, SquadronPlane, VehicleEntry, WeaponLockEvent } from "@/api";
import type { FeedEntry } from "./HoloEventFeed";
import type {
  MapInternals,
  PlaneAnchorAnim,
  ShellTraceSlot,
} from "./mapInternals";

/** Recorded/original camera view: minimum distance (scene units) the
 *  CLOSEST own-squadron slot keeps from the recorded lens. The plane-camera
 *  ride puts the recorder's own camera INSIDE the formation (the minimap
 *  centre track it follows sits ~at the lens), which rendered the models as
 *  near-plane shards; hanging the wedge this far along the interpolated
 *  view axis puts the squadron ahead of the lens instead. 80 units keeps a
 *  full squadron readable instead of filling the frame (the HUD's wheel
 *  dolly pulls the recorded camera back on top of this — see
 *  HolographicMap's recorded-camera zoom). */
const RECORDED_PLANE_PAD = 80;

/** Replays without the 0x27 camera-mode stream cannot announce a recorded
 *  plane-camera segment; the ride is then inferred when a formation's
 *  anchor sits this close to the recorded lens (the plane camera flies a
 *  few units off its squadron). */
const RECORDED_LENS_PROXIMITY = 50;

/** Widest of the per-kind caps — chat can burst, so keep a little headroom
 *  over the old kill-only limit of 4. */
const FEED_CAP = 6;
const FEED_TTL_MS = 4000;

/** Scratch for the per-shell trail tint (ammo color → linear RGB written to
 *  every arc vertex) — no per-slot per-frame Color allocation. */
const trailTint = new THREE.Color();

/** Achievement id → localized display name (GameParams-derived bundle; the
 *  same per-locale shape as ribbon_names.json). Falls back to the raw id. */
const achievementNames = achievementNamesRaw as Record<
  string,
  { key: string; type: string; names: Partial<Record<string, string>> }
>;

/** Eased 3D formation anchor at playhead t: interpolate the squadron's
 *  index-0 trail piecewise-linearly (the raw last-sample-at-or-before-t
 *  anchor stepped between update packets, and both the rendered wedge and
 *  the chase camera inherited the jerk), then ease it through the shared
 *  per-plane PlaneAnchorAnim state with the same exponential decay the
 *  minimap trails use (tau 0.28 s). Seeks and backwards scrubs snap.
 *  Returns a SquadronPlane-shaped pose so the formation placement below
 *  keeps reading `anchor.s.x/y/z/yaw` unchanged. */
const PLANE_ANCHOR_TAU_S = 0.28;
function easedAnchorAt(
  samples: SquadronPlane[],
  t: number,
  planeId: number,
  state: Map<number, PlaneAnchorAnim>,
): SquadronPlane | null {
  const n = samples.length;
  if (n === 0) return null;
  let a = samples[0];
  let b = samples[0];
  if (t >= samples[n - 1].time) {
    a = b = samples[n - 1];
  } else if (t > samples[0].time) {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].time <= t) lo = mid;
      else hi = mid;
    }
    a = samples[lo];
    b = samples[hi];
  }
  const span = b.time - a.time;
  const f = span > 1e-6 ? Math.min(1, Math.max(0, (t - a.time) / span)) : 1;
  const rawX = a.x + (b.x - a.x) * f;
  const rawY = a.y + (b.y - a.y) * f;
  const rawZ = a.z + (b.z - a.z) * f;
  const rawYaw = a.yaw + angleDiff(a.yaw, b.yaw) * f;
  const prev = state.get(planeId);
  // Same playhead twice (thumb + zoom canvases) reuses the eased pose;
  // backwards time, long gaps (scrub / new sortie) snap to the raw pose.
  if (prev && t === prev.t) {
    return {
      time: t, planeId, index: 0, x: prev.x, y: prev.y, z: prev.z, yaw: prev.yaw,
    };
  }
  const jumped =
    !prev || t < prev.t || Math.hypot(rawX - prev.x, rawZ - prev.z) > 200;
  if (jumped) {
    state.set(planeId, { x: rawX, y: rawY, z: rawZ, yaw: rawYaw, t });
    return { time: t, planeId, index: 0, x: rawX, y: rawY, z: rawZ, yaw: rawYaw };
  }
  const alpha = 1 - Math.exp(-(t - prev.t) / PLANE_ANCHOR_TAU_S);
  const x = prev.x + (rawX - prev.x) * alpha;
  const y = prev.y + (rawY - prev.y) * alpha;
  const z = prev.z + (rawZ - prev.z) * alpha;
  const yaw = prev.yaw + angleDiff(prev.yaw, rawYaw) * alpha;
  state.set(planeId, { x, y, z, yaw, t });
  return { time: t, planeId, index: 0, x, y, z, yaw };
}


/** Roster entry by player id — chat/achievement events carry roster ids
 *  (descriptor `vehicles[].id`), not vehicle entity ids. */
function rosterById(ctx: MapInternals, pid: number): VehicleEntry | undefined {
  return ctx.props.vehicles.find((v) => v.id === pid);
}
/** Feed sender display name: the roster nickname — except scripted scenario
 *  NPCs, whose raw `IDS_*` text key reads as the ship's display name. */
function senderNameOf(ctx: MapInternals, roster: VehicleEntry | undefined, pid: number): string {
  if (!roster) return `#${pid}`;
  if (!isScriptedUnitName(roster.name)) return roster.name;
  const encStore = useEncyclopediaStore();
  const dataLang = useLanguage().dataLanguage.value;
  const info = ctx.props.encyclopedia.get(roster.shipId) as ShipInfo | undefined;
  return (
    (info ? encStore.shipDisplayName(info) : null) ??
    shipNameFromOfflineDb(roster.shipId, dataLang) ??
    shipNameFromModelDb(roster.shipId) ??
    `#${pid}`
  );
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
  const enemyOf = (roster: VehicleEntry | undefined) =>
    (roster?.relation ?? 0) >= 2;
  const chats = ctx.props.chatMessages;
  while (ctx.chatPtr < chats.length && chats[ctx.chatPtr].time <= t) {
    const c = chats[ctx.chatPtr++];
    if (c.playerId <= 0) continue; // system rows the client itself ignores
    const roster = rosterById(ctx, c.playerId);
    pushFeed(ctx, {
      kind: "chat",
      id: ++ctx.feedSeq,
      sender: senderNameOf(ctx, roster, c.playerId),
      enemy: enemyOf(roster),
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
      sender: senderNameOf(ctx, roster, a.playerId),
      enemy: enemyOf(roster),
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
  // Label CONTENT (hp / below-hull status rows) refreshes on a ~10 Hz gate —
  // the same idea as hudCurrent: both are interpolated values whose per-frame
  // churn used to re-render every label component each rendered frame.
  // Positions are separate: labelOverlay applies them imperatively per frame.
  // Event-level fields (dead, ghostText) stay unthrottled.
  const contentDue = Math.abs(t - ctx.labelContentAt) >= 0.1;
  if (contentDue) ctx.labelContentAt = t;
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
    // O(1) trajectory join — rebuilt with the actors (mapInternals.trajById),
    // replacing the per-frame linear scan over every trajectory.
    const traj = ctx.trajById.get(entityId);
    if (!traj || traj.samples.length === 0) {
      marker.visible = false;
      if (label) label.visible = false;
      continue;
    }
    // Ghost policy: an unobserved enemy (never seen once) is NOT rendered
    // at all; an unobserved ally shows a hollow WHITE box at its spawn.
    // Sunk ships (observed before dying) keep a hollow box at their last
    // position — white for allies, red for enemies. Operation scenarios
    // (行动) add a fourth rule: a spotted-then-dark enemy swaps its live
    // marker for the red ghost at the last-known pose (see below).
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
          label.status = null;
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
        label.status = null;
      }
      if (!marker.userData._countedDead) {
        marker.userData._countedDead = true;
        const role = marker.userData.role as TeamRole;
        // Kill ctx.feed + score tick. The killer's identity lives in the
        // post-battle payload (killerId — parsePostBattle resolves the client
        // layout) — resolve it to a nickname, ship name and ship type at sink
        // time.
        if (!ctx.reportedSinks.has(entityId)) {
          ctx.reportedSinks.add(entityId);
          const who = label?.name ?? `#${entityId}`;
          // Killer resolution: the killer's account id lives in the
          // post-battle payload (parsePostBattle; 408 on the 15.2–15.9
          // layout, 420 on 15.10+); map it back to a nickname via the same
          // playersPublicInfo table.
          let killerName: string | null = null;
          let killerShipId: number | null = null;
          let killerShipName = "";
          let killerShipType: string | null = null;
          // The card paints each side with its OWN team color (the icons,
          // not just the tint bar): the killer is the opposite side of the
          // victim, except a self-kill (beached, detonation — the row names
          // itself) below.
          let killerRole: TeamRole = role === "enemy" ? "ally" : "enemy";
          if (ctx.props.battleResults) {
            ctx.pbCache ??= parsePostBattle(ctx.props.battleResults);
          }
          if (ctx.pbCache?.players && who) {
            const vn = who.trim().toLowerCase();
            // A scripted NPC victim sails under its SHIP name on the map
            // (its roster nickname is the raw `IDS_*` text key), so the
            // display-name match could grab a HUMAN who happens to share
            // the ship's name — scripted victims join through their roster
            // entry's RAW nickname instead, with the shipId only as the
            // last resort (escort waves share a shipId, so that join is
            // ambiguous whenever two of them sank). An UNLISTED operation
            // wave (行动) has neither scripted flag nor roster row — the op
            // roster covers the player team only — and its label reads the
            // ship name too, so there the plain-name lookup is gated to
            // real nicknames (never the ship-name fallback); PvP keeps the
            // old lookup even for the freak nickname-equals-ship-name case.
            const veh = ctx.rosterAssignments.get(entityId);
            const shipNameFallback =
              !!ctx.props.operation &&
              !!label?.shipName &&
              who === label.shipName;
            let victim =
              label?.scripted || shipNameFallback
                ? undefined
                : ctx.pbCache.players.find(
                    (p) => (p.name ?? "").trim().toLowerCase() === vn,
                  );
            if (!victim && veh && isScriptedUnitName(veh.name)) {
              const rn = veh.name.trim().toLowerCase();
              victim = ctx.pbCache.players.find(
                (p) => (p.name ?? "").trim().toLowerCase() === rn,
              );
            }
            if (!victim && label?.scripted && label.shipId != null) {
              victim = ctx.pbCache.players.find(
                (p) => p.shipId === label.shipId && isScriptedUnitName(p.name ?? ""),
              );
            }
            if (!victim && !label?.scripted && label?.shipId != null) {
              // Unlisted operation wave: join the post-battle AI row by
              // ship id on the victim's own side (findNpcVictimRow), so the
              // killer's nickname/ship resolve instead of reading "?".
              const pb = ctx.pbCache;
              const selfTeam =
                pb.selfId != null
                  ? pb.players.find((p) => p.accountId === pb.selfId)?.team ??
                    null
                  : null;
              victim = findNpcVictimRow(
                pb.players,
                label.shipId,
                role === "enemy",
                selfTeam,
              );
            }
            if (victim?.killerId != null) {
              const killer = ctx.pbCache.players.find(
                (p) => p.accountId === victim.killerId,
              );
              killerShipId = killer?.shipId ?? null;
              // An AI killer (`:bot:` fill / raw `IDS_*` key) has no
              // readable nickname — the card's ship slot carries it.
              killerName =
                killer && !isAiName(killer.name ?? "") ? killer.name : null;
              // Self-kill: killer and victim share the row (and the side).
              if (killer && victim.team != null && killer.team === victim.team) {
                killerRole = role;
              }
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
          // PvE operations flood the feed with NPC deaths — the ledger
          // lists only HUMAN sink records there (see isAiSinkVictim). The
          // kill bookkeeping above and the score ticks are untouched —
          // this gate is feed-only.
          const victimEntry = ctx.rosterAssignments.get(entityId);
          if (
            !isAiSinkVictim(
              ctx.props.operation,
              label?.scripted,
              victimEntry?.name ?? null,
            )
          ) {
            const feedId = ++ctx.feedSeq;
            ctx.feed.value.unshift({
              kind: "kill",
              id: feedId,
              // The enemy/AI side carries no nickname row — the ship name
              // already says it (an op wave's label IS the ship name, a bot
              // fill reads ":Name:"); only human victims get one.
              text:
                who && !isAiName(who) && who !== (label?.shipName ?? "")
                  ? who
                  : "",
              shipName: label?.shipName ?? "",
              shipType: label?.type ?? null,
              role,
              killerRole,
              killerShipName,
              killerShipType,
              killerName,
            });
            if (ctx.feed.value.length > FEED_CAP) ctx.feed.value.pop();
            window.setTimeout(() => {
              ctx.feed.value = ctx.feed.value.filter((k) => k.id !== feedId);
            }, FEED_TTL_MS);
          }
        }
      }
      continue;
    }
    // Operation fog-of-war (行动): a spotted-then-dark enemy (sample gap
    // past UNSEEN_GAP_S — the same freeze sampleAt holds) hides its live
    // marker and shows the red ghost silhouette at the LAST-KNOWN pose,
    // with a "gone Ns" tag counting from the last sighting. Never-spotted
    // enemies never reach here (hidden by the firstT rule above); PvP and
    // co-op keep the plain freeze (a held live marker, like the in-game
    // minimap). `s.time` is the freeze anchor exactly when the stream is
    // in a gap, so the subtraction IS the dark test.
    if (
      ctx.props.operation &&
      role === "enemy" &&
      tEff - s.time > UNSEEN_GAP_S
    ) {
      if (ghostBox) {
        ghostBox.visible = true;
        ghostBox.position.set(s.x, 0, -s.z);
        ghostBox.rotation.y = Math.PI - s.yaw;
      }
      marker.visible = false;
      // Marker transform stays in sync — it anchors the floating label's
      // projection to the last-known coordinates.
      marker.position.set(s.x, 0, -s.z);
      marker.rotation.y = Math.PI - s.yaw;
      if (label) {
        label.visible = true;
        label.ghostText = i18nT("replay.legend.gone", {
          n: (tEff - s.time).toFixed(0),
        });
        label.status = null;
        const darkHp = hpAtTime(traj.hpSamples, s.time);
        if (darkHp != null) label.hp = darkHp;
      }
      continue;
    }
    marker.visible = true;
    // Submarines carry their real altitude in the sample y (0 = surface,
    // negative = submerged) — place the hull at depth so the 3D scene
    // shows an actual dive under the translucent sea plane. Every other
    // hull sits on the surface (y ≈ 0 in the stream anyway). The label's
    // depth readout mirrors the same sample (content-gated below).
    const markerType = marker.userData.type as string | undefined;
    const isSub = !!markerType && markerType.toLowerCase().includes("submarine");
    const depthY = isSub ? Math.max(-35, Math.min(0, s.y)) : 0;
    marker.position.set(s.x, depthY, -s.z);
    marker.rotation.y = Math.PI - s.yaw;
    // Keep the minimap's heading in sync — userData.yaw must track the
    // playhead, not just the initial load.
    marker.userData.yaw = s.yaw;
    if (label) {
      label.ghostText = null;
      if (contentDue) {
        const currentHp = hpAtTime(traj.hpSamples, tEff);
        if (currentHp != null) label.hp = currentHp;
        // Submerged submarines badge their depth on the floating label
        // (positive meters below surface); surfaced ships clear it.
        label.depthMeters =
          isSub && s.y < -0.5 ? Math.max(1, Math.round(-s.y)) : null;
        // maxHp never changes mid-playback — it is resolved once at actor
        // build from the arena's build health (see actorBuild / shipHp.ts),
        // so there is no per-frame fallback to seed here.
        // Below-hull combat status rows (actions / hits / dots) track the
        // same effective clock — a dying ship freezes at its death instant.
        label.status = shipStatusAt(ctx.shipStatus.get(entityId), tEff);
      }
    }
  }
  // Capture-zone ownership + estimated score at this instant.
  updateCapsAndScore(ctx, t);
  // Repaint the 3D cap rings by live state (owner color, capture pulse).
  // Unborn zones (op points whose EntityCreate time is still ahead of the
  // playhead) keep their ring + letter hidden entirely.
  ctx.capDisplay.value.forEach((c, i) => {
    const ring = ctx.capRings[i];
    if (!ring) return;
    ring.visible = c.live;
    if (!c.live) return;
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
    sprite.visible = c.live;
    if (!c.live) return;
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
    // The OSD ink tone rides in userData (osdContrast flips it between
    // playhead ticks) — a flip invalidates the cached paint immediately.
    const tone = (sprite.userData.tone as OsdTone | undefined) ?? "light";
    const key = `${text}|${etaLine}|${quickEta}|${tone}`;
    if (sprite.userData.text === key) return;
    sprite.userData.text = key;
    paintCapSprite(
      sprite.userData.canvas as HTMLCanvasElement,
      text,
      quickEta || etaLine,
      tone,
    );
    (sprite.material as THREE.SpriteMaterial).map!.needsUpdate = true;
  });
  // Smoke screens: translucent puff discs from the shared instanced pool
  // (actorBuild) + a floating remaining-seconds tag per cluster. Each puff
  // lives [t0, endT] and fades toward the water colour as it dissipates —
  // surface ships and carriers lay identical smoke, and the band now reads
  // as smoke in every view (the 2D painters draw the same puffs).
  {
    const discs = ctx.smokeDiscs;
    let used = 0;
    if (discs) {
      const water = new THREE.Color(
        scenePalette() === SCENE_THEMES.light ? 0xc2d5e4 : 0x071827,
      );
      const smoke = new THREE.Color(0xf3f6f8);
      const fade = new THREE.Color();
      const mat4 = new THREE.Matrix4();
      for (const cl of ctx.smokeClusters) {
        for (const puff of cl.puffs) {
          if (used >= discs.instanceMatrix.count) break;
          if (t < puff.t0 || t > puff.endT) continue;
          // Dissipation: the puff's colour sinks into the water as its
          // lifetime runs out (per-instance alpha is not a thing, so the
          // fade rides the instance colour — reads the same on both
          // themes because the target IS the water tone).
          const life = Math.max(1, puff.endT - puff.t0);
          const gone = Math.min(1, Math.max(0, (t - puff.t0) / life));
          fade.copy(smoke).lerp(water, gone * 0.85);
          discs.setColorAt(used, fade);
          mat4.makeScale(45, 1, 45);
          mat4.setPosition(puff.x, 0.8, -puff.z);
          discs.setMatrixAt(used, mat4);
          used++;
        }
      }
      discs.count = used;
      discs.instanceMatrix.needsUpdate = true;
      if (discs.instanceColor) discs.instanceColor.needsUpdate = true;
      discs.visible = used > 0;
    }
    for (const cl of ctx.smokeClusters) {
      const hideSprite = () => {
        if (cl.timeSprite) cl.timeSprite.visible = false;
      };
      if (t < cl.t0 || t > cl.endT) {
        hideSprite();
        continue;
      }
      // Countdown tag parks at the cluster start (the band's head puff).
      const pStart = cl.puffs.length > 0 ? cl.puffs[0] : null;
      if (!pStart) {
        hideSprite();
        continue;
      }
      const sprite = cl.timeSprite;
      if (sprite) {
        const secs = Math.ceil(cl.endT - t);
        const text = `${secs}s`;
        // Ink tone lives in userData.tone — osdContrast flips and repaints it
        // between playhead ticks; this repaint picks up whichever tone is
        // current whenever the countdown text itself changes.
        const tone = (sprite.userData.tone as OsdTone | undefined) ?? "light";
        if (sprite.userData.text !== text) {
          sprite.userData.text = text;
          paintSmokeCountdown(sprite.userData.canvas as HTMLCanvasElement, text, tone);
          (sprite.material as THREE.SpriteMaterial).map!.needsUpdate = true;
        }
        sprite.position.set(pStart.x, 34, -pStart.z);
        sprite.visible = true;
      }
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
    const activeSlots = ctx.planeCloudActive;
    if (activeSlots.length > 0) activeSlots.fill(0);
    let anyPoints = false;
    // Formation anchors: index-0 trail of each planeId (eased position +
    // yaw), alive between its first update and one shared grace window
    // after the last one (PLANE_TRAIL_GRACE_S, also used by the follow
    // target). Reused scratch map — the old code allocated a fresh Map
    // per tick.
    const formationAnchor = ctx.planeAnchorScratch;
    formationAnchor.clear();
    for (const trail of ctx.planeTrails) {
      const planeId = Math.floor(trail.id / 16);
      if (trail.id % 16 !== 0) continue;
      const s = easedAnchorAt(
        trail.samples,
        t,
        planeId,
        ctx.planeAnchorAnim,
      );
      if (!s) continue;
      const born = trail.samples[0].time;
      const expiry = planeTrailExpiry(
        trail.samples[trail.samples.length - 1].time,
        ctx.minimapTrailEnd.get(planeId),
      );
      if (t >= born && t <= expiry) {
        formationAnchor.set(planeId, { s, born, expiry });
      }
    }
    // Recorded PLANE-camera segment: exactly ONE formation rides the lens —
    // the recorder's own sortie nearest the recorded camera (a carrier can
    // have several flights airborne; hanging them all at the same 80-unit
    // point stacked them). Falls back to the nearest formation of any side
    // when the own carrier's role never resolved (missing minimap owner →
    // planes default to enemy), so the lens segment still shows aircraft
    // instead of the old near-plane shards.
    let lensFormationId: number | null = null;
    let lensPose: ReturnType<typeof recordedCameraAt> = null;
    // planeLensRide: true = inside a recorded plane-camera segment, false =
    // a ship/shell-camera segment, null = the replay has no 0x27 mode stream
    // (fall back to proximity).
    const lensMode = ctx.planeRecordedView === true ? ctx.planeLensRide : false;
    if (lensMode !== false) {
      lensPose = recordedCameraAt(ctx, t);
      if (lensPose) {
        let bestSelf: { id: number; d: number } | null = null;
        let bestAny: { id: number; d: number } | null = null;
        for (const [pid, a] of formationAnchor) {
          // Anchor samples are world coords; the pose is scene (z mirrored).
          const d = Math.hypot(a.s.x - lensPose.x, a.s.z + lensPose.z);
          if (!bestAny || d < bestAny.d) bestAny = { id: pid, d };
          if (ctx.planeRoleById.get(pid) !== "self") continue;
          if (!bestSelf || d < bestSelf.d) bestSelf = { id: pid, d };
        }
        // Prefer our own sortie, but don't drag a far own formation onto
        // the lens when a much closer ally squadron is what the recorded
        // plane camera was actually following (a spectated clip): only
        // prefer self while it is in the same neighbourhood.
        const preferSelf =
          bestSelf != null &&
          (bestAny == null || bestSelf.d <= bestAny.d * 1.5 + 20);
        const chosen = preferSelf ? bestSelf : (bestAny ?? bestSelf);
        // Replays WITHOUT the 0x27 camera-mode stream cannot name the
        // segment; infer the plane-camera ride from proximity — the plane
        // camera sits within a few units of the squadron it follows.
        if (chosen && (lensMode !== null || chosen.d <= RECORDED_LENS_PROXIMITY)) {
          lensFormationId = chosen.id;
        }
      }
    }
    for (const [planeId, anchor] of formationAnchor) {
      const pool = ctx.planeMeshes.get(planeId);
      const formation = ctx.planeFormations.get(planeId);
      // The RENDERED count is the squadron's live flying strength (the
      // planesHealth digit count at t — a death drops one digit), NOT the
      // static launch/pool size: the user reported squadrons showing their
      // full wedge long after losses. Pre-E27 replays carry no such stream
      // and fall back to the static count, unchanged.
      const liveCount = squadronFlyingAt(
        ctx.squadronStates?.planesHealth,
        planeId,
        t,
      );
      const total = liveCount ?? formation?.count ?? 3;
      const gCount = formation?.groupCount ?? total;
      const gSize = formation?.groupSize ?? 1;
      // Filled-wedge layout over flight groups (leader front, groups
      // stepping back 1-2-3-…, leftover groups centered in the last row).
      // Slot layout must cover the live count even when losses make it
      // exceed the inferred launch grouping (the offsets describe the full
      // wedge; we simply render the first n of it).
      const offsets = formationOffsets(
        Math.max(gCount, Math.ceil(total / Math.max(1, gSize))),
        gSize,
      );
      const n = Math.min(total, offsets.length);
      // RECORDED VIEW: while the replay's OWN camera is the applied view, the
      // wedge hangs AHEAD of the recorded lens on its interpolated view axis,
      // with the recorded heading, instead of orbiting a synthetic circle —
      // the recorded camera framed the real formation, so the orbit planted
      // every model outside its view (user report: original camera mode
      // showed no aircraft). The anchor is also the only FRESH data late in
      // a sortie: the 3D stream often stops at launch while the minimap
      // centre track keeps running (buildPlaneTrails pads the anchor trail
      // with it), whereas per-plane 3D poses would still be stale launch
      // samples hundreds of units apart.
      //
      // Why AHEAD instead of AT the anchor: the recorder flew a PLANE
      // camera, so the stream's centre track sits ~at the lens — the wedge
      // placed there engulfed the camera (models at ~zero distance → the
      // near-plane shards the user read as broken triangles) and the
      // minimap-rate anchor made it twitch. recordedCameraAt also
      // interpolates the ~10 Hz camera stream, which is what removed the
      // follow-camera stutter.
      const recorded = ctx.planeRecordedView === true;
      // ONLY the one formation the recorded plane camera rides hangs ahead
      // of the lens (see the pre-pass above): hanging EVERY formation there
      // piled own/ally/enemy squadrons into the same screen spot (user
      // report: mixed-colour aircraft glued in front of the camera), and
      // doing it in a SHIP-camera segment pasted the player's aircraft onto
      // a view that never framed them. Everything else stays on its real
      // recorded anchor.
      const ownSquadron = lensFormationId != null && planeId === lensFormationId;
      const pose = ownSquadron ? lensPose : null;
      const camFwd = pose ? recordedCameraForward(pose) : null;
      // Slow circle so airborne squadrons visibly hold a patrol orbit.
      const ang = t * 0.22 + (planeId % 7) * 0.9;
      const R = 50;
      // Heading follows the patrol-circle TANGENT (the direction the
      // formation is actually moving) so the wedge turns as it orbits
      // instead of sliding sideways pointing at a fixed heading. The
      // recorded view uses the squadron's RECORDED heading (the eased
      // minimap-track direction, same convention as the 3D airframe yaw):
      // the recorder's camera turns and banks independently of the
      // formation, so hanging the wedge on the camera axis instead made it
      // look pasted to the lens (user report: "it just faces the camera and
      // never moves when it circles").
      const yaw = recorded
        ? anchor.s.yaw
        : Math.atan2(-Math.sin(ang), Math.cos(ang));
      const fwd = { x: Math.sin(yaw), z: -Math.cos(yaw) };
      const right = { x: Math.cos(yaw), z: Math.sin(yaw) };
      // Orbit CENTRE = the formation's geometric centroid (not the lead
      // plane) — a filled wedge visibly spins around its middle, like the
      // in-game flight circle. The centroid sits at the anchor plus the
      // (heading-rotated) mean offset of all aircraft.
      const cxm = offsets.reduce((a, o) => a + o.ox, 0) / Math.max(1, offsets.length);
      const czm = offsets.reduce((a, o) => a + o.oz, 0) / Math.max(1, offsets.length);
      let cx: number;
      let cz: number;
      let yBase: number;
      if (pose && camFwd) {
        // Clearance from the CLOSEST slot: the placement writes each slot's
        // offset as (ox, oz) in scene space, so projecting those on the
        // camera's view axis gives how far behind the wedge centroid it
        // sits. RECORDED_PLANE_PAD is the nearest slot's distance.
        let mostBehind = 0;
        for (const o of offsets) {
          const ox = (o.ox - cxm) * right.x + (o.oz - czm) * fwd.x;
          const oz = (o.ox - cxm) * right.z + (o.oz - czm) * fwd.z;
          const ahead = ox * camFwd.x + oz * camFwd.z;
          if (ahead < mostBehind) mostBehind = ahead;
        }
        const dist = RECORDED_PLANE_PAD - mostBehind;
        cx = pose.x + camFwd.x * dist;
        // The slot loop writes scene z as -cz + oz (the scene mirrors the
        // recorded z), so the centroid's scene z carries that mirror here.
        cz = -(pose.z + camFwd.z * dist);
        // A steeply pitched recorder camera would otherwise drag the wedge
        // through the sea plane (the 15.8 fixture's camera is essentially
        // level, but the plane-camera segments of other builds are not).
        yBase = Math.max(2, pose.y + camFwd.y * dist);
      } else {
        const ccx = anchor.s.x + cxm * right.x + czm * fwd.x;
        const ccz = anchor.s.z + cxm * right.z + czm * fwd.z;
        cx = recorded ? anchor.s.x : ccx + Math.cos(ang) * R;
        cz = recorded ? anchor.s.z : ccz + Math.sin(ang) * R;
        // Replays without 0x25 frames fall back to the anchor's altitude
        // (below-sea guarded); the free/follow orbit keeps the 60 m patrol
        // floor.
        yBase = recorded ? Math.max(0, anchor.s.y) : Math.max(60, anchor.s.y);
      }
      if (pool && pool.length >= n) {
        for (let i = 0; i < n; i++) {
          const mesh = pool[i];
          mesh.visible = true;
          const o = offsets[i];
          const ox = (o.ox - cxm) * right.x + (o.oz - czm) * fwd.x;
          const oz = (o.ox - cxm) * right.z + (o.oz - czm) * fwd.z;
          const yOff = (i % 3) * 2 - 2; // -2 / 0 / +2 alternating
          mesh.position.set(cx + ox, yBase + yOff, -cz + oz);
          // The placement convention assumes the model's nose/bow along
          // local +Z, and the plane GLBs are baked that way too: the
          // z-slice profile of PAAB001 has the thin vertical fin at local
          // −Z and the propeller disc (dense, symmetric around the hub) at
          // +Z, with the wing centre ~70 % of the way aft. The old extra
          // π here flew every aircraft TAIL-FIRST (and made the follow
          // camera's yaw derivation — followTargets assumes rotation.y =
          // π − yaw — point the wrong way by 180°).
          mesh.rotation.y = Math.PI - yaw;
        }
        // Park the SURPLUS slots of this still-anchored formation. The pool
        // is sized to the LAUNCH strength (slots never shrink mid-replay),
        // so a squadron that lost planes keeps slots n..count-1 in the pose
        // their last full-strength tick gave them — visible, and standing
        // exactly where a wingman used to be. Rendering "the first n" is
        // only half the count contract; the rest must go dark, or a
        // 3-plane squadron still draws all six models (user report: the
        // wedge never thinned out as planes were shot down).
        for (let i = n; i < pool.length; i++) pool[i].visible = false;
      } else {
        // No model pool (yet): fall back to a point at the centroid (in the
        // recorded view that centroid IS the recorded anchor pose).
        const cloudSlot = ctx.planeCloudSlots.get(planeId);
        if (arr && cloudSlot != null) {
          arr[cloudSlot * 3] = cx;
          arr[cloudSlot * 3 + 1] = yBase;
          arr[cloudSlot * 3 + 2] = -cz;
          if (activeSlots.length > 0) activeSlots[cloudSlot] = 1;
          anyPoints = true;
        }
      }
    }
    // Park every slot NOT written this tick deep below the sea. Without
    // this, a squadron that expired (shot down / recalled / trail end)
    // left its dot frozen at the last centroid for the rest of the replay
    // — a growing graveyard of red/green dots — and never-launched slots
    // stacked at the world origin. Parked dots sit under the seabed, out
    // of every camera angle (the orbit never dips below the horizon).
    if (arr && activeSlots.length > 0) {
      for (let s = 0; s < activeSlots.length; s++) {
        if (activeSlots[s] === 0) arr[s * 3 + 1] = PLANE_DOT_PARKED_Y;
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
    // Cone or swapped GLB — tint whatever material it now wears. The trail
    // line is NOT tinted here: its color attribute carries both the ammo
    // tint and the per-vertex alpha gradient written below.
    slot.shell.traverse((child) => {
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (mat && mat.color) mat.color.setHex(st.color);
    });
    slot.line.visible = true;
    slot.shell.visible = true;
    {
      // Shell position + orientation first — the trail's alpha gradient is
      // anchored to the flight progress k. (t1 == t0 would be a 0/0 NaN on
      // a zero-length flight; clamp to the launch point instead.)
      const k = st.t1 > st.t0 ? Math.min(1, Math.max(0, (t - st.t0) / (st.t1 - st.t0))) : 0;
      const head = arcPoint(k);
      slot.shell.position.set(head.x, head.y, head.z);
      const p2 = arcPoint(Math.min(1, k + 0.03));
      const tx = p2.x - head.x;
      const ty = p2.y - head.y;
      const tz = p2.z - head.z;
      const len = Math.hypot(tx, ty, tz) || 1;
      ctx._shellDir.set(tx / len, ty / len, tz / len);
      slot.shell.quaternion.setFromUnitVectors(ctx._shellUp, ctx._shellDir);
      // Rewrite the arc: positions + per-vertex tint (RGB = ammo color,
      // alpha = shellTrailAlpha: 10% ghost along the whole path, ramping to
      // 50% at the shell's current position and back to 10% 5% behind it).
      const attr = slot.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const tintAttr = slot.line.geometry.getAttribute("color") as THREE.BufferAttribute;
      const tint = tintAttr.array as Float32Array;
      const c = trailTint.setHex(st.color);
      for (let i = 0; i < SHELL_TRACE_SAMPLES; i++) {
        const s = i / (SHELL_TRACE_SAMPLES - 1);
        const q = arcPoint(s);
        arr[i * 3] = q.x;
        arr[i * 3 + 1] = q.y;
        arr[i * 3 + 2] = q.z;
        tint[i * 4] = c.r;
        tint[i * 4 + 1] = c.g;
        tint[i * 4 + 2] = c.b;
        tint[i * 4 + 3] = shellTrailAlpha(s, k);
      }
      attr.needsUpdate = true;
      tintAttr.needsUpdate = true;
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
      ctx._wakeTail.copy(tm.dir).multiplyScalar(40);
      wakeAttr.setXYZ(0, p.x - ctx._wakeTail.x, 0.4, p.z - ctx._wakeTail.z);
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
    // Latest lock at or before the playhead — a scan, not a filter, so no
    // throwaway array is allocated per tick.
    let last: WeaponLockEvent | null = null;
    for (const l of ctx.props.weaponLocks) {
      if (l.time <= t) last = l;
    }
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
  // show while any of its squadrons is in the air (visible window = first
  // update .. one PLANE_TRAIL_GRACE_S past the last update, capped by the
  // minimap remove event).
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
        // Aircraft have no "sunk" state — planes are simply gone when
        // shot down, so the card never shows the ship's dead tag.
        label.dead = false;
      }
      // HP is the SQUADRON's, not the carrier's: this card floats over the
      // aircraft, so it must answer "how hurt are the planes and how many
      // are still flying" (user request). The airborne squadron tracked by
      // this carrier label decides it: its live flying count (planesHealth
      // digits) and its total-HP fraction (squadronHealth), rendered as a
      // 0..1 bar — the same numbers the follow pill shows. A carrier whose
      // squadron stream is missing (pre-E27 replay) keeps the ship values
      // as the honest fallback.
      const squadronId = (() => {
        for (const [planeId, labelOf] of ctx.planeLabelOfPlane) {
          if (labelOf !== labelId) continue;
          const trail = ctx.planeTrails.find((tr) => Math.floor(tr.id / 16) === planeId);
          if (!trail || trail.samples.length === 0) continue;
          const expiry = planeTrailExpiry(
            trail.samples[trail.samples.length - 1].time,
            ctx.minimapTrailEnd.get(planeId),
          );
          if (t >= trail.samples[0].time && t <= expiry) return planeId;
        }
        return null;
      })();
      const squadronFrac =
        squadronId == null
          ? null
          : lastSquadronEventAt(ctx.squadronStates?.health, squadronId, t)?.hp ?? null;
      const flying =
        squadronId == null ? null : squadronFlyingAt(ctx.squadronStates?.planesHealth, squadronId, t);
      if (carrierLabel && squadronFrac == null) {
        label.hp = carrierLabel.hp;
        label.maxHp = carrierLabel.maxHp;
      } else {
        // hp/maxHp are the generic 0..1 bar the label renderer already
        // understands (0.62 = 62%); the planes row rides the status slot.
        label.hp = squadronFrac;
        label.maxHp = squadronFrac == null ? null : 1;
      }
      // The flying count has no slot in ShipStatusSnapshot (that shape is
      // the below-hull combat chip row) — it rides the label's planeCard
      // helper field, which the label renderer prints next to the type.
      label.planeAlive = flying;
      // Any of this carrier's squadrons airborne?
      let visible = false;
      for (const [planeId, labelOf] of ctx.planeLabelOfPlane) {
        if (labelOf !== labelId) continue;
        const trail = ctx.planeTrails.find((tr) => Math.floor(tr.id / 16) === planeId);
        if (!trail || trail.samples.length === 0) continue;
        const first = trail.samples[0].time;
        const last = trail.samples[trail.samples.length - 1].time;
        // Squadron is gone one grace window after its last sample — no
        // lingering labels (the SAME planeTrailExpiry every aircraft surface
        // reads, including the minimap remove event).
        const expiry = planeTrailExpiry(last, ctx.minimapTrailEnd.get(planeId));
        if (t >= first && t <= expiry) {
          visible = true;
          break;
        }
      }
      label.visible = visible;
    }
  }
  // The scene RAF loop (HolographicMap's onFrame) refreshes the floating
  // labels and the 3D range rings every frame — including while paused, so
  // they stay glued to the camera there. Duplicating them here ran both
  // twice per playback frame for no visual gain.
  // The cyclone's dark core drifts across the sea (3D twin of the minimap
  // weather overlay — same geometry, same per-match drift seed).
  updateStormZone(ctx, t);
  // 3D movement-advice arrows (E18): re-synced on every marker refresh so
  // they follow the ships through playback and seeks alike; when a fresh
  // report lands between playhead steps, HolographicMap calls this directly.
  syncMoveAdvisories(ctx);
  // The render loop may be idle-gated (paused + still camera): a playhead
  // step or an async model install changed the scene, so make sure the
  // next uncapped tick repaints.
  ctx.api.value?.requestRender();
}
