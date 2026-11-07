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
  SquadronHealthEvent,
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
function lastSquadronEventAt<E extends { time: number; planeId: number }>(
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

/** Consumable type ids whose effect window is open at t: a "used" event
 *  opens a type's window, the matching "stopWorking" closes it — so a type
 *  is active exactly when its LATEST event at or before t is "used" (a
 *  Used with no StopWorking stays open: still active at stream end, or the
 *  squadron died with it on). Ascending order for a stable chip row. */
export function activeConsumablesAt(
  consumables: readonly SquadronConsumableEvent[] | undefined,
  planeId: number,
  t: number,
): number[] {
  const latest = new Map<number, SquadronConsumableEvent>();
  for (const event of consumables ?? []) {
    if (event.planeId !== planeId || event.time > t) continue;
    const prev = latest.get(event.consumableType);
    if (prev === undefined || event.time >= prev.time) {
      latest.set(event.consumableType, event);
    }
  }
  const active: number[] = [];
  for (const [consumableType, event] of latest) {
    if (event.kind === "used") active.push(consumableType);
  }
  active.sort((a, b) => a - b);
  return active;
}

/** Observed squadron-consumable type ids → the pill chip's i18n key. The
 *  ids are the E27 wire's raw consumable byte (20/21/22 on the reference
 *  capture); their NAMES live in the locale files, which the lead owns —
 *  this map only routes ids to keys and invents nothing. */
export const CONSUMABLE_LABEL: Readonly<Record<number, string>> = {
  20: "replay.planeCard.cons20",
  21: "replay.planeCard.cons21",
  22: "replay.planeCard.cons22",
};

/** The i18n key for one consumable type id: mapped ids get their named
 *  key, anything else the generic fallback — an unknown id must still
 *  render a chip, not a blank. */
export function consumableLabelKey(consumableType: number): string {
  return CONSUMABLE_LABEL[consumableType] ?? "replay.planeCard.consOther";
}

/** Everything the pill card adds on top of the trail-derived strength, in
 *  one call: the squadron's HP fraction (null before the first health
 *  sample), whether engine boost is on (last throttle mode == 1 — null and
 *  cruise both read as not boosting), and the open consumable windows.
 *  HolographicMap calls this once per planeCardState refresh (10 Hz); a
 *  null / stream-less aggregate (pre-E27 replay, failed load) degrades to
 *  the pre-E27 card. */
export function planeCardExtras(
  events: Readonly<SquadronStateEvents> | null | undefined,
  planeId: number,
  t: number,
): { hp: number | null; boost: boolean; consumables: number[] } {
  return {
    hp: squadronHpAt(events?.health, planeId, t),
    boost: throttleAt(events?.throttle, planeId, t) === 1,
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
