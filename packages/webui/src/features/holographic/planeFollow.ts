/**
 * Plane-follow card derivation for the holographic map's aircraft chase —
 * the pure sample math behind the bottom-left pill (HoloPlaneFollowCard):
 * how many planes of the chased squadron are still up (squadronStrength),
 * what the formation's launch strength was, whether it is in an attack run
 * right now (squadronAttacking), and the per-plane samples to judge that
 * from (squadronSamplesAt).
 *
 * The second half reads the E27 squadron-state streams
 * (readReplaySquadronStates — squadron HP fraction, engine boost, open
 * consumable windows) as step lookups (squadronHpAt / throttleAt /
 * activeConsumablesAt), aggregated for the card by planeCardExtras.
 *
 * Reads the SAME trail table followTargets.ts answers the camera from —
 * one trail per (planeId, formation index), id = planeId * 16 + index —
 * so the card can never disagree with what the camera actually follows.
 * No Vue / DOM / three.js state; refreshed at the 10 Hz hudCurrent cadence
 * (see HolographicMap's planeCardState watch), not per rendered frame.
 */
import type {
  SquadronConsumableEvent,
  SquadronConsumableType,
  SquadronHealthEvent,
  SquadronPlanesHealthEvent,
  SquadronStateEvents,
  SquadronThrottleEvent,
} from "@/api";
import type { PlaneTrailLike } from "./followTargets";
import { planeTrailExpiry } from "./planeFormation";
import { samplesUpTo } from "./trajectoryMath";

/** Live strength of a squadron: how many of its planes are still up
 *  (alive) against the launch strength (total). */
export interface SquadronStrength {
  alive: number;
  total: number;
}

/** Strength of one squadron at time t, or null when none of its planes is
 *  live at t (before the launch, after every trail expired).
 *
 *  A plane counts alive when its trail has a sample by t and the trail is
 *  inside the shared lifetime window — born <= t <= planeTrailExpiry(last
 *  sample, removeAt) — the same rule activeSquadronOf applies to the index-0
 *  anchor, evaluated per formation member so shot-down wingmen drop out of
 *  the count while the launch strength (largest formation index seen for
 *  this planeId, + 1) keeps the "12 / 24" denominator stable. Distinctness
 *  of the counted indexes is the trail table's own keying: (planeId, index)
 *  IS the trail identity, so each index appears at most once and the bit
 *  mask cannot double-count. */
export function squadronStrength(
  planeTrails: readonly PlaneTrailLike[],
  planeId: number,
  removeAt: ReadonlyMap<number, number>,
  t: number,
): SquadronStrength | null {
  let total = 0;
  // One bit per formation index (0..15): id % 16 is the index namespace.
  let aliveMask = 0;
  for (const trail of planeTrails) {
    if (Math.floor(trail.id / 16) !== planeId) continue;
    const index = trail.id % 16;
    if (index + 1 > total) total = index + 1;
    const samples = trail.samples;
    if (samples.length === 0) continue;
    // Not launched by t (a trail exists once its first update landed, so a
    // member launching later than the anchor stays invisible until then).
    if (samplesUpTo(samples, t) === 0) continue;
    const born = samples[0].time;
    const expiry = planeTrailExpiry(
      samples[samples.length - 1].time,
      removeAt.get(planeId),
    );
    if (born > t || t > expiry) continue;
    aliveMask |= 1 << index;
  }
  if (aliveMask === 0) return null;
  let alive = 0;
  for (let mask = aliveMask; mask !== 0; mask &= mask - 1) alive++;
  return { alive, total };
}

/** Strength readout for the follow pill (HoloPlaneFollowCard's
 *  alive/total): the E27 per-plane digit count is AUTHORITATIVE whenever
 *  the replay streams it, because the minimap merge pads only the anchor
 *  trail — wingman trails still expire on their own 3D samples, so the
 *  per-trail squadronStrength would report a one-plane "1/N" formation
 *  during exactly the sparse-3D stretches the merge exists for (measured
 *  on the reference capture: 17 of 108 squadrons run a merged anchor past
 *  their wingman trails for a median 33 s). The launch strength comes from
 *  the decoded formation table (numPlanes), and the trail-derived
 *  squadronStrength keeps pre-E27 replays unchanged. Null when nothing is
 *  live by either source (the card then shows its hull fallback). */
export function chaseStrength(
  planeTrails: readonly PlaneTrailLike[],
  planeFormations: ReadonlyMap<number, { count: number }>,
  planesHealth: readonly SquadronPlanesHealthEvent[] | undefined,
  removeAt: ReadonlyMap<number, number>,
  planeId: number,
  t: number,
): SquadronStrength | null {
  const trails = squadronStrength(planeTrails, planeId, removeAt, t);
  const live = squadronFlyingAt(planesHealth, planeId, t);
  if (trails == null && live == null) return null;
  const launch = planeFormations.get(planeId)?.count ?? 0;
  return {
    alive: live ?? trails?.alive ?? 0,
    total: Math.max(trails?.total ?? 0, launch, live ?? 0),
  };
}

/** Pitch (degrees) at which a plane sample reads as an attack-run dive.
 *  WoWS attack runs pitch the models sharply down; −25° separates the dive
 *  from ordinary patrol climb/descend noise. The decoder (SquadronPlane.
 *  pitch) supplies it per update sample; older streams carry no pitch at
 *  all — undefined never counts as attacking. */
export const SQUADRON_ATTACK_PITCH_DEG = -25;

/** Whether ANY sampled plane of the formation is in an attack-run dive:
 *  at least one sample with a defined pitch <= SQUADRON_ATTACK_PITCH_DEG.
 *  Runs per card refresh over the formation's current samples (at most the
 *  squadron size, ≤16 entries). */
export function squadronAttacking(planes: readonly { pitch?: number }[]): boolean {
  for (const plane of planes) {
    if (plane.pitch != null && plane.pitch <= SQUADRON_ATTACK_PITCH_DEG) {
      return true;
    }
  }
  return false;
}

/** The formation's current samples: each member trail's last sample at or
 *  before t (members without one yet are skipped). Feed this to
 *  squadronAttacking — the dive state rides the newest update per plane. */
export function squadronSamplesAt(
  planeTrails: readonly PlaneTrailLike[],
  planeId: number,
  t: number,
): { pitch?: number }[] {
  const out: { pitch?: number }[] = [];
  for (const trail of planeTrails) {
    if (Math.floor(trail.id / 16) !== planeId) continue;
    const idx = samplesUpTo(trail.samples, t) - 1;
    if (idx >= 0) out.push(trail.samples[idx]);
  }
  return out;
}

/* ── E27 squadron-state stream lookups (readReplaySquadronStates) ────────
 * The decoded streams are independent timelines keyed by planeId, each
 * already in packet (time) order; the card asks "what is the state at t"
 * a few times per hudCurrent tick. Undefined streams are pre-E27 replays
 * (the backend skips empty vectors) and read as no-data everywhere. */

/** The last event of one plane's stream at or before t — the step-lookup
 *  core every stream reader below shares. Linear scan (latest time wins;
 *  on equal times the later array entry wins, matching wire order), which
 *  stays cheap at the card's 10 Hz cadence: the reference capture's whole
 *  health stream is ~5k events, so a scan costs a few thousand
 *  comparisons a few times per second. Null when the stream holds no
 *  sample of this plane at or before t. */
export function lastSquadronEventAt<E extends { time: number; planeId: number }>(
  events: readonly E[] | undefined,
  planeId: number,
  t: number,
): E | null {
  let best: E | null = null;
  for (const event of events ?? []) {
    if (event.planeId !== planeId || event.time > t) continue;
    if (best === null || event.time >= best.time) best = event;
  }
  return best;
}

/** The squadron's TOTAL-HP fraction (0..1) at t: the last health sample at
 *  or before t. Null before the first sample — the card hides the bar then
 *  (pre-E27 replays never grow one at all). */
export function squadronHpAt(
  health: readonly SquadronHealthEvent[] | undefined,
  planeId: number,
  t: number,
): number | null {
  const event = lastSquadronEventAt(health, planeId, t);
  return event === null ? null : event.hp;
}

/** The engine mode at t: the last throttle toggle at or before t (0 =
 *  cruise, 1 = boost), or null before the first sample. The caller treats
 *  null as cruise — exactly what an unboosted launch looks like. */
export function throttleAt(
  throttle: readonly SquadronThrottleEvent[] | undefined,
  planeId: number,
  t: number,
): number | null {
  const event = lastSquadronEventAt(throttle, planeId, t);
  return event === null ? null : event.mode;
}

/** The squadron's alive-in-flight plane count at t: the last planesHealth
 *  sample at or before t, counted by its packed u64's digit count
 *  (packed-crack: 3 bits per plane, LSB first — a death drops the top
 *  digit, so the digit count IS the flying count). Null before the first
 *  sample — pre-E27 replays never grow one, and the caller falls back to
 *  the trail-derived strength. */
export function squadronFlyingAt(
  planesHealth: readonly SquadronPlanesHealthEvent[] | undefined,
  planeId: number,
  t: number,
): number | null {
  const event = lastSquadronEventAt(planesHealth, planeId, t);
  return event === null ? null : unpackSquadronBands(event.packed).length;
}

/** Semantic squadron-consumable types whose effect window is open at t: a
 *  "used" event opens a type's window, the matching "stopWorking" closes it —
 *  so a type is active exactly when its LATEST event at or before t is "used"
 *  (a Used with no StopWorking stays open: still active at stream end, or the
 *  squadron died with it on). Windows are keyed by the RAW wire byte (the
 *  branch-forked id — see SquadronConsumableType) and answered in the
 *  decoder-normalized semantic vocabulary (E27d), ordered by raw id ascending
 *  for a stable chip row. */
export function activeConsumablesAt(
  consumables: readonly SquadronConsumableEvent[] | undefined,
  planeId: number,
  t: number,
): SquadronConsumableType[] {
  const latest = new Map<number, SquadronConsumableEvent>();
  for (const event of consumables ?? []) {
    if (event.planeId !== planeId || event.time > t) continue;
    const prev = latest.get(event.consumableType);
    if (prev === undefined || event.time >= prev.time) {
      latest.set(event.consumableType, event);
    }
  }
  return [...latest.entries()]
    .filter(([, event]) => event.kind === "used")
    .sort(([a], [b]) => a - b)
    .map(([, event]) => event.semantic);
}

/** The one-shot temporary-boost window's remaining fraction at t, for a
 *  semantic consumable type (aircraft: healForsage — the take-off/临时加速
 *  burst). The active window is the Used→StopWorking bracket; while a Used
 *  has no StopWorking yet the effect is still running (end of stream, or a
 *  squadron that died with it on) and reads as a full bar. Returns null
 *  when nothing is running, so the caller can omit the bar entirely.
 *  `fallbackSecs` covers the still-open bracket: the wire carries no
 *  duration, so the type's documented workTime stands in (5 s for
 *  healForsage; see the E27b provenance note above). */
export function consumableWindowFrac(
  consumables: readonly SquadronConsumableEvent[] | undefined,
  planeId: number,
  semantic: SquadronConsumableType,
  t: number,
  fallbackSecs = 5,
): number | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const event of consumables ?? []) {
    if (event.planeId !== planeId) continue;
    if (event.semantic !== semantic) continue;
    if (event.time > t) {
      // First StopWorking after the running Used closes the bracket.
      if (end === null && event.kind === "stopWorking") end = event.time;
      continue;
    }
    if (event.kind === "used") {
      start = event.time;
      end = null;
    } else if (event.kind === "stopWorking") {
      start = null;
      end = null;
    }
  }
  if (start === null) return null;
  const window = end === null ? fallbackSecs : end - start;
  if (window <= 0) return null;
  const frac = Math.max(0, Math.min(1, 1 - (t - start) / window));
  // An open bracket (no StopWorking: squadron died / stream end) that has run
  // past its fallback duration is over — report null so the bar and the chip
  // row agree instead of leaving an empty track that still reads as active.
  return frac <= 0 ? null : frac;
}

/** Named (non-unknown) members of the semantic union — the map key space of
 *  CONSUMABLE_LABEL below. */
type NamedSquadronConsumableType = Exclude<SquadronConsumableType, { unknown: number }>;

/** Semantic squadron-consumable types → the pill chip's i18n key. The
 *  decoder (E27d) normalizes the BRANCH-FORKED wire byte into this one
 *  vocabulary at the decode boundary — WG (.wowsreplay) ids were
 *  fingerprinted on five 14.5 CV captures (E27b: 20 = healForsage engine
 *  boost, 5.0 s windows universal slot 0; 21 = planeTacticalFighters, 60 s
 *  windows + interruptions, universal slot 1; 22 = tactical
 *  fire-extinguishing, 5 s windows, the PCY085 air-dropped family;
 *  42 = planeSmokeGenerator, 10.01 s exact, PCY049), while the Lesta
 *  (.korablireplay) table comes from the local Korabli battle.xml
 *  CONSUMABLE_TYPES enum (E27c: 21 = HEAL_FORSAGE, 22 = CALL_FIGHTERS —
 *  the PROVISIONAL slot-1 fighters pairing, 23 = REGENERATE_HEALTH,
 *  42 = PLANE_SMOKE_GENERATOR). Only 42 coincides across the branches —
 *  raw ids must never reach a label. */
export const CONSUMABLE_LABEL: Readonly<Record<NamedSquadronConsumableType, string>> = {
  healForsage: "replay.planeCard.consForsage",
  planeTacticalFighters: "replay.planeCard.consFighters",
  fireExtinguishing: "replay.planeCard.consExtinguisher",
  planeSmokeGenerator: "replay.planeCard.consSmoke",
  regenerateHealth: "replay.planeCard.consRegen",
};

/** The i18n key for one semantic consumable type: named types get their
 *  named key, an unknown payload (`{ unknown }`) the generic fallback — an
 *  unmapped wire byte must still render a chip, not a blank (pair it with
 *  unknownConsumableId to show the raw id). */
export function consumableLabelKey(semantic: SquadronConsumableType): string {
  return typeof semantic === "string"
    ? (CONSUMABLE_LABEL[semantic] ?? "replay.planeCard.consOther")
    : "replay.planeCard.consOther";
}

/** The raw wire id an unknown semantic carries — the honest chip-text suffix
 *  ("消耗品 57") for bytes neither branch table names — or null for named
 *  types. */
export function unknownConsumableId(semantic: SquadronConsumableType): number | null {
  return typeof semantic === "string" ? null : semantic.unknown;
}

/** Everything the pill card adds on top of the trail-derived strength, in
 *  one call: the squadron's HP fraction (null before the first health
 *  sample), whether engine boost is on (last throttle mode == 1 — null and
 *  cruise both read as not boosting), and the open consumable windows in
 *  the decoder-normalized semantic vocabulary (E27d).
 *  HolographicMap calls this once per planeCardState refresh (10 Hz); a
 *  null / stream-less aggregate (pre-E27 replay, failed load) degrades to
 *  the pre-E27 card. */
export function planeCardExtras(
  events: Readonly<SquadronStateEvents> | null | undefined,
  planeId: number,
  t: number,
): { hp: number | null; boost: boolean; slow: boolean; consumables: SquadronConsumableType[] } {
  const mode = throttleAt(events?.throttle, planeId, t);
  return {
    hp: squadronHpAt(events?.health, planeId, t),
    boost: mode === 1,
    // Empirical (12 CV replays, 146 windows): the wire carries a THIRD
    // engine mode, −1, with variable-length windows (0.1–12.4 s, median
    // 2 s) — the slow-down key, distinct from the boost key and from the
    // healForsage consumable burst.
    slow: mode === -1,
    consumables: activeConsumablesAt(events?.consumables, planeId, t),
  };
}

/** One HP band per still-flying plane, from the cracked planesHealth u64
 *  (packed-crack, task-5): 3 bits per plane, LSB first — digit 1 =
 *  HP > 3/4, 2 = (1/4, 3/4], 4 = <= 1/4 (digits 3/5/6/7 never occur;
 *  anything else passes through raw). The DIGIT COUNT is the flying plane
 *  count — a death drops the TOP digit — and trailing zero digits are
 *  empty formation slots, so unpacking stops at the first 0 (16 slots ×
 *  3 bits = 48 bits, beyond JS's 32-bit shift domain — hence arithmetic,
 *  not >>>). Available for a per-plane band readout; the pill's total bar
 *  reads the health float stream instead (it is smoother and already
 *  normalized). */
export function unpackSquadronBands(packed: number): number[] {
  const bands: number[] = [];
  let rest = packed;
  for (let slot = 0; slot < 16 && rest > 0; slot++) {
    const digit = rest % 8;
    if (digit === 0) break;
    bands.push(digit);
    rest = Math.floor(rest / 8);
  }
  return bands;
}
