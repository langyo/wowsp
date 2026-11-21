/**
 * Raw consumable-type ids → the FAMILY the holographic replay reads them as.
 *
 * The wire carries the client's own consumable-type enum byte (see the Rust
 * `ConsumableUseEvent`: "the id→name map is a GameParams concern and stays
 * raw here"), and the GameParams numeric enum is NOT part of the baked
 * `consumable_details.json` (that asset is keyed by entity name). The ids
 * below are therefore pinned EMPIRICALLY, from the 14.5.0.0 Shokaku reference
 * capture (2025-07-08 "37_Ridge"), by correlating every decoded use with the
 * stream it provably produced:
 *
 *   - 8  = Repair Party (regenCrew): 28 s work time, the repairPool grey bar's
 *          input (repairPool.REPAIR_PARTY_CONSUMABLE_ID owns that pin);
 *   - 9  = the carrier's PATROL FIGHTER (GameParams PCY038 FighterAuto, 600 s
 *          work time): every use fires on a carrier and is followed by a
 *          fighter wing launch and a ward ring (PJAF408_*_WARD patrols);
 *   - 1  = the catapult-launched SPOTTER / scout (PCY005/013/027 Spotter, the
 *          60–240 s band the capture's 71.5 s / 100 s values sit in): each use
 *          fires on a battleship/cruiser exactly when its `PJAS*`/`P*AS*`
 *          1-plane scout wing creates.
 *
 * Everything else (damage control, hydro, radar, smoke, boost…) is "other":
 * the modules that consume it key off their own families.
 */
import type { ConsumableUseEvent } from "@/api";

/** Carrier patrol-fighter family (the ward ring's consumable). */
export const FIGHTER_PATROL_CONSUMABLE_IDS: ReadonlySet<number> = new Set([9]);

/** Catapult-launched scout / spotter family. */
export const SCOUT_CONSUMABLE_IDS: ReadonlySet<number> = new Set([1]);

/** One consumable's active window, [t0, t1). */
export interface ConsumableWindow {
  /** Raw consumable-type id. */
  id: number;
  /** Activation time (s). */
  t0: number;
  /** Window end (s): activation + the decoded workTimeLeft. */
  t1: number;
}

/** Every window of ONE ship's consumables in `ids`, time-ordered. A use whose
 *  duration did not decode (0) is skipped: an instant has no window to show. */
export function consumableWindows(
  uses: readonly ConsumableUseEvent[] | null | undefined,
  entityId: number,
  ids: ReadonlySet<number>,
): ConsumableWindow[] {
  if (!uses || uses.length === 0) return [];
  const out: ConsumableWindow[] = [];
  for (const u of uses) {
    if (u.entityId !== entityId) continue;
    if (!ids.has(u.consumableId)) continue;
    if (!(u.duration > 0)) continue;
    out.push({ id: u.consumableId, t0: u.time, t1: u.time + u.duration });
  }
  out.sort((a, b) => a.t0 - b.t0);
  return out;
}

/** The newest window covering `t` (a re-fired consumable restarts the chip),
 *  or null when none is open. */
export function activeConsumableAt(
  windows: readonly ConsumableWindow[],
  t: number,
): ConsumableWindow | null {
  let best: ConsumableWindow | null = null;
  for (const w of windows) {
    if (t < w.t0) break;
    if (t <= w.t1) best = w;
  }
  return best;
}

/** The newest window that STARTED at or before `t` (even if it has since
 *  closed) — the deployment lookup needs the use that opened a wing's flight,
 *  whose window usually outlives the deployment. */
export function lastConsumableUseAt(
  windows: readonly ConsumableWindow[],
  t: number,
): ConsumableWindow | null {
  let best: ConsumableWindow | null = null;
  for (const w of windows) {
    if (w.t0 > t) break;
    best = w;
  }
  return best;
}
