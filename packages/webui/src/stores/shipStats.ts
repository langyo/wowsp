import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type PlayerShipStats, type ShipStatsHistoryPoint } from "@/api";
import { prAlgoForRequest } from "@/stores/statsPrefs";

/** Per-player per-ship stats store. Wraps `lookup_player_ship_stats` with an
 *  in-memory cache keyed by `${realm}_${accountId}`. The Rust layer also
 *  persists to `ship-stats/<realm>_<accountId>.json` for offline fallback. */
export const useShipStatsStore = defineStore("shipStats", () => {
  const cache = ref<Map<string, PlayerShipStats[]>>(new Map());
  /** Per-ship history points per player — the baselines that let the UI
   *  compute real "recent N days" deltas from career totals. */
  const history = ref<Map<string, ShipStatsHistoryPoint[]>>(new Map());
  /** accountId-keyed fetch timestamps (`realm_accountId` → epoch ms) — the
   *  feed for load()'s `ttlMs` guard. */
  const fetchedAt = ref<Map<string, number>>(new Map());
  const loading = ref(false);
  const error = ref<string | null>(null);

  function key(realm: string, accountId: number) {
    return `${realm}_${accountId}`;
  }

  /** Read the persisted history points for a player. Best-effort: an
   *  unreadable history just means the UI falls back to career totals. */
  async function loadHistory(accountId: number, realm: string): Promise<ShipStatsHistoryPoint[]> {
    try {
      const points = await api.readShipStatsHistory(accountId, realm);
      history.value.set(key(realm, accountId), points);
      return points;
    } catch {
      return [];
    }
  }

  /** Look up a player's per-ship stats. By default always re-fetches (the
   *  player may have played new battles) but falls back to cache on network
   *  failure. `ttlMs` opts into serving a cached result younger than the
   *  TTL instead — the dashboard passes one so revisits inside the window
   *  don't re-query the WG API. */
  async function load(
    accountId: number,
    realm: string,
    opts: { ttlMs?: number } = {},
  ): Promise<PlayerShipStats[]> {
    const k = key(realm, accountId);
    const { ttlMs = 0 } = opts;
    const cached = cache.value.get(k);
    if (cached && ttlMs > 0 && Date.now() - (fetchedAt.value.get(k) ?? 0) < ttlMs) {
      return cached;
    }
    loading.value = true;
    error.value = null;
    try {
      const stats = await api.lookupPlayerShipStats(accountId, realm, prAlgoForRequest());
      cache.value.set(k, stats);
      fetchedAt.value.set(k, Date.now());
      return stats;
    } catch (e) {
      error.value = (e as Error).message;
      // Return stale cache if available.
      const stale = cache.value.get(key(realm, accountId));
      if (stale) return stale;
      throw e;
    } finally {
      loading.value = false;
      // The Rust side appended a history point on the successful fetch (or
      // the fetch failed and history is unchanged either way) — refresh the
      // history cache so delta views see the latest baselines.
      void loadHistory(accountId, realm);
    }
  }

  /** Get a single ship's stats for a player (or null if unplayed). */
  function getShip(accountId: number, realm: string, shipId: number): PlayerShipStats | null {
    const stats = cache.value.get(key(realm, accountId));
    return stats?.find((s) => s.shipId === shipId) ?? null;
  }

  return { cache, history, loading, error, load, loadHistory, getShip };
});
