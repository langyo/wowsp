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

/** The client renders bots as `:NAME:`. */
const AI_NAME = /^:.*:$/;

export function isAiName(name: string): boolean {
  return AI_NAME.test(name);
}

export interface RosterStat {
  winrate: number | null;
  pr: number | null;
  avgDamage: number | null;
  battles: number | null;
  hidden: boolean;
  loading: boolean;
}

const statCache = new Map<string, RosterStat>();
const STAT_CACHE_MAX = 2000;

const emptyStat = (loading: boolean): RosterStat => ({
  winrate: null,
  pr: null,
  avgDamage: null,
  battles: null,
  hidden: false,
  loading,
});

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

  function cacheKey(name: string): string {
    return `${options.realm()}:${name}`;
  }

  /** Seed per-vehicle stats from cache; queue the rest for a batch call. */
  function ensureStats(vehicles: VehicleEntry[]) {
    for (const v of vehicles) {
      if (AI_NAME.test(v.name)) continue;
      const cached = statCache.get(cacheKey(v.name));
      if (cached) {
        stats.set(v.id, { ...cached });
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
      const results = await api.lookupPlayersStatsBatch(names, options.realm());
      if (gen !== battleGen) return;
      names.forEach((name, i) => {
        const r = results[i];
        applyStat(
          name,
          r
            ? {
                winrate: r.winrate ?? null,
                pr: r.pr ?? null,
                avgDamage: r.avgDamage ?? null,
                battles: r.battles ?? null,
                hidden: r.hidden,
                loading: false,
              }
            : // Not found on this realm — resolve to "no data" so the card
              // doesn't spin forever.
              emptyStat(false),
        );
      });
    } catch {
      if (gen !== battleGen) return;
      // Transient (WG limits / network): settle the spinners, then retry
      // the failed batch after a backoff pause — at most `retriesLeft`
      // times per battle (a hard-down API must not be probed all battle
      // long). Cards show "—" until a retry lands.
      for (const name of names) {
        for (const v of options.arena()?.vehicles ?? []) {
          if (v.name === name && stats.get(v.id)?.loading) {
            stats.set(v.id, emptyStat(false));
          }
        }
      }
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
      retriesLeft = 2;
      if (a) ensureStats(a.vehicles);
    },
    { immediate: true },
  );

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

  return { stats };
}
