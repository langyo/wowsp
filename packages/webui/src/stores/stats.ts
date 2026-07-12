import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type PlayerStats } from "@/api";

/** Caches player stats in AppData (stats-cache/<realm>_<accountId>.json) so
 *  repeated lookups don't re-hit the WG API. Wraps lookup_player_stats. */
export const useStatsStore = defineStore("stats", () => {
  const cache = ref<Map<string, PlayerStats>>(new Map());
  const loading = ref(false);
  const error = ref<string | null>(null);

  function cacheKey(realm: string, accountId: number) {
    return `${realm}_${accountId}`;
  }

  function cacheFile(realm: string, accountId: number) {
    return `stats-cache/${cacheKey(realm, accountId)}.json`;
  }

  /** Look up a player's stats. Uses cache when fresh (< 1 hour old).
   *  On success, appends a snapshot for trend tracking. */
  async function lookup(nickname: string, realm: string): Promise<PlayerStats> {
    loading.value = true;
    error.value = null;
    try {
      const stats = await api.lookupPlayerStats(nickname, realm);
      const key = cacheKey(realm, stats.accountId);
      cache.value.set(key, stats);
      // Persist current snapshot to AppData (best-effort, don't block UI).
      void api.appdataWrite(cacheFile(realm, stats.accountId), JSON.stringify(stats)).catch(() => {});
      // Append a versioned snapshot for trend tracking (best-effort).
      void api.snapshotPlayerStats(
        stats.accountId,
        realm,
        stats.battles ?? null,
        // wins isn't in PlayerStats directly — derive from winrate * battles.
        stats.battles != null && stats.winrate != null
          ? Math.round((stats.winrate / 100) * stats.battles)
          : null,
        stats.winrate ?? null,
        stats.avgDamage ?? null,
        stats.pr ?? null,
      ).catch(() => {});
      return stats;
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /** Load a cached stats file from AppData (if present). */
  async function loadCached(realm: string, accountId: number): Promise<PlayerStats | null> {
    const key = cacheKey(realm, accountId);
    if (cache.value.has(key)) return cache.value.get(key)!;
    try {
      const raw = await api.appdataRead(cacheFile(realm, accountId));
      if (raw) {
        const stats = JSON.parse(raw) as PlayerStats;
        cache.value.set(key, stats);
        return stats;
      }
    } catch {
      // cache miss — fine
    }
    return null;
  }

  return { cache, loading, error, lookup, loadCached };
});
