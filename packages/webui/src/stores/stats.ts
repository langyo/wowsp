import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type PlayerStats } from "@/api";

/** Persisted-cache envelope for one player's stats (AppData). Old caches
 *  written before this envelope existed are plain PlayerStats JSON — the
 *  reader detects that shape and treats them as never-fresh. */
interface CachedStats {
  fetchedAt: number;
  stats: PlayerStats;
}

const INDEX_FILE = "stats-cache/index.json";

/** Caches player stats in AppData (stats-cache/<realm>_<accountId>.json) so
 *  repeated lookups don't re-hit the WG API. Wraps lookup_player_stats.
 *
 *  The cache is SHARED across the whole app: the dashboard/lookup pages and
 *  the replay hologram's follow menu all go through this store, so a player
 *  queried from either place is cached once and reused everywhere.
 *
 *  Refresh policy:
 *  - Your OWN account (activeAccount): callers pass `force: true` — every
 *    dashboard open re-pulls from the API.
 *  - Everyone else: passive lookups (replay menu) reuse the disk cache as
 *    long as it exists; only an explicit user query (`force: true`) hits
 *    the API again.
 */
export const useStatsStore = defineStore("stats", () => {
  const cache = ref<Map<string, PlayerStats>>(new Map());
  /** accountId-keyed fetch timestamps (`realm_accountId` → epoch ms). */
  const fetchedAt = ref<Map<string, number>>(new Map());
  /** nickname → accountId index (`realm_nickname-lower` → accountId),
   *  persisted so a replayed match can hit the cache without an API call. */
  const index = ref<Map<string, number>>(new Map());
  const loading = ref(false);
  const error = ref<string | null>(null);

  function cacheKey(realm: string, accountId: number) {
    return `${realm}_${accountId}`;
  }

  function indexKey(realm: string, nickname: string) {
    return `${realm.toLowerCase()}_${nickname.toLowerCase()}`;
  }

  function cacheFile(realm: string, accountId: number) {
    return `stats-cache/${cacheKey(realm, accountId)}.json`;
  }

  async function readIndex(): Promise<void> {
    try {
      const raw = await api.appdataRead(INDEX_FILE);
      if (raw) {
        const j = JSON.parse(raw) as Record<string, number>;
        index.value = new Map(Object.entries(j));
      }
    } catch {
      // index missing/corrupt — rebuild lazily from lookups
    }
  }

  function persistIndex() {
    void api
      .appdataWrite(INDEX_FILE, JSON.stringify(Object.fromEntries(index.value)))
      .catch(() => {});
  }

  /** Read + parse a cache file, handling both the envelope and legacy shapes.
   *  Populates the in-memory maps on success. */
  async function readCacheFile(
    realm: string,
    accountId: number,
  ): Promise<PlayerStats | null> {
    try {
      const raw = await api.appdataRead(cacheFile(realm, accountId));
      if (!raw) return null;
      const j = JSON.parse(raw) as CachedStats | PlayerStats;
      const enveloped = (j as CachedStats).stats != null;
      const stats = enveloped ? (j as CachedStats).stats : (j as PlayerStats);
      const ts = enveloped && typeof (j as CachedStats).fetchedAt === "number"
        ? (j as CachedStats).fetchedAt
        : 0;
      const key = cacheKey(realm, accountId);
      cache.value.set(key, stats);
      fetchedAt.value.set(key, ts);
      return stats;
    } catch {
      return null;
    }
  }

  /** Look up a player's stats.
   *
   *  `force: true` always hits the WG API (explicit user queries, own
   *  account refreshes). Otherwise a cached result within `ttlMs` is
   *  returned; the default (Infinity) means "cache forever until an
   *  explicit query" — passive consumers like the replay camera menu never
   *  trigger network calls. On a fresh API result the disk cache, the
   *  nickname→accountId index and the trend snapshot are all updated. */
  async function lookup(
    nickname: string,
    realm: string,
    opts: { force?: boolean; ttlMs?: number } = {},
  ): Promise<PlayerStats> {
    const { force = false, ttlMs = Number.POSITIVE_INFINITY } = opts;
    loading.value = true;
    error.value = null;
    try {
      if (index.value.size === 0) await readIndex();
      const nickKey = indexKey(realm, nickname);
      const accountId = index.value.get(nickKey);
      if (accountId != null && !force) {
        const key = cacheKey(realm, accountId);
        const cached = cache.value.get(key) ?? (await readCacheFile(realm, accountId));
        if (cached) {
          const ts = fetchedAt.value.get(key) ?? 0;
          if (Date.now() - ts < ttlMs) return cached;
        }
      }

      const stats = await api.lookupPlayerStats(nickname, realm);
      const key = cacheKey(realm, stats.accountId);
      cache.value.set(key, stats);
      fetchedAt.value.set(key, Date.now());
      index.value.set(nickKey, stats.accountId);
      persistIndex();
      // Persist current snapshot to AppData (best-effort, don't block UI).
      const envelope: CachedStats = { fetchedAt: Date.now(), stats };
      void api.appdataWrite(cacheFile(realm, stats.accountId), JSON.stringify(envelope)).catch(() => {});
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

  /** Load a cached stats file from AppData (if present). Never hits the API. */
  async function loadCached(realm: string, accountId: number): Promise<PlayerStats | null> {
    const key = cacheKey(realm, accountId);
    if (cache.value.has(key)) return cache.value.get(key)!;
    return readCacheFile(realm, accountId);
  }

  return { cache, fetchedAt, index, loading, error, lookup, loadCached };
});
