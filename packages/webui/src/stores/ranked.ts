import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type RankedSeasonStats } from "@/api";
import { aggregateRankedWinrate } from "@/utils/ranked";

/** Ranked battle stats store. Wraps `get_ranked_stats` with an in-memory cache. */
export const useRankedStore = defineStore("ranked", () => {
  const seasons = ref<RankedSeasonStats[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** Whose seasons these are — the store is a single slot shared across
   *  views, so consumers (e.g. the ship-detail tab) must check this before
   *  presenting `winrate` as "the ranked WR of player X". */
  const accountId = ref<number | null>(null);

  /** Combined winrate across the loaded seasons (null = no ranked battles). */
  const winrate = computed(() => aggregateRankedWinrate(seasons.value));

  /** Combined ranked battles across the loaded seasons (tooltip data).
   *  Null until a load actually wrote the slot (empty = not loaded / failed /
   *  reset — "unknown", not "zero battles"; a successful load with 0 ranked
   *  battles still reports 0). */
  const battles = computed(() =>
    accountId.value == null ? null : seasons.value.reduce((n, s) => n + s.battles, 0),
  );

  /** Supersedence token: the store is a single slot (not keyed per player),
   *  so only the newest load (or a reset) may write state — a slow response
   *  for a previous player must never clobber the current one's data. */
  let token = 0;

  async function load(id: number, realm: string, seasonCount = 5) {
    const current = ++token;
    loading.value = true;
    error.value = null;
    try {
      const data = await api.getRankedStats(id, realm, seasonCount);
      if (current !== token) return;
      seasons.value = data;
      accountId.value = id;
    } catch (e) {
      if (current !== token) return;
      error.value = (e as Error).message;
      seasons.value = [];
      accountId.value = null;
    } finally {
      if (current === token) loading.value = false;
    }
  }

  /** Drop cached seasons (and the derived winrate) before a new lookup. */
  function reset() {
    token++;
    seasons.value = [];
    error.value = null;
    accountId.value = null;
  }

  return { seasons, loading, error, accountId, winrate, battles, load, reset };
});
