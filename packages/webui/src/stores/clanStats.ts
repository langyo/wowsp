import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type ClanInfo } from "@/api";

/** Clan lookups for the /lookup page. In-memory only: route switches keep
 *  the result via this store, but there is no disk cache — rosters churn
 *  too much to be a useful persistent cache and each lookup is just two WG
 *  requests (clans/info + one batched account/info). */
export const useClanStatsStore = defineStore("clanStats", () => {
  const cache = ref<Map<string, ClanInfo>>(new Map());
  const loading = ref(false);
  const error = ref<string | null>(null);

  function cacheKey(realm: string, clanId: number) {
    return `${realm}_${clanId}`;
  }

  /** Look up a clan by id. `force: true` (explicit user query) always
   *  re-pulls from the WG API; otherwise an in-memory hit is returned. */
  async function lookup(
    clanId: number,
    realm: string,
    opts: { force?: boolean } = {},
  ): Promise<ClanInfo> {
    const key = cacheKey(realm, clanId);
    if (!opts.force) {
      const cached = cache.value.get(key);
      if (cached) return cached;
    }
    loading.value = true;
    error.value = null;
    try {
      const info = await api.lookupClanInfo(clanId, realm);
      cache.value.set(key, info);
      return info;
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  return { cache, loading, error, lookup };
});
