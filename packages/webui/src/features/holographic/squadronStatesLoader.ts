/**
 * Squadron-state loader for the holographic map's plane-follow extras: the
 * single IPC fetch of read_replay_squadron_states (experiment E27 — see
 * SquadronStateEvents), cached per replay path.
 *
 * WHY a loader at all: HolographicMap re-derives the pill card at the 10 Hz
 * hudCurrent cadence, but the underlying decode is seconds-scale CPU work —
 * so the fetch must happen exactly once per replay, not per card refresh.
 * The cached-promise map follows insightsLoader / the i18n localeLoads
 * pattern: the first call for a path wins and every later caller shares
 * that promise; a REJECTED load is evicted so a transient transport error
 * retries on the next call instead of poisoning the cache for the session.
 *
 * Failures resolve to the shared EMPTY aggregate rather than rejecting:
 * the streams only ENRICH the pill (HP bar, boost badge, consumable
 * chips), so a failed side-load degrades to the pre-E27 card and never
 * surfaces an error surface mid-battle. Retention is capped (FIFO) so
 * replay switching A→B→A stays cached while a long browsing session does
 * not accumulate every replay's events forever.
 */
import { api, type SquadronStateEvents } from "@/api";

/** The do-nothing aggregate — no streams at all. Loads that failed (and
 *  callers without squadron data) share this single frozen instance; every
 *  consumer reads its absent arrays with ?? [] / null-tolerance. */
export const EMPTY_SQUADRON_STATES: Readonly<SquadronStateEvents> = Object.freeze({});

/** How many replay paths keep their decoded squadron states. */
const MAX_RETAINED = 3;

/** In-flight/finished loads keyed by replay path. */
const loads = new Map<string, Promise<SquadronStateEvents>>();

/** The squadron-state events of one replay, fetched once per path. Always
 *  resolves — a failure yields EMPTY_SQUADRON_STATES (see the header WHY),
 *  and is evicted so the next call retries. */
export function loadSquadronStates(path: string): Promise<SquadronStateEvents> {
  const cached = loads.get(path);
  if (cached) return cached;
  const attempt = api.readReplaySquadronStates(path);
  const settled = attempt.catch(() => EMPTY_SQUADRON_STATES);
  // Evict only OUR settled entry: by rejection time the map may already
  // hold a newer retry for the same path, which must survive.
  attempt.catch(() => {
    if (loads.get(path) === settled) loads.delete(path);
  });
  loads.set(path, settled);
  while (loads.size > MAX_RETAINED) {
    // Map iterates in insertion order — the oldest path rotates out first.
    const oldest = loads.keys().next();
    if (oldest.done) break;
    loads.delete(oldest.value);
  }
  return settled;
}
