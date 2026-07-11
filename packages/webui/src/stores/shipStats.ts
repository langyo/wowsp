import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type PlayerShipStats } from "@/api";

/** Per-player per-ship stats store. Wraps `lookup_player_ship_stats` with an
 *  in-memory cache keyed by `${realm}_${accountId}`. The Rust layer also
 *  persists to `ship-stats/<realm>_<accountId>.json` for offline fallback. */
export const useShipStatsStore = defineStore("shipStats", () => {
  const cache = ref<Map<string, PlayerShipStats[]>>(new Map());
  const loading = ref(false);
  const error = ref<string | null>(null);

  function key(realm: string, accountId: number) {
    return `${realm}_${accountId}`;
  }

  /** Look up a player's per-ship stats. Always re-fetches (the player may
   *  have played new battles) but falls back to cache on network failure. */
  async function load(accountId: number, realm: string): Promise<PlayerShipStats[]> {
    loading.value = true;
    error.value = null;
    try {
      const stats = await api.lookupPlayerShipStats(accountId, realm);
      cache.value.set(key(realm, accountId), stats);
      return stats;
    } catch (e) {
      error.value = (e as Error).message;
      // Return stale cache if available.
      const stale = cache.value.get(key(realm, accountId));
      if (stale) return stale;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /** Get a single ship's stats for a player (or null if unplayed). */
  function getShip(accountId: number, realm: string, shipId: number): PlayerShipStats | null {
    const stats = cache.value.get(key(realm, accountId));
    return stats?.find((s) => s.shipId === shipId) ?? null;
  }

  return { cache, loading, error, load, getShip };
});
