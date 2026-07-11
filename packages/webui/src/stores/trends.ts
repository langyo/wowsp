import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type CommunityTrend, type TrendResult } from "@/api";

/** Player career trend + community trend store. The player trend is bucketed
 *  by game version on the Rust side (from the snapshot history); community
 *  trend is a placeholder contract (returns available:false until a backend
 *  partner is wired in). */
export const useTrendsStore = defineStore("trends", () => {
  const playerTrend = ref<TrendResult | null>(null);
  const communityTrend = ref<CommunityTrend | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

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

  return { playerTrend, communityTrend, loading, error, loadPlayer, loadCommunity };
});
