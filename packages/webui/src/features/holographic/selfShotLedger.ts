/**
 * Precomputed ledger of the recorder's own projectile hits — the data
 * behind the live self-statistics card (hits / damage / frags), extracted
 * from HolographicMap's per-frame `selfStats` computed.
 *
 * The shot events and the ship trajectories are immutable for the whole
 * replay, so the expensive part (per event: sample every ship trajectory,
 * HP-delta in the impact window, death proximity for the frag credit) runs
 * ONCE per stream change instead of every playback frame; the per-frame
 * query is a binary search plus three prefix-sum reads. Scrub-safe: the
 * query at time t returns exactly what a from-scratch scan of all events
 * at or before t would.
 */
import { sampleAt, hpAtTime } from "./trajectoryMath";
import type { EntityTrajectory, ShotKillEvent } from "@/api";

/** Damage-attribution window around an impact (the old inline constants):
 *  ships within 500 m of the impact, HP sampled 0.4 s before / 0.6 s after,
 *  a drop over 50 counts as this shell's damage; a death within ±1.2 s of
 *  the impact credits a frag (unless the sink was inferred while dark). */
const IMPACT_RADIUS = 500;
const HP_BEFORE_S = 0.4;
const HP_AFTER_S = 0.6;
const HP_DROP_MIN = 50;
const FRAG_WINDOW_S = 1.2;

export interface SelfShotLedger {
  /** Sorted event times (parallel to the prefix arrays). */
  times: number[];
  /** Cumulative hits / damage / frags at each event, index-aligned —
   *  entry i sums events 0..i. */
  hits: number[];
  damage: number[];
  frags: number[];
}

export interface SelfShotLedgerParams {
  shotKills: ShotKillEvent[];
  trajectories: EntityTrajectory[];
  selfEntityId: number;
  /** Entity ids whose deathTime was inferred from the post-battle payload
   *  (sank while un-spotted) — excluded from proximity frag credit. */
  inferredDeaths?: Set<number>;
}

/** Build the ledger. Pure — no scene objects, unit-testable. */
export function buildSelfShotLedger({
  shotKills,
  trajectories,
  selfEntityId,
  inferredDeaths,
}: SelfShotLedgerParams): SelfShotLedger {
  // The victim-candidate list is the same for every event — hoist the
  // type-2 filter out of the event loop (the old per-frame code re-walked
  // ALL trajectories per shot).
  const ships = trajectories.filter(
    (tr) => tr.kind?.entityType === 2 && tr.entityId !== selfEntityId,
  );
  const events: { time: number; hits: number; damage: number; frags: number }[] = [];
  for (const e of shotKills) {
    if (e.ownerId !== selfEntityId) continue;
    let damage = 0;
    let frags = 0;
    for (const tr of ships) {
      const at = sampleAt(tr, e.time);
      if (!at) continue;
      if (Math.hypot(at.x - e.x, at.z - e.z) > IMPACT_RADIUS) continue;
      const hpBefore = hpAtTime(tr.hpSamples, e.time - HP_BEFORE_S);
      const hpAfter = hpAtTime(tr.hpSamples, e.time + HP_AFTER_S);
      if (hpBefore != null && hpAfter != null && hpBefore - hpAfter > HP_DROP_MIN) {
        damage += hpBefore - hpAfter;
      }
      const death = tr.deathTime;
      if (
        death != null &&
        !(inferredDeaths?.has(tr.entityId) ?? false) &&
        Math.abs(death - e.time) < FRAG_WINDOW_S
      ) {
        frags++;
      }
    }
    events.push({ time: e.time, hits: 1, damage, frags });
  }
  // The kill stream is not time-sorted in all dumps — the old scan summed
  // every event at or before the playhead regardless of order; sorting
  // into prefix sums preserves exactly that semantics.
  events.sort((a, b) => a.time - b.time);
  const times: number[] = [];
  const hits: number[] = [];
  const damage: number[] = [];
  const frags: number[] = [];
  let accH = 0;
  let accD = 0;
  let accF = 0;
  for (const ev of events) {
    accH += ev.hits;
    accD += ev.damage;
    accF += ev.frags;
    times.push(ev.time);
    hits.push(accH);
    damage.push(accD);
    frags.push(accF);
  }
  return { times, hits, damage, frags };
}

/** Hits / damage / frags at playhead `t`: the prefix sums of every event
 *  at or before t (O(log n); zero-entry ledger → all zeros). */
export function querySelfShotLedger(
  ledger: SelfShotLedger,
  t: number,
): { hits: number; damage: number; frags: number } {
  const { times, hits, damage, frags } = ledger;
  // Upper bound: first index with times[idx] > t.
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return { hits: 0, damage: 0, frags: 0 };
  return { hits: hits[lo - 1], damage: damage[lo - 1], frags: frags[lo - 1] };
}
