import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type ClanInfo } from "@/api";
import { prAlgoForRequest } from "@/stores/statsPrefs";

/** Clan lookups for the /lookup page. In-memory only: route switches keep
 *  the result via this store, but there is no disk cache — rosters churn
 *  too much to be a useful persistent cache and each lookup is just two WG
 *  requests (clans/info + one batched account/info).
 *
 *  The PR algorithm travels with every lookup (the roster answers member
 *  PR=null under "expected"), and the cache key embeds it: entries written
 *  under one algorithm must never serve a view switched to the other —
 *  otherwise toggling the pref would keep rendering the old caliber until
 *  restart. LookupView's last-result restore reads through `clanCacheKey`. */
export function clanCacheKey(realm: string, clanId: number): string {
  return `${prAlgoForRequest() ?? "default"}_${realm}_${clanId}`;
}

export const useClanStatsStore = defineStore("clanStats", () => {
  const cache = ref<Map<string, ClanInfo>>(new Map());
  const loading = ref(false);
  const error = ref<string | null>(null);

  /** Look up a clan by id. `force: true` (explicit user query) always
   *  re-pulls from the WG API; otherwise an in-memory hit is returned. */
  async function lookup(
    clanId: number,
    realm: string,
    opts: { force?: boolean } = {},
  ): Promise<ClanInfo> {
    const key = clanCacheKey(realm, clanId);
    if (!opts.force) {
      const cached = cache.value.get(key);
      if (cached) return cached;
    }
    loading.value = true;
    error.value = null;
    try {
      const info = await api.lookupClanInfo(clanId, realm, prAlgoForRequest());
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
