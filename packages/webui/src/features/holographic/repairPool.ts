/**
 * Repair-Party recoverable-HP state machine — the GREY segment of an HP bar.
 *
 * The game reads a hull's HP bar as three layers, left to right:
 *
 *     green  current HP   |   grey  recoverable   |   red  lost for good
 *
 * The grey layer is what an active Repair Party (GameParams consumable id 8,
 * `regenCrew`, ~28 s window) can still restore. The game bounds it with TWO
 * different GameParams numbers, and this module keeps them apart:
 *
 *   - the per-DAMAGE share the repair can claim — GameParams hit-location
 *     `regeneratedHPPart` (~0.5 on a hull's main sections, 0.1/0.33 on the
 *     citadel). The replay stream only carries aggregate hull HP deltas, so
 *     the section a hit landed on is unknowable; the module takes the
 *     documented TYPICAL as a flat `damageShare` parameter (default 0.5).
 *   - the per-CHARGE capacity — `regenerationHPSpeed × workTime`, the
 *     fraction of max HP ONE Repair Party charge restores. That is a HULL
 *     property, baked per `shipParamsId` by
 *     `scripts/extract_repair_coefficients.py` into
 *     `data/repair_coefficients.json` (739 hulls on the 15.10 client,
 *     0.05..0.60; 0.14 typical / 0.1848 premium) and answered by
 *     `repairCoefficientFor`.
 *
 * Damage a hull takes INSIDE one of its repair windows is queued into that
 * window's pool at `damage × damageShare`, capped at one charge's capacity
 * (`coefficient × maxHp`); when the consumable's heal ticks later raise the
 * hull's HP, the pool drains first — grey shrinks, green grows. Damage taken
 * OUTSIDE every window (and any heal that runs past the pool) is gone for
 * good; heals are never "damage" and so never ACCRUE a pool. Two back-to-back
 * repairs keep two independent pools (the second window cannot re-claim damage
 * the first one already queued) — each pool capped by its own charge
 * capacity, since every window is one charge — and the bar shows their sum:
 *
 *     grey(t) = Σ_windows min( damage in window × damageShare,
 *                              coefficient × maxHp )   (heals drain first)
 *
 * A 5,000-damage salvo on a 50,000-HP hull inside a window queues 2,500, but
 * never more than that charge can restore.
 *
 * SCRUB STABILITY: this is a pure fold over the events and the hull's HP
 * samples at or before the playhead — no playback-history state, no
 * monotonicity assumption, no shared clock. Evaluating it at t, at t again
 * after a seek, or by walking backwards through the replay all yield the same
 * number (the fold is cached as a per-sample PREFIX ARRAY, so a seek is a
 * binary search over an already-correct fold rather than a replay).
 *
 * WHY THE SHARE STAYS FLAT: the extraction dump DOES carry the per-section
 * number (`A_Hull.<part>.regeneratedHPPart`, the ship's hit locations: Bow /
 * Hull / SS / St / SG are 0.5, Cit is 0.1 or 0.33, some sections 0.6..0.75),
 * so it is cheap to read — but it is a SECTION property, not a hull one, and
 * the replay never attributes a hit to a section. Baking one value per hull
 * would dress a guess up as data, so the documented typical stays a constant
 * parameter ([`REPAIR_PARTY_DAMAGE_SHARE`]).
 *
 * CAPACITY FALLBACK: an UNKNOWN hull (never baked — a ship added after the
 * bake) answers the documented FLAT DEFAULT of 0.5 × max HP
 * (`REPAIR_PARTY_RECOVERABLE_FRAC`) as its capacity, so the grey bar keeps
 * its old behaviour there.
 *
 * The replay stream is deliberately NOT a source: the Vehicle create-state
 * `regenCrewHpLimit` an earlier slice carried as `ReplayStream.repairHpCaps`
 * reads `0.0` for EVERY hull of a real 15.10 capture, and the live index-33
 * property updates carry CURRENT HP (a 44600 → 41179 damage trajectory), not a
 * repair cap. That map was permanently empty dead data and is gone.
 *
 * Both renderers consume this module: the floating label's HP bar (through
 * markerUpdate's per-tick label content) and the exported clip's team-column
 * HP bar (through playbackExport's per-frame feed).
 */
import type { ConsumableUseEvent, HpSample } from "@/api";
import repairCoefficientsRaw from "@/data/repair_coefficients.json";

/** Raw GameParams consumable id of the Repair Party (`regenCrew`) — the
 *  id the vehicle `onConsumableUsed` stream carries (see the Rust
 *  ConsumableUseEvent docs: reference capture clusters id 8 at 28 s). */
export const REPAIR_PARTY_CONSUMABLE_ID = 8;

/** Fallback per-charge CAPACITY as a fraction of max HP — the documented flat
 *  default every UNKNOWN hull answers (one Repair Party charge restores at
 *  most this much). NOT the per-damage share: the pre-split model used this
 *  one number for both, which is exactly the semantic bug the split fixes. */
export const REPAIR_PARTY_RECOVERABLE_FRAC = 0.5;

/** The documented TYPICAL per-damage recoverable share — GameParams
 *  hit-location `regeneratedHPPart` (~0.5 on a hull's main sections; the
 *  citadel is 0.1/0.33). FLAT on purpose: the replay stream has no section
 *  attribution, so a per-section bake could not be applied honestly (see the
 *  module header). */
export const REPAIR_PARTY_DAMAGE_SHARE = 0.5;

/** The baked per-hull coefficients (`shipParamsId` → fraction of max HP one
 *  Repair Party charge restores), generated by
 *  `scripts/extract_repair_coefficients.py`. Ids are STRINGS in the asset
 *  (JSON object keys), so the join is `String(shipId)`. */
const REPAIR_COEFFICIENTS = repairCoefficientsRaw as Record<string, number>;

/** The hull's per-CHARGE CAPACITY as a fraction of max HP — the `coefficient`
 *  the grey-bar state machine caps each Repair Party window's pool with, read
 *  off the baked GameParams table.
 *
 *  A hull present in the table answers its own baked fraction (clamped to
 *  0..1 so a bad bake can never paint past the bar); an UNKNOWN hull answers
 *  the documented flat default [`REPAIR_PARTY_RECOVERABLE_FRAC`]. A hull
 *  without a usable `maxHp` also keeps the flat default: the renderers never
 *  segment a bar whose scale they cannot trust, even though the fraction
 *  itself no longer needs the division. */
export function repairCoefficientFor(
  shipId: number | string | null | undefined,
  maxHp: number | null | undefined,
): number {
  if (maxHp == null || !Number.isFinite(maxHp) || !(maxHp > 0)) {
    return REPAIR_PARTY_RECOVERABLE_FRAC;
  }
  if (shipId == null) return REPAIR_PARTY_RECOVERABLE_FRAC;
  const fraction = REPAIR_COEFFICIENTS[String(shipId)];
  if (typeof fraction !== "number" || !Number.isFinite(fraction) || !(fraction > 0)) {
    return REPAIR_PARTY_RECOVERABLE_FRAC;
  }
  return Math.max(0, Math.min(1, fraction));
}

/** One Repair Party effect window: `[start, end]`, in battle seconds. */
export interface RepairWindow {
  start: number;
  end: number;
}

/** The three HP-bar layers as fractions of the bar's own width (0..1). */
export interface HpBarSegments {
  /** Current HP — the green (or amber/red) fill the bar already drew. */
  green: number;
  /** Recoverable-by-repair pool — the grey segment. */
  gray: number;
  /** Permanently lost HP — the red segment. */
  red: number;
}

/** entityId → its repair windows, memoized per events ARRAY (the stream
 *  array is replaced wholesale per replay, so entries die with the replay and
 *  a rebuilt stream cannot serve stale windows). */
const windowsMemo = new WeakMap<object, Map<number, RepairWindow[]>>();

/** Every Repair Party window of ONE hull, sorted by start. Events for other
 *  hulls, other consumable ids, and zero-duration windows are dropped: the
 *  wire's `duration` is the consumable's remaining work time, and a 0 s
 *  reading opens no window to accrue damage in.
 *
 *  `entityId` omitted (or null) means "every event belongs to the hull" —
 *  the shape the pure state machine exposes for callers that already sliced
 *  their own hull's events. */
export function repairWindowsFor(
  events: readonly ConsumableUseEvent[] | null | undefined,
  entityId?: number | null,
): RepairWindow[] {
  if (!events || events.length === 0) return [];
  let byEntity = windowsMemo.get(events);
  if (!byEntity) {
    byEntity = new Map<number, RepairWindow[]>();
    windowsMemo.set(events, byEntity);
  }
  // Sentinel key for the "no entity filter" query; real wire ids are never
  // negative, so the two queries never share a slot.
  const key = entityId ?? -1;
  const hit = byEntity.get(key);
  if (hit) return hit;
  const out: RepairWindow[] = [];
  for (const e of events) {
    if (e.consumableId !== REPAIR_PARTY_CONSUMABLE_ID) continue;
    if (entityId != null && e.entityId !== entityId) continue;
    if (!(e.duration > 0)) continue;
    out.push({ start: e.time, end: e.time + e.duration });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  byEntity.set(key, out);
  return out;
}

/** Whether the replay streamed ANY Repair Party activation for this hull —
 *  the feature-on flag the renderers use to tell "no repair data, draw the
 *  plain two-layer bar" (false → the caller passes a null pool) from "repair
 *  data present but exhausted right now" (true → grey 0, red still drawn). */
export function hasRepairPartyUse(
  events: readonly ConsumableUseEvent[] | null | undefined,
  entityId?: number | null,
): boolean {
  return repairWindowsFor(events, entityId).length > 0;
}

/** One hull's per-sample recoverable prefix, memoized per HP-sample array. */
interface PoolFold {
  windows: readonly RepairWindow[];
  maxHp: number;
  coefficient: number;
  damageShare: number;
  /** `values[i]` = recoverable HP right AFTER hpSamples[i] was folded in. */
  values: Float64Array;
}

const foldMemo = new WeakMap<object, PoolFold>();

/** Fold the hull's whole HP timeline once: `values[i]` is the TOTAL
 *  recoverable pool after sample i. Damage (a negative HP delta) accrues
 *  `-delta × damageShare` into the NEWEST window active at that sample's
 *  time, capped by THAT window's remaining charge capacity
 *  (coefficient × maxHp — every window is one charge); a heal (a positive
 *  delta) drains the pools oldest-window-first. The full prefix is cached,
 *  which is what makes any playhead (and any scrub direction) a binary search
 *  instead of a replay. */
function foldPools(
  windows: readonly RepairWindow[],
  samples: readonly HpSample[],
  maxHp: number,
  coefficient: number,
  damageShare: number,
): Float64Array {
  const values = new Float64Array(samples.length);
  const cap = coefficient * maxHp;
  if (!(cap > 0) || windows.length === 0) return values;
  const share = Number.isFinite(damageShare)
    ? Math.max(0, Math.min(1, damageShare))
    : 0;
  const pools = new Float64Array(windows.length);
  let total = 0;
  let prev = samples[0].value;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    const delta = s.value - prev;
    prev = s.value;
    if (delta < 0) {
      // Newest window still open at this sample's time owns the damage.
      let active = -1;
      for (let w = windows.length - 1; w >= 0; w--) {
        if (windows[w].start > s.time) continue;
        if (s.time <= windows[w].end) {
          active = w;
          break;
        }
      }
      if (active >= 0) {
        // The share decides how much of the hit is queued at all; the
        // window's own charge capacity bounds its pool (not the sum's).
        const add = Math.min(-delta * share, cap - pools[active]);
        if (add > 0) {
          pools[active] += add;
          total += add;
        }
      }
    } else if (delta > 0) {
      // Heal: the pool drains first (oldest repair first), the remainder is
      // ordinary healing and never becomes "damage".
      let heal = delta;
      for (let w = 0; w < pools.length && heal > 0; w++) {
        const take = Math.min(pools[w], heal);
        if (take <= 0) continue;
        pools[w] -= take;
        total -= take;
        heal -= take;
      }
    }
    values[i] = total;
  }
  return values;
}

/** The hull's remaining recoverable HP at battle time `t`.
 *
 *  Pure and scrub-stable: a fold over the Repair Party windows (consumable id
 *  8) and the hull's HP samples AT OR BEFORE `t` — see the module header.
 *
 *  @param events  the replay's vehicle consumable activations (the stream's
 *                 optional `consumableUses`; absent = 0).
 *  @param hpSamples the hull's HP timeline (ascending `time`).
 *  @param maxHp   the hull's total HP (the capacity's denominator).
 *  @param coefficient the hull's per-charge CAPACITY as a fraction of maxHp
 *                 ([`repairCoefficientFor`]): one Repair Party charge
 *                 restores at most coefficient × maxHp.
 *  @param t       battle seconds.
 *  @param entityId optional hull join — omit only when `events` already
 *                 holds this hull's events alone.
 *  @param damageShare the share of each damage event inside a window that
 *                 becomes recoverable (default REPAIR_PARTY_DAMAGE_SHARE =
 *                 0.5, the documented typical regeneratedHPPart).
 */
export function repairRecoverableAt(
  events: readonly ConsumableUseEvent[] | null | undefined,
  hpSamples: readonly HpSample[] | null | undefined,
  maxHp: number | null | undefined,
  coefficient: number,
  t: number,
  entityId?: number | null,
  damageShare: number = REPAIR_PARTY_DAMAGE_SHARE,
): number {
  if (maxHp == null || !(maxHp > 0)) return 0;
  if (!hpSamples || hpSamples.length === 0) return 0;
  const windows = repairWindowsFor(events, entityId);
  if (windows.length === 0) return 0;
  // Samples at or before the playhead: the last one defines the bar.
  let lo = 0;
  let hi = hpSamples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hpSamples[mid].time <= t) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  const memo = foldMemo.get(hpSamples);
  let fold = memo;
  if (
    !fold ||
    fold.windows !== windows ||
    fold.maxHp !== maxHp ||
    fold.coefficient !== coefficient ||
    fold.damageShare !== damageShare
  ) {
    fold = {
      windows,
      maxHp,
      coefficient,
      damageShare,
      values: foldPools(windows, hpSamples, maxHp, coefficient, damageShare),
    };
    foldMemo.set(hpSamples, fold);
  }
  const v = fold.values[lo - 1];
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Same state machine expressed as a 0..1 FRACTION of max HP — the unit the
 *  two renderers paint in. `null` means "this hull has no Repair Party data
 *  in the replay" (the feature stays off and the bar renders exactly as
 *  before); `0` with repairs present means "pool exhausted — green + red
 *  only".
 *
 *  `coefficient` is the hull's per-charge CAPACITY fraction (pass
 *  `repairCoefficientFor(shipId, maxHp)`); `damageShare` is the flat
 *  per-damage share (default REPAIR_PARTY_DAMAGE_SHARE = 0.5). */
export function repairRecoverableFracAt(
  events: readonly ConsumableUseEvent[] | null | undefined,
  hpSamples: readonly HpSample[] | null | undefined,
  maxHp: number | null | undefined,
  t: number,
  entityId?: number | null,
  coefficient: number = REPAIR_PARTY_RECOVERABLE_FRAC,
  damageShare: number = REPAIR_PARTY_DAMAGE_SHARE,
): number | null {
  if (maxHp == null || !(maxHp > 0)) return null;
  if (!hasRepairPartyUse(events, entityId)) return null;
  const amount = repairRecoverableAt(
    events,
    hpSamples,
    maxHp,
    coefficient,
    t,
    entityId,
    damageShare,
  );
  return Math.max(0, Math.min(1, amount / maxHp));
}

/** Split an HP bar's unit width into its three layers. `green` keeps the
 *  current HP untouched, `gray` takes the recoverable amount OUT OF the lost
 *  remainder (never out of green — the repair pool can only re-fill HP that is
 *  already gone), and `red` is whatever is left, permanent. Out-of-range or
 *  missing inputs clamp defensively so a broken sample can never paint past
 *  the track.
 */
export function hpBarSegments(
  hpFrac: number | null | undefined,
  recoverableFrac: number | null | undefined,
): HpBarSegments {
  const green = clamp01(hpFrac ?? 0);
  const gray = Math.min(clamp01(recoverableFrac ?? 0), 1 - green);
  return { green, gray, red: 1 - green - gray };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}
