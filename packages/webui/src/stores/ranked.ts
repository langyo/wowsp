import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type RankedSeasonStats } from "@/api";

/** Ranked battle stats store. Wraps `get_ranked_stats` with an in-memory cache. */
export const useRankedStore = defineStore("ranked", () => {
  const seasons = ref<RankedSeasonStats[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(accountId: number, realm: string, seasonCount = 5) {
    loading.value = true;
    error.value = null;
    try {
      seasons.value = await api.getRankedStats(accountId, realm, seasonCount);
    } catch (e) {
      error.value = (e as Error).message;
      seasons.value = [];
    } finally {
      loading.value = false;
    }
  }

  return { seasons, loading, error, load };
});
