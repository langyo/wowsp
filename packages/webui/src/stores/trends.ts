import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type CommunityTrend, type ShipServerStats, type TrendResult } from "@/api";

/** Player career trend + community trend store. The player trend is bucketed
 *  by game version on the Rust side (from the snapshot history); community
 *  data covers the wows-numbers server-wide per-ship averages (live fetch
 *  with a Rust-side 7-day disk cache) plus the curated version-bucket
 *  contract (available:false until a backend partner is wired in). */
export const useTrendsStore = defineStore("trends", () => {
  const playerTrend = ref<TrendResult | null>(null);
  const communityTrend = ref<CommunityTrend | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /** Server-wide averages for the ship currently open in the detail modal. */
  const serverStats = ref<ShipServerStats | null>(null);
  const serverLoading = ref(false);
  const serverError = ref<string | null>(null);
  /** Monotonic sequence for server-stats loads: a ship switch while a fetch
   *  is pending must discard the stale resolution (wrong ship's numbers /
   *  error state, or a `finally` that kills the new ship's spinner). */
  let serverSeq = 0;

  /** Load the version-bucketed trend for a player. */
  async function loadPlayer(accountId: number, realm: string) {
    loading.value = true;
    error.value = null;
    try {
      playerTrend.value = await api.getPlayerTrend(accountId, realm);
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  /** Load community-wide trend for a ship (placeholder — returns
   *  available:false until a data source is wired). */
  async function loadCommunity(shipId: number) {
    try {
      communityTrend.value = await api.getCommunityShipTrend(shipId);
    } catch {
      communityTrend.value = { available: false, shipId, buckets: [] };
    }
  }

  /** Load server-wide averages for a ship (wows-numbers expected values).
   *  Null result = the ship has no server sample; errors are captured in
   *  `serverError` for the retry UI. */
  async function loadServerStats(shipId: number) {
    const seq = ++serverSeq;
    serverLoading.value = true;
    serverError.value = null;
    try {
      const stats = await api.getShipServerStats(shipId);
      if (seq !== serverSeq) return; // superseded by a newer ship's load
      serverStats.value = stats;
    } catch (e) {
      if (seq !== serverSeq) return;
      serverStats.value = null;
      serverError.value = (e as Error).message || String(e);
    } finally {
      if (seq === serverSeq) serverLoading.value = false;
    }
  }

  return {
    playerTrend,
    communityTrend,
    loading,
    error,
    loadPlayer,
    loadCommunity,
    serverStats,
    serverLoading,
    serverError,
    loadServerStats,
  };
});
