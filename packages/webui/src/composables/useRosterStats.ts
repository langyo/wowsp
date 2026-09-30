/**
 * Roster batch-stats pipeline for the main window's LiveBattlePanel. (The
 * in-game overlay window is a static page that runs its own tiny version of
 * this pipeline — see src/overlay/main.ts — because it does not load Vue.)
 *
 * Names missing from the module-scope cache are collected and sent as ONE
 * debounced `lookup_players_stats_batch` RPC (the backend fans them out with
 * bounded parallelism). Battle-generation guards keep stale responses from
 * writing into a new battle's stats (vehicle ids repeat across battles), and
 * a bounded retry with backoff rides out transient WG-API failures.
 *
 * The module-scope `statCache` is per-window (main and overlay windows are
 * separate JS contexts) — players queue together for many games, so
 * re-encountered names render instantly without another WG hit.
 */
import { onBeforeUnmount, reactive, watch } from "vue";

import { api, type ArenaInfo, type VehicleEntry } from "@/api";
import { lookupClanWinrate } from "@/utils/clanWinrate";
import { prAlgoForRequest } from "@/stores/statsPrefs";
import type { RosterModeNumbers } from "@/utils/statView";
import { AI_NAME, isAiName } from "@/utils/aiNames";

// Re-exports keep the historical import paths (`AI_NAME` was defined here
// before the overlay page needed it too — see utils/aiNames.ts).
export { AI_NAME, isAiName };

export interface RosterStat {
  winrate: number | null;
  pr: number | null;
  avgDamage: number | null;
  battles: number | null;
  /** Ranked (排位) career numbers off the same batch answer; null = never
   *  played ranked. Consumed by the stats-source mode selector
   *  (utils/statView) on every roster surface. */
  ranked: RosterModeNumbers | null;
  /** Global career (randoms + ranked merged server-side); null = the
   *  payload carried no stats at all (older shell). */
  global: RosterModeNumbers | null;
  /** Clan id from the batch answer (null = clanless / not found) — joins
   *  the hidden-profile 过街老鼠 clan gate. */
  clanId: number | null;
  /** Clan tag from the same batch answer (`HOOD` — rendered as [HOOD]
   *  beside the nickname; null = clanless / not found / still loading). */
  clanTag: string | null;
  /** Resolved clan winrate for the rat gate: undefined = not judged yet
   *  (a hidden + clanful entry holds its stamp until this lands) or no
   *  judgment needed; a number passes to careerStamp's gate; null = the
   *  lookup failed → fail-open stamp. */
  clanWinrate?: number | null;
  hidden: boolean;
  loading: boolean;
}

const statCache = new Map<string, RosterStat>();
const STAT_CACHE_MAX = 2000;

/** Cache key embeds the request algorithm: the batch answers PR=null under
 *  "expected" (see the backend's `apply_batch_pr_algo`), so an entry cached
 *  under one algorithm must never serve a view switched to the other —
 *  without the tag, toggling the pref would keep the old caliber (numbers
 *  or dashes) until restart. `undefined` (rating off) maps to "default" =
 *  the backend's winrate default. */
function rosterCacheKey(realm: string, name: string): string {
  return `${prAlgoForRequest() ?? "default"}:${realm}:${name}`;
}

const emptyStat = (loading: boolean): RosterStat => ({
  winrate: null,
  pr: null,
  avgDamage: null,
  battles: null,
  ranked: null,
  global: null,
  clanId: null,
  clanTag: null,
  hidden: false,
  loading,
});

/** The per-mode payloads a batch answer carries, or null when the mode's
 *  numbers are entirely absent (never played / older shell without the
 *  global fields). */
function modeStatsOf(
  has: boolean,
  pick: () => RosterModeNumbers,
): RosterModeNumbers | null {
  return has ? pick() : null;
}

/** Map one batch-answer row onto a `RosterStat` (shared by the live
 *  pipeline and the one-shot name lookup). */
function rosterStatOf(r: {
  winrate?: number | null;
  pr?: number | null;
  avgDamage?: number | null;
  battles?: number | null;
  rankedWinrate?: number | null;
  rankedPr?: number | null;
  rankedAvgDamage?: number | null;
  rankedBattles?: number | null;
  globalWinrate?: number | null;
  globalPr?: number | null;
  globalAvgDamage?: number | null;
  globalBattles?: number | null;
  clanId?: number | null;
  clanTag?: string | null;
  hidden: boolean;
}): RosterStat {
  return {
    winrate: r.winrate ?? null,
    pr: r.pr ?? null,
    avgDamage: r.avgDamage ?? null,
    battles: r.battles ?? null,
    ranked: modeStatsOf(
      r.rankedBattles != null || r.rankedWinrate != null,
      () => ({
        winrate: r.rankedWinrate ?? null,
        pr: r.rankedPr ?? null,
        battles: r.rankedBattles ?? null,
        avgDamage: r.rankedAvgDamage ?? null,
      }),
    ),
    global: modeStatsOf(
      r.globalBattles != null || r.globalWinrate != null,
      () => ({
        winrate: r.globalWinrate ?? null,
        pr: r.globalPr ?? null,
        battles: r.globalBattles ?? null,
        avgDamage: r.globalAvgDamage ?? null,
      }),
    ),
    clanId: r.clanId ?? null,
    clanTag: r.clanTag ?? null,
    hidden: r.hidden,
    loading: false,
  };
}

/** Kick the hidden-profile clan gate for one landed stat: hidden + clanful +
 *  not-yet-judged entries resolve the clan's winrate (cached and deduped in
 *  utils/clanWinrate — one clans/info call per clan per window) and write
 *  the verdict back into THIS cache's entry in place, so a later lookup
 *  seeding the name from cache carries the verdict instantly. `onResolved`
 *  lets the live pipeline mirror the verdict into its reactive slots (it
 *  owns the battle-generation guard); the one-shot name-keyed pipeline
 *  passes none — its consumers already hold the same object. */
function resolveClanGate(
  st: RosterStat,
  key: string,
  realm: string,
  onResolved?: (wr: number | null) => void,
): void {
  if (!st.hidden || st.clanId == null || st.clanWinrate !== undefined) return;
  void lookupClanWinrate(realm, st.clanId).then((wr) => {
    const cached = statCache.get(key);
    if (cached && cached.clanWinrate === undefined) cached.clanWinrate = wr;
    onResolved?.(wr);
  });
}

export interface UseRosterStatsOptions {
  /** Reactive realm getter (account store / game process / overlay URL). */
  realm: () => string;
  /** Reactive arena getter — a new `dateTime` means a new battle. */
  arena: () => ArenaInfo | null;
}

export function useRosterStats(options: UseRosterStatsOptions) {
  const stats = reactive(new Map<number, RosterStat>());

  let battleGen = 0;
  const pendingNames = new Set<string>();
  /** Names waiting for the backoff retry (kept apart from `pendingNames`
   *  so the post-batch reschedule only ever picks up fresh names). */
  const retryNames = new Set<string>();
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  /** Batch retries left for the current battle (reset on battle change) —
   *  keeps a hard-down WG API from being probed all battle long. */
  let retriesLeft = 2;
  /** Names whose last batch attempt FAILED (transport / WG limits) — they
   *  ride the slow re-probe below until the network heals. Kept apart from
   *  the retry burst so a hard-down API is still not probed at burst rate. */
  const failedNames = new Set<string>();
  let reprobeTimer: ReturnType<typeof setTimeout> | null = null;
  let reprobesLeft = 0;

  function cacheKey(name: string): string {
    return rosterCacheKey(options.realm(), name);
  }

  /** Seed per-vehicle stats from cache; queue the rest for a batch call. */
  function ensureStats(vehicles: VehicleEntry[]) {
    for (const v of vehicles) {
      if (AI_NAME.test(v.name)) continue;
      const cached = statCache.get(cacheKey(v.name));
      if (cached) {
        stats.set(v.id, { ...cached });
        // A cached entry whose clan verdict is still out (its gate fired in
        // an earlier battle and the lookup is in flight or was superseded
        // by a battle switch) re-fires here under the CURRENT generation,
        // so the verdict reaches this battle's reactive slots too; already
        // judged entries are a no-op.
        gateClanWinrate(v.name, cached, battleGen);
        continue;
      }
      if (stats.has(v.id)) continue;
      stats.set(v.id, emptyStat(true));
      pendingNames.add(v.name);
    }
    // An empty realm (overlay window still resolving it) means the cache key
    // would be wrong — hold the batch until the realm resolves.
    if (!options.realm()) return;
    if (pendingNames.size > 0 && !batchTimer && !inFlight) {
      batchTimer = setTimeout(runBatch, 250);
    }
  }

  function applyStat(name: string, st: RosterStat) {
    if (statCache.size >= STAT_CACHE_MAX) statCache.clear();
    statCache.set(cacheKey(name), st);
    // Write into every roster slot carrying this name (one per battle).
    for (const v of options.arena()?.vehicles ?? []) {
      if (v.name === name && !AI_NAME.test(name)) stats.set(v.id, { ...st });
    }
  }

  /** Resolve the rat-stamp clan gate for a landed roster entry and mirror
   *  the verdict into every same-name reactive slot. `gen` pins the verdict
   *  to the battle it was fired under: if the battle switched while the
   *  lookup was out, the verdict still lands in the module cache
   *  (resolveClanGate) but the reactive map is left alone — vehicle ids
   *  repeat across battles, and a new battle's slots must only carry its
   *  own lookups. */
  function gateClanWinrate(name: string, st: RosterStat, gen: number) {
    const key = cacheKey(name);
    resolveClanGate(st, key, options.realm(), (wr) => {
      if (gen !== battleGen) return;
      const clanId = st.clanId;
      if (clanId == null) return;
      for (const v of options.arena()?.vehicles ?? []) {
        if (v.name !== name || AI_NAME.test(name)) continue;
        const slot = stats.get(v.id);
        if (slot && slot.hidden && slot.clanId === clanId && slot.clanWinrate === undefined) {
          slot.clanWinrate = wr;
        }
      }
    });
  }

  async function runBatch() {
    batchTimer = null;
    if (pendingNames.size === 0) return;
    if (inFlight) {
      // A call is still out; retry shortly with the (possibly grown) set.
      batchTimer = setTimeout(runBatch, 400);
      return;
    }
    const names = [...pendingNames];
    pendingNames.clear();
    const gen = battleGen;
    inFlight = true;
    try {
      const results = await api.lookupPlayersStatsBatch(
        names,
        options.realm(),
        prAlgoForRequest(),
      );
      if (gen !== battleGen) return;
      // Success: failures from earlier rounds are answered now — stop the
      // slow re-probe and forget them.
      for (const name of names) failedNames.delete(name);
      if (failedNames.size === 0 && reprobeTimer) {
        clearTimeout(reprobeTimer);
        reprobeTimer = null;
      }
      names.forEach((name, i) => {
        const r = results[i];
        const st = r
          ? rosterStatOf(r)
          : // Not found on this realm — resolve to "no data" so the card
            // doesn't spin forever.
            emptyStat(false);
        applyStat(name, st);
        gateClanWinrate(name, st, gen);
      });
    } catch {
      if (gen !== battleGen) return;
      // Transient (WG limits / network): settle the spinners, then retry
      // the failed batch after a backoff pause — at most `retriesLeft`
      // times per battle (a hard-down API must not be probed all battle
      // long). Cards show "—" until a retry lands.
      for (const name of names) {
        for (const v of options.arena()?.vehicles ?? []) {
          const prev = stats.get(v.id);
          if (v.name === name && prev?.loading) {
            // A failed batch must not wipe already-loaded stats: keep the
            // previous values (spinner off) and only true spinners resolve
            // to "—" — the manual refresh relies on this too.
            const hasData = prev.winrate != null || prev.pr != null || prev.avgDamage != null;
            stats.set(v.id, hasData ? { ...prev, loading: false } : emptyStat(false));
          }
        }
      }
      for (const name of names) failedNames.add(name);
      if (retriesLeft > 0) {
        retriesLeft -= 1;
        for (const name of names) retryNames.add(name);
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (gen !== battleGen) return;
            for (const name of retryNames) pendingNames.add(name);
            retryNames.clear();
            if (!batchTimer && !inFlight && pendingNames.size > 0) {
              batchTimer = setTimeout(runBatch, 100);
            }
          }, 3000);
        }
      } else {
        // Burst retries exhausted (an outage longer than ~9 s): park the
        // failures on a SLOW re-probe — once per 30 s, a bounded number of
        // times per battle — so stats appear the moment the network heals
        // instead of staying dead for the whole battle.
        for (const name of names) retryNames.add(name);
        if (reprobesLeft > 0 && !reprobeTimer) {
          reprobeTimer = setTimeout(() => {
            reprobeTimer = null;
            if (gen !== battleGen) return;
            reprobesLeft -= 1;
            for (const name of retryNames) pendingNames.add(name);
            retryNames.clear();
            if (!batchTimer && !inFlight && pendingNames.size > 0) {
              batchTimer = setTimeout(runBatch, 100);
            }
          }, 30_000);
        }
      }
    } finally {
      inFlight = false;
      // Players often load into the roster mid-battle — pick up the delta
      // here. Fresh names only: a scheduled backoff retry owns its own
      // timing and drains `retryNames` on fire.
      if (pendingNames.size > 0 && !batchTimer && !retryTimer) {
        batchTimer = setTimeout(runBatch, 250);
      }
    }
  }

  // The arena object is re-read every few seconds while a live pane is open,
  // and every read arrives as a fresh object — so the snapshot must never be
  // compared by reference. Reset the queue only when the battle itself
  // changed (dateTime is the battle-start stamp); within one battle, just
  // pick up roster additions and keep every finished lookup (cache hits are
  // instant anyway).
  let battleStamp: string | null | undefined;
  watch(
    () => options.arena(),
    (a) => {
      const stamp = a?.dateTime ?? null;
      if (a && stamp === battleStamp) {
        ensureStats(a.vehicles);
        return;
      }
      battleStamp = stamp;
      battleGen += 1;
      stats.clear();
      pendingNames.clear();
      retryNames.clear();
      failedNames.clear();
      if (reprobeTimer) {
        clearTimeout(reprobeTimer);
        reprobeTimer = null;
      }
      retriesLeft = 2;
      reprobesLeft = 10;
      if (a) ensureStats(a.vehicles);
    },
    { immediate: true },
  );

  /** Manual full refresh: wipe the backend session cache, re-queue the
   *  WHOLE roster, and mark every loaded row as refreshing WITHOUT
   *  clearing its values (a failed re-request keeps what was shown). */
  async function forceRefresh() {
    const arena = options.arena();
    if (!arena || inFlight) return;
    try {
      await api.clearRosterStatsCache();
    } catch {
      // older shell — the re-request may answer from cache; still useful
    }
    const vehicles = arena.vehicles.filter((v) => !isAiName(v.name));
    for (const v of vehicles) {
      const prev = stats.get(v.id);
      if (prev && !prev.loading) stats.set(v.id, { ...prev, loading: true });
    }
    for (const v of vehicles) pendingNames.add(v.name);
    if (!batchTimer && !inFlight && pendingNames.size > 0) {
      batchTimer = setTimeout(runBatch, 100);
    }
  }

  // A late-resolved (or switched) realm changes every cache key — re-seed
  // the roster so lookups fire against the right realm instead of spinning
  // on "no data" results cached under the old one.
  watch(
    () => options.realm(),
    () => {
      const a = options.arena();
      if (a) ensureStats(a.vehicles);
    },
  );

  onBeforeUnmount(() => {
    battleGen += 1;
    if (batchTimer) clearTimeout(batchTimer);
    if (retryTimer) clearTimeout(retryTimer);
    // Empty the queues so an in-flight batch's reschedule path finds
    // nothing to re-run after unmount.
    pendingNames.clear();
    retryNames.clear();
  });

  return {
    forceRefresh, stats };
}

/**
 * One-shot name-keyed roster lookup for the post-battle panels. Serves warm
 * entries from the same module-scope cache the live pipeline uses (players
 * just seen in the live roster render instantly) and sends only the misses
 * as a single batch RPC. Names that fail to resolve (not found / RPC error)
 * are simply absent from the returned map — callers render "—".
 */
export async function fetchRosterStatsByNames(
  names: string[],
  realm: string,
): Promise<Map<string, RosterStat>> {
  const out = new Map<string, RosterStat>();
  if (!realm) return out;
  const misses: string[] = [];
  for (const name of names) {
    if (isAiName(name)) continue;
    // Cache hits are NOT re-fired through the clan gate (unlike ensureStats):
    // no current consumer renders career stamps off this one-shot map, and a
    // hit returns the cached object itself, so an in-flight verdict still
    // lands on it via resolveClanGate's writeback. A future stamp-rendering
    // consumer must re-fire the gate here or a pending verdict (undefined)
    // would hold its stamp forever.
    const cached = statCache.get(rosterCacheKey(realm, name));
    if (cached) out.set(name, cached);
    else misses.push(name);
  }
  if (misses.length === 0) return out;
  try {
    const results = await api.lookupPlayersStatsBatch(misses, realm, prAlgoForRequest());
    misses.forEach((name, i) => {
      const r = results[i];
      const st = r ? rosterStatOf(r) : emptyStat(false);
      const key = rosterCacheKey(realm, name);
      if (statCache.size >= STAT_CACHE_MAX) statCache.clear();
      statCache.set(key, st);
      out.set(name, st);
      // No battle generation to guard here — the verdict only needs the
      // module-cache writeback (callers already hold the same object).
      resolveClanGate(st, key, realm);
    });
  } catch {
    /* transient lookup failure — leave the misses out; cells show "—" */
  }
  return out;
}
