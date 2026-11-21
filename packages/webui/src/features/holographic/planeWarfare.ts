/**
 * Aircraft squadron construction, extracted verbatim from the heart of
 * HolographicMap.tsx's rebuildActors: the per-plane trail table (3D aerial
 * stream + minimap stream merge), the Points fallback cloud, the per-
 * formation GLB model pools, and the carrier-label/role resolution that
 * re-tints everything once controlling ships are known.
 */
import * as THREE from "three";
import { PLANE_TYPES, planeFullStrength } from "./tactical/shellTypes";
import {
  groupSizeOfParams,
  planeTrailExpiry,
  squadronReturningSince,
  type CarrierTrackLike,
} from "./planeFormation";
import { buildPropMarker } from "./propMarker";
import { planeForwardSign, resolvePlaneModelUrl } from "./modelLoader";
import { sampleAt } from "./trajectoryMath";
import { inferGrouping } from "./planeFormation";
import { TEAM_COLOR, type TeamRole } from "./teamColors";
import type { MapInternals } from "./mapInternals";
import type { ShipLabel } from "./shipLabel";
import {
  FIGHTER_PATROL_CONSUMABLE_IDS,
  consumableWindows,
  lastConsumableUseAt,
} from "./consumableRoles";
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
    const type = info?.type;
    const index = info?.index;
    for (let i = 0; i < 16; i++) {
      const key = planeId * 16 + i;
      if (info?.role) ctx.planeRoleByTrail?.set(key, info.role);
      // Last DEFINED writer wins, per map: both streams carry the same
      // paramsId per planeId in practice, but a table MISS writes NO value
      // at all. Two reasons: the minimap stream (run last) could otherwise
      // downgrade a good family the create stream had just resolved, and a
      // manufactured default is a WRONG family — the "attack" fallback made
      // every unresolvable airframe (a scout whose paramsId the table does
      // not carry) paint the attack/skip-bomber icon, the reported
      // "scout renders as a bomber" defect. A missing family stays missing:
      // consumers repeat their own `?? "attack"` fallback for the ICON, while
      // the card keeps the wing's last KNOWN family (markerUpdate) instead of
      // silently claiming one.
      if (type) ctx.planeTypesById.set(key, type);
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

/** Airframe-index marker of a CATAPULT-launched scout / spotter: the baked
 *  GameParams indices spell the role into the index itself — P + nation
 *  letter + role letters, the scout role being `AS` (PJAS011_Nakajima_E8N,
 *  PSAS022_IMAM_RO42, PBAS001_Walrus, PAAS014_Vought_OS2U, PXAS001_...).
 *  The strike families spell `AD` / `AB` / `AF` instead (PJAD902, PJAB208,
 *  PJAF408), so the test never swallows a strike wing.
 *
 *  This is the FALLBACK half of the scout rule, not a replacement: the baked
 *  `type` column is the primary source, but a row whose family came from the
 *  GameParams species (the legacy bakes typed torpedo airframes "bomber") or
 *  a row the bake missed can otherwise sail past the scout exclusion and paint
 *  the wrong card — the "疑似侦察机却显示为轰炸机" report. */
export function isScoutAirframeIndex(index: string | null | undefined): boolean {
  if (!index) return false;
  return /^P[A-Z]AS\d/.test(index);
}

/** Whether the paramsId's table row is an ASW (depth-charge) wing — its
 *  family reads "dive" but its ROLE is "asw", and a cruiser/BB's
 *  depth-charge wing is a utility wing that never rides the aircraft card
 *  (the same rule as the scout exclusion; the round-6 sighting report). */
export function isAswParamsId(paramsId: number | null | undefined): boolean {
  const row = paramsId == null ? undefined : PLANE_TYPES[String(paramsId)];
  return row?.role === "asw";
}

/** Whether the wing a planeId names is an ASW wing (the role the trail build
 *  recorded per trail key). */
export function isAswWing(
  ctx: Pick<MapInternals, "planeRoleByTrail">,
  planeId: number,
): boolean {
  return ctx.planeRoleByTrail?.get(planeId * 16) === "asw";
}

/** Whether a GameParams paramsId names a CATAPULT-launched scout / spotter
 *  wing (the `scout` plane family: the PJAS / P★AS single-plane squadrons). Those
 *  wings carry NO floating card of their own — the requirement is that the
 *  parent hull's label reports the consumable instead ("侦察机消耗品放出来的
 * 飞机都不需要带标签"). Unknown paramsIds answer false (an unknown wing keeps
 *  the historical card). */
export function isScoutParamsId(paramsId: number | null | undefined): boolean {
  if (paramsId == null) return false;
  const row = PLANE_TYPES[String(paramsId)];
  if (!row) return false;
  return row.type === "scout" || isScoutAirframeIndex(row.index);
}

/** Whether the wing a planeId names is a scout wing (same test, resolved
 *  through the type table the trail build already filled). */
export function isScoutWing(
  ctx: Pick<MapInternals, "planeTypesById">,
  planeId: number,
): boolean {
  return ctx.planeTypesById?.get(planeId * 16) === "scout";
}

/** How long a NEWER wing must have been airborne before it may take the
 *  aircraft card away from an older wing that is still flying (seconds).
 *  The card's per-tick family follow rides the pick this gate returns;
 *  without it a wing that appears mid-air for a couple of seconds (a
 *  re-created survivor group, a scout/ward hand-off) became the "newest
 *  launch", flashed its own family over the card and vanished again — the
 *  "出现一下就又消失了" report. 3 s is the hysteresis the flight groups
 *  need to be told apart from a launch: every genuine sortie in the
 *  reference captures flies far longer than this, while the short-lived
 *  re-created groups live 1.9–3.4 s.
 */
export const WING_CARD_STICKY_S = 3;

/** One candidate for the aircraft card's wing. */
export interface WingRideCandidate {
  planeId: number;
  /** First decoded sample — the wing's launch. */
  born: number;
  /** Last decoded sample. Past it the wing is inside planeTrailExpiry's GRACE
   *  window: it may KEEP the card it already has (the historical 5 s linger),
   *  but it must not TAKE it over — a wing whose stream has stopped is landing
   *  or already gone, and the whole point of the gate is that such a wing's
   *  family never flashes over the card. */
  lastSample: number;
}

/** The wing a card should ride among `candidates` at `t` — PURE, so the
 *  answer is a function of (candidates, t) alone and scrubbing backwards
 *  lands on exactly the same wing as playing forwards.
 *
 *  The newest candidate wins ONLY once it has been airborne for `stickyS`
 *  AND is still streaming (see WingRideCandidate.lastSample): while a newly
 *  appeared wing is still inside either window the older still-airborne wing
 *  keeps the card (hysteresis). When nothing qualifies — the carrier's first
 *  sortie, or the first wing after a gap — the OLDEST live candidate answers,
 *  so the card never waits 3 s to appear for a wing that has no competitor. */
export function stableWingPick(
  candidates: readonly WingRideCandidate[],
  t: number,
  stickyS: number = WING_CARD_STICKY_S,
): number | null {
  let oldest: WingRideCandidate | null = null;
  let chosen: WingRideCandidate | null = null;
  for (const c of candidates) {
    if (oldest == null || c.born < oldest.born) oldest = c;
    // A takeover needs BOTH: the wing has flown for the hysteresis window AND
    // its stream is still live at t (see WingRideCandidate.lastSample).
    if (t - c.born >= stickyS && t <= c.lastSample && (chosen == null || c.born > chosen.born)) {
      chosen = c;
    }
  }
  return (chosen ?? oldest)?.planeId ?? null;
}

/** Every wing of `carrierId` that may carry the floating card at `t`:
 *  airborne inside the shared planeTrailExpiry window, NOT homeward-bound
 *  (a returning wing keeps its model but loses the card) and NOT a scout
 *  (a catapult spotter belongs to its hull's consumable chip). Wings
 *  outside those rules are not "sensible picks" and never win, so a
 *  wrong-family card can no longer appear for one tick and vanish.
 *
 *  Candidates come back in planeTrail order; stableWingPick is
 *  order-independent (it compares born times), so the caller may sort or
 *  not. */
export function cardRideCandidates(
  ctx: Pick<
    MapInternals,
    | "planeTrails"
    | "minimapTrailEnd"
    | "planeCarrierOf"
    | "trajById"
    | "planeTypesById"
    | "planeRoleByTrail"
  >,
  carrierId: number,
  t: number,
): WingRideCandidate[] {
  const out: WingRideCandidate[] = [];
  for (const trail of ctx.planeTrails ?? []) {
    // Only the formation's index-0 anchor speaks for the squadron; the
    // wingmen trails share its lifetime (same rule as activeSquadronOf).
    if (trail.id % 16 !== 0) continue;
    const planeId = Math.floor(trail.id / 16);
    if (ctx.planeCarrierOf?.get(planeId) !== carrierId) continue;
    const samples = trail.samples;
    if (samples.length === 0) continue;
    const born = samples[0].time;
    const last = samples[samples.length - 1].time;
    const expiry = planeTrailExpiry(last, ctx.minimapTrailEnd?.get(planeId));
    if (t < born || t > expiry) continue;
    if (isScoutWing(ctx, planeId)) continue;
    if (isAswWing(ctx, planeId)) continue;
    if (planeReturningAt(ctx, trail, t)) continue;
    out.push({ planeId, born, lastSample: last });
  }
  return out;
}

/** The wing a carrier's aircraft card describes at `t` (its position anchor
 *  AND its content: family, ✈N, HP source). Null when the carrier has
 *  nothing sensible up. One rule for the position pass (labelOverlay) and the
 *  content pass (markerUpdate), so the two can never describe different
 *  sorties. */
export function cardWingAt(
  ctx: Pick<
    MapInternals,
    | "planeTrails"
    | "minimapTrailEnd"
    | "planeCarrierOf"
    | "trajById"
    | "planeTypesById"
    | "planeRoleByTrail"
    | "planeLabelCarriers"
  >,
  labelId: number,
  t: number,
): number | null {
  const carrierId = ctx.planeLabelCarriers?.get(labelId);
  if (carrierId == null) return null;
  return stableWingPick(cardRideCandidates(ctx, Number(carrierId), t), t);
}

/** One fighter-patrol anchor of a carrier's aircraft card (user requirement
 *  2026-11-21: the WARD fighter has a DEPLOYMENT phase — the consumable fired,
 *  the wing is not on station yet — so the card must show a countdown AT the
 *  patrol area, with no HP bar; once the wing arrives it stays pinned to the
 *  patrol circle instead of following the individual planes). */
export interface PlaneWardAnchor {
  /** Ward centre in WORLD coordinates (x/y/z; y is the patrol altitude). */
  x: number;
  y: number;
  z: number;
  /** Deployment start: the fighter consumable that launched this patrol, or
   *  the ward's own add time when the replay carries no matching use. */
  t0: number;
  /** Arrival on station = the wing's first decoded sample (or its minimap
   *  add). The countdown runs [t0, arriveAt). */
  arriveAt: number;
  /** End of the station window (ward remove, else the wing's last sample +
   *  the shared trail grace); Infinity when neither is known. */
  t1: number;
  /** The wing the ward names (joins planeTrails / paramsId). */
  planeId: number;
  /** The wing's plane family ("fighter" for a WARD patrol). */
  planeType: string | null;
}

/** A fighter consumable fires this long before the ward appears at most: real
 *  deployments measured 0.7–15 s on the reference capture (the carrier
 *  launches, the wing flies to the patrol point, the server adds the ring).
 *  A use older than this is a previous patrol, not this ward's deployment. */
const DEPLOY_LOOKBACK_S = 60;
/** Grace past the wing's last decoded sample before the circle anchor ends
 *  (same order as the shared plane-trail expiry window). */
const WARD_WING_GRACE_S = 5;

/** Resolve every carrier's fighter-patrol anchors into
 *  `ctx.planeWardAnchors` (label id → anchors, one per ward of that carrier).
 *  Called once per actor rebuild from resolvePlaneCarriers, after the label
 *  ids and the type tables exist. Pure data joins over the decoded streams —
 *  no per-frame work. */
export function buildPlaneWardAnchors(ctx: MapInternals) {
  ctx.planeWardAnchors.clear();
  const wards = ctx.props.wards;
  if (!wards || wards.length === 0) return;
  // Per-plane spans: the ARRIVAL is the first 3D airborne sample (the minimap
  // add fires at LAUNCH, i.e. while the wing is still flying out — that is the
  // deployment's start side, not its end), while the minimap centre track only
  // extends the END (a sparse 3D stream stops early on real captures).
  const span = new Map<number, { first3d: number | null; last: number | null }>();
  const note = (planeId: number, t: number, airborne: boolean) => {
    const e = span.get(planeId) ?? { first3d: null, last: null };
    if (airborne && (e.first3d == null || t < e.first3d)) e.first3d = t;
    if (e.last == null || t > e.last) e.last = t;
    span.set(planeId, e);
  };
  for (const tr of ctx.planeTrails ?? []) {
    const planeId = Math.floor(tr.id / 16);
    for (const s of tr.samples) note(planeId, s.time, true);
  }
  for (const a of ctx.props.minimapSquadronAdds ?? []) note(a.planeId, a.time, false);
  for (const m of ctx.props.minimapSquadronMoves ?? []) note(m.planeId, m.time, false);
  const paramsById = new Map<number, number>();
  for (const c of ctx.props.squadronCreates ?? []) {
    if (!paramsById.has(c.planeId)) paramsById.set(c.planeId, c.paramsId);
  }
  for (const a of ctx.props.minimapSquadronAdds ?? []) {
    if (!paramsById.has(a.planeId)) paramsById.set(a.planeId, a.paramsId);
  }
  for (const w of wards) {
    const labelId = PLANE_CARD_LABEL_ID_BASE + Number(w.ownerId);
    if (!ctx.planeLabelCarriers.has(labelId)) continue;
    // The wing's own first sample is the arrival: the ward add fires at (or
    // a sub-second before) the ring's planes appear.
    const s = span.get(w.squadronId) ?? null;
    const arriveAt =
      s?.first3d != null && s.first3d >= w.time - 2 ? s.first3d : w.time;
    let t1: number = Number.POSITIVE_INFINITY;
    for (const rm of ctx.props.wardRemoves ?? []) {
      if (rm.planeId !== w.squadronId || rm.time <= w.time) continue;
      if (rm.time < t1) t1 = rm.time;
    }
    if (s?.last != null) t1 = Math.min(t1, s.last + WARD_WING_GRACE_S);
    // Deployment window: the fighter consumable that launched this patrol.
    const windows = consumableWindows(
      ctx.props.consumableUses,
      Number(w.ownerId),
      FIGHTER_PATROL_CONSUMABLE_IDS,
    );
    const use = lastConsumableUseAt(windows, arriveAt);
    const t0 =
      use != null && arriveAt - use.t0 <= DEPLOY_LOOKBACK_S ? use.t0 : w.time;
    const paramsId = paramsById.get(w.squadronId);
    const anchor: PlaneWardAnchor = {
      x: w.x,
      y: w.y,
      z: w.z,
      t0: Math.min(t0, arriveAt),
      arriveAt,
      t1: Math.max(t1, arriveAt),
      planeId: w.squadronId,
      planeType: paramsId != null ? (PLANE_TYPES[String(paramsId)]?.type ?? null) : null,
    };
    const list = ctx.planeWardAnchors.get(labelId);
    if (list) list.push(anchor);
    else ctx.planeWardAnchors.set(labelId, [anchor]);
  }
  for (const list of ctx.planeWardAnchors.values()) list.sort((a, b) => a.t0 - b.t0);
}

/** The anchor a carrier's aircraft card sits on at `t`: the newest ward whose
 *  [t0, t1) window covers the playhead, or null (the card then follows the
 *  current wing as before). */
export function wardAnchorAt(
  ctx: MapInternals,
  labelId: number,
  t: number,
): PlaneWardAnchor | null {
  const list = ctx.planeWardAnchors?.get(labelId);
  if (!list || list.length === 0) return null;
  let best: PlaneWardAnchor | null = null;
  for (const a of list) {
    if (t < a.t0) break;
    if (t <= a.t1) best = a;
  }
  return best;
}

/** The ward anchor the card may USE at `t`, or null when the card must keep
 *  following `picked` (the carrier's current wing):
 *
 *  - inside the DEPLOYMENT window ([t0, arriveAt)) the card always sits on
 *    the patrol circle: the wing the carrier just launched is still flying
 *    out, and the requirement is a countdown AT the area, with no HP bar;
 *  - on station it sits on the circle only while `picked` IS the wing
 *    manning that ward — a torpedo/bomber sortie keeps its own anchor. */
export function wardCardAnchor(
  ctx: MapInternals,
  labelId: number,
  picked: number | null | undefined,
  t: number,
): PlaneWardAnchor | null {
  const anchor = wardAnchorAt(ctx, labelId, t);
  if (!anchor) return null;
  if (t < anchor.arriveAt) return anchor;
  return picked === anchor.planeId ? anchor : null;
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
    // Full wing strength per planeId (the hangar total): the HUD's
    // denominator and the panel's slot count, so a partial launch keeps its
    // missing planes as dead cells instead of shrinking the grid
    // (2026-11-12 review).
    const fullOf = new Map<number, number>();
    const paramsOf = new Map<number, number>();
    for (const c of ctx.props.squadronCreates) {
      const n = c.numPlanes ?? c.totalNumPlanes ?? 0;
      const prev = launchOf.get(c.planeId) ?? 0;
      if (n > prev) launchOf.set(c.planeId, n);
      // The wing's FULL strength is a property of the AIRFRAME (the GameParams
      // count, i.e. plane_specs' squadron field), not of this launch: a
      // depleted hangar may launch 4 of 12, but the panel must still read 12
      // slots with eight grey (2026-11-12 review: 全部都按满编组来，而且是按
      // 该机种的角度). The decoded totalNumPlanes stays the floor for airframes
      // the table does not know.
      const airframe = planeFullStrength(c.paramsId);
      const full = Math.max(
        airframe ?? 0,
        c.totalNumPlanes ?? 0,
        c.numPlanes ?? 0,
      );
      if (full > (fullOf.get(c.planeId) ?? 0)) fullOf.set(c.planeId, full);
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
        ctx.planeFormations.set(planeId, {
          count,
          full: Math.max(count, fullOf.get(planeId) ?? 0),
          // The fine-grained ammo/role family drives the panel's leading type
          // label (鱼雷机 / 火箭机 / 轰炸机 ...), see HoloSquadronPanel.
          role: typeKey?.role,
          groupSize: 1,
          groupCount: count,
          meshes: [],
        });
      }
      list.push({ idx, role, count, trail });
    }
    for (const [planeId, entries] of byPlane) {
      const formation = ctx.planeFormations.get(planeId)!;
      // AUTHORITATIVE grouping first: the airframe's GameParams
      // formations.aerialAttack slot table says how many planes fly per
      // group (3 for 892 of 894 airframes). The positional clustering
      // below only runs for a paramsId the table does not cover — it can
      // only guess at what the game records exactly, and it mis-reads wide
      // launches as a ring of single-plane groups.
      const paramsId = paramsOf.get(planeId);
      const recorded = groupSizeOfParams(paramsId);
      if (recorded != null) {
        formation.groupSize = Math.max(1, Math.min(recorded, formation.count));
        formation.groupCount = Math.max(1, Math.ceil(formation.count / formation.groupSize));
      } else {
        // Fallback: infer the layout from the launch positions (clusters of
        // planes spawned together = one flight group). The launch poses are
        // captured BEFORE the minimap merge pads the anchor trail — sampling
        // the merged trail at a padded centre-squadron sample would flip the
        // grouping on real replays (see MapInternals.planeLaunchPoses).
        const grp = inferGrouping(entries, (trail) =>
          ctx.planeLaunchPoses.get(trail.id),
        );
        formation.groupSize = Math.max(1, Math.min(grp.groupSize, formation.count));
        formation.groupCount = Math.max(1, grp.groupCount);
      }
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
        targetLen: 4.6,
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
  // One label per carrier that controls any aircraft — SCOUT wings excluded:
  // a catapult-launched spotter belongs to its hull, not to a floating
  // aircraft card (user requirement 2026-11-21: "侦察机消耗品放出来的飞机都不
  // 需要带标签"; the parent hull's label reports the consumable instead, see
  // markerUpdate's ship-label pass). A ship whose only wings are scouts gets
  // no card at all, which is exactly the rule.
  const carriersOfPlanes = new Map<
    number,
    { paramsId: number; time: number; role: TeamRole }
  >();
  for (const [planeId, carrierId] of planeCarrierOf) {
    if (carrierId == null) continue;
    const first = createFirst.get(planeId)!;
    if (isScoutParamsId(first.paramsId) || isAswParamsId(first.paramsId)) continue;
    // The card's INITIAL type comes from the carrier's NEWEST wing (the one
    // most likely to be on screen at build time). The old accumulation kept
    // whichever wing iterated first, so a Shokaku's card wore its first
    // (torpedo) sortie's family for the whole match — the "fighter label
    // renders as a torpedo plane" report. The per-frame content pass
    // (markerUpdate) then follows the wing actually picked, so this is only
    // the pre-first-tick fallback.
    const prev = carriersOfPlanes.get(carrierId);
    if (!prev || first.time >= prev.time) {
      carriersOfPlanes.set(carrierId, {
        paramsId: first.paramsId,
        time: first.time,
        // The card's OWNER ROLE rides the same join the plane tint does: an
        // ENEMY carrier's card must paint the hostile look (red border ink +
        // red-tinted HP fill), never the recorder's own white/green — the
        // "红色飞机却绿色血条+白色边框" report. markerUpdate refreshes it per
        // tick once the hull's role resolves.
        role: (ctx.planeRoleById.get(planeId) ?? "enemy") as TeamRole,
      });
    }
  }
  for (const [carrierId, info] of carriersOfPlanes) {
    // A paramsId the baked table does not carry names no family: the card
    // must NOT claim one (the old "attack" default painted the skip-bomber
    // icon for unknown wings — "疑似侦察机却显示为轰炸机"). The first content
    // tick fills the real family from the wing it rides, and until then the
    // label simply has none (its icon falls back, its family line hides).
    const planeType = PLANE_TYPES[String(info.paramsId)]?.type ?? null;
    newLabels.push({
      entityId: PLANE_CARD_LABEL_ID_BASE + Number(carrierId),
      role: info.role,
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
  // Keep a per-plane → labelId map for the per-frame position update. Scout
  // wings stay OUT of it: no floating card may ever anchor to a spotter.
  ctx.planeLabelOfPlane.clear();
  for (const [planeId, carrierId] of planeCarrierOf) {
    if (carrierId == null) continue;
    const first = createFirst.get(planeId);
    if (first && (isScoutParamsId(first.paramsId) || isAswParamsId(first.paramsId))) continue;
    ctx.planeLabelOfPlane.set(planeId, PLANE_CARD_LABEL_ID_BASE + Number(carrierId));
  }
  // Fighter-patrol anchors (deployment countdown + fixed-circle anchor): the
  // ward circles joined to the wings and to the consumable that launched them.
  buildPlaneWardAnchors(ctx);
}

/* ── Homeward-bound (post-strike) gating for the aircraft markers ────────
 * User requirement: a RETURNING wing shows NO class marker on either 2D map
 * (the thumbnail, the enlarged overlay and the exported clip's tactical board
 * — all three paint through minimapPainter) and, in 3D, keeps its MODEL but
 * loses the floating card. The detection itself is
 * planeFormation.squadronReturningSince, a pure fold over the wing's own
 * trail; these two readers add the ctx joins every surface needs — the wing's
 * carrier (planeCarrierOf) and that carrier's trajectory at the sample times
 * — so the painter, the label projection and the marker pass cannot disagree.
 */

/** Map-context slices the return test reads (all optional so a partially
 *  built context — or a unit-test double — simply reads "not returning"). */
export interface PlaneReturnCtx {
  planeCarrierOf?: ReadonlyMap<number, number | null>;
  trajById?: ReadonlyMap<number, CarrierTrackLike>;
}

/** Whether this wing is PROVEN homeward-bound at `t` (see
 *  squadronReturningSince for what "proven" means). `trail` is the wing's
 *  anchor trail — every aircraft surface already holds or can find it, and the
 *  merged anchor is where the 3D attitude (pitch) samples live. A missing
 *  carrier join or trajectory reads false: unknown renders exactly as before. */
export function planeReturningAt(
  ctx: PlaneReturnCtx,
  trail: { id: number; samples: SquadronPlane[] },
  t: number,
): boolean {
  const planeId = Math.floor(trail.id / 16);
  const carrierId = ctx.planeCarrierOf?.get(planeId);
  if (carrierId == null) return false;
  const track = ctx.trajById?.get(carrierId);
  if (!track) return false;
  return squadronReturningSince(trail.samples, track, t) !== null;
}

/** Whether a carrier's floating aircraft card may render at `t`: at least
 *  one of its sorties is airborne (inside the shared planeTrailExpiry window)
 *  AND not homeward-bound. All-returning hides the card while the formation
 *  models keep flying — the 3D half of the same requirement. */
export function planeCardVisibleAt(
  ctx: Pick<
    MapInternals,
    | "planeLabelOfPlane"
    | "planeTrails"
    | "minimapTrailEnd"
    | "planeCarrierOf"
    | "trajById"
  >,
  labelId: number,
  t: number,
): boolean {
  for (const [planeId, labelOf] of ctx.planeLabelOfPlane) {
    if (labelOf !== labelId) continue;
    const trail = ctx.planeTrails.find((tr) => Math.floor(tr.id / 16) === planeId);
    if (!trail || trail.samples.length === 0) continue;
    const first = trail.samples[0].time;
    const last = trail.samples[trail.samples.length - 1].time;
    // Squadron is gone one grace window after its last sample — no lingering
    // labels (the SAME planeTrailExpiry every aircraft surface reads).
    const expiry = planeTrailExpiry(last, ctx.minimapTrailEnd.get(planeId));
    if (t < first || t > expiry) continue;
    if (planeReturningAt(ctx, trail, t)) continue;
    return true;
  }
  return false;
}
