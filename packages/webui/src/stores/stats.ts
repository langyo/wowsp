import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type PlayerStats } from "@/api";
import { LookupError, type LookupErrorPayload } from "@/transport/types";
import { prAlgoForRequest } from "@/stores/statsPrefs";
import { useStatsQueryStore, type StatsQueryMessage } from "@/stores/statsQuery";

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
 *  The cache is SHARED across the whole app: the dashboard/lookup pages,
 *  the replay drill-downs and the replay hologram's follow menu all go
 *  through this store, so a player queried from either place is cached
 *  once and reused everywhere.
 *
 *  Querying is multi-read / single-write: `lookup` answers from the
 *  memory/disk cache whenever it can (read) and otherwise enqueues ONE
 *  "player-stats" message on the shared FIFO pipeline
 *  (stores/statsQuery.ts) — only that pipeline's worker executes the WG
 *  query and writes the cache (write), strictly one query at a time, in
 *  submission order, shared with every other water-table surface.
 *
 *  Refresh policy:
 *  - Your OWN account (activeAccount): the dashboard opens with a short
 *    TTL — revisits inside the window reuse the cache; the refresh pill
 *    (and best-effort account binding) pass `force: true` and re-pull
 *    from the API.
 *  - Everyone else: passive lookups (replay menu / drill-downs) reuse the
 *    disk cache as long as it exists; only an explicit user query
 *    (`force: true`) hits the API again.
 *  - Concurrent lookups of the same player share ONE queued message
 *    (in-flight dedupe at the enqueue boundary) and its cache writes
 *    instead of racing duplicate requests.
 *
 *  Every consumer reads the same reactive cache — the dashboard header,
 *  the sidebar account card and the account manager all render ONE
 *  snapshot per player, so a refresh anywhere updates them everywhere.
 */
export const useStatsStore = defineStore("stats", () => {
  const query = useStatsQueryStore();
  const cache = ref<Map<string, PlayerStats>>(new Map());
  /** accountId-keyed fetch timestamps (`realm_accountId` → epoch ms). */
  const fetchedAt = ref<Map<string, number>>(new Map());
  /** nickname → accountId index (`realm_nickname-lower` → accountId),
   *  persisted so a replayed match can hit the cache without an API call. */
  const index = ref<Map<string, number>>(new Map());
  const loading = ref(false);
  /** How many lookup calls (fast-path or queued) are in flight — `loading`
   *  stays true while ANY of them runs, including time spent waiting in
   *  the shared FIFO. */
  let activeCalls = 0;
  const error = ref<string | null>(null);
  /** Structured payload of the last rejected interactive lookup (null once
   *  a new attempt starts) — the lookup page's friendly error notice. The
   *  plain `error` string is kept in parallel for the pre-existing
   *  consumers (dashboard / replay), which stay untouched. */
  const lookupError = ref<LookupErrorPayload | null>(null);
  /** In-flight lookup dedupe (`realm_nickname_algo` → shared promise):
   *  concurrent lookups of the same player await the same API call, so a
   *  dashboard refresh racing another consumer can't double-hit the WG
   *  API or interleave two cache writes for one player. */
  const inflight = new Map<string, Promise<PlayerStats>>();
  /** Keep best-effort disk snapshots in API completion order, without
   *  making a slow or failed save block lookup results. */
  let pendingSave = Promise.resolve();

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
        // A lookup may have learned newer mappings while disk I/O waited.
        index.value = new Map([...Object.entries(j), ...index.value]);
      }
    } catch {
      // index missing/corrupt — rebuild lazily from lookups
    }
  }

  function persistFile(file: string, contents: string): void {
    pendingSave = pendingSave
      .then(async () => { await api.appdataWrite(file, contents); })
      .catch(() => {});
  }

  function persistIndex() {
    persistFile(INDEX_FILE, JSON.stringify(Object.fromEntries(index.value)));
  }

  /** Read + parse a cache file, handling both the envelope and legacy shapes.
   *  Populates the in-memory maps on success. */
  async function readCacheFile(
    realm: string,
    accountId: number,
  ): Promise<PlayerStats | null> {
    const key = cacheKey(realm, accountId);
    try {
      const raw = await api.appdataRead(cacheFile(realm, accountId));
      // Hydration only fills missing entries. An API refresh (or another
      // reader) may already have populated this player while we waited.
      const current = cache.value.get(key);
      if (current) return current;
      if (!raw) return null;
      const j = JSON.parse(raw) as CachedStats | PlayerStats;
      const enveloped = (j as CachedStats).stats != null;
      const stats = enveloped ? (j as CachedStats).stats : (j as PlayerStats);
      const ts = enveloped && typeof (j as CachedStats).fetchedAt === "number"
        ? (j as CachedStats).fetchedAt
        : 0;
      cache.value.set(key, stats);
      fetchedAt.value.set(key, ts);
      return stats;
    } catch {
      return cache.value.get(key) ?? null;
    }
  }

  /** The single API pull + cache write for one player — executed ONLY by
   *  the shared pipeline's worker (single writer). `algo` is captured at
   *  enqueue time so a PR-pref flip while the message waits in the FIFO
   *  can't change what the dedupe key promised. A fresh result that comes
   *  back without a dog tag keeps the previous snapshot's emblem: the Rust
   *  command swallows a Vortex dog-tag fetch failure into `null`, so
   *  without this carry-over a routine refresh could wipe a perfectly good
   *  avatar from every surface rendering the cache (dashboard header,
   *  sidebar, cards). */
  async function fetchAndCache(
    nickname: string,
    realm: string,
    algo: ReturnType<typeof prAlgoForRequest>,
  ): Promise<PlayerStats> {
    const stats = await api.lookupPlayerStats(nickname, realm, algo);
    const key = cacheKey(realm, stats.accountId);
    // Cold session: the previous snapshot may live only on disk (a
    // force lookup skips the cached-read path) — warm it so the
    // carry-over below can see it.
    if (stats.dogTag == null && !cache.value.has(key)) {
      await readCacheFile(realm, stats.accountId);
    }
    const prevDogTag = cache.value.get(key)?.dogTag ?? null;
    let merged = stats;
    if (stats.dogTag == null && prevDogTag != null) {
      merged = { ...stats, dogTag: prevDogTag };
    }
    cache.value.set(key, merged);
    fetchedAt.value.set(key, Date.now());
    index.value.set(indexKey(realm, nickname), stats.accountId);
    persistIndex();
    // Persist current snapshot to AppData (best-effort, don't block UI).
    const envelope: CachedStats = { fetchedAt: Date.now(), stats: merged };
    persistFile(cacheFile(realm, stats.accountId), JSON.stringify(envelope));
    // Append a versioned snapshot for trend tracking (best-effort).
    void api.snapshotPlayerStats(
      stats.accountId,
      realm,
      merged.battles ?? null,
      // wins isn't in PlayerStats directly — derive from winrate * battles.
      merged.battles != null && merged.winrate != null
        ? Math.round((merged.winrate / 100) * merged.battles)
        : null,
      merged.winrate ?? null,
      merged.avgDamage ?? null,
      merged.pr ?? null,
    ).catch(() => {});
    return merged;
  }

  /** Serve a cached snapshot within `ttlMs` for this player, or null —
   *  lookup()'s read-only fast path (never queued, never fetches). */
  async function cachedWithinTtl(
    nickname: string,
    realm: string,
    ttlMs: number,
  ): Promise<PlayerStats | null> {
    const nickKey = indexKey(realm, nickname);
    const accountId = index.value.get(nickKey);
    if (accountId == null) return null;
    const key = cacheKey(realm, accountId);
    const cached = cache.value.get(key) ?? (await readCacheFile(realm, accountId));
    if (!cached) return null;
    const ts = fetchedAt.value.get(key) ?? 0;
    return Date.now() - ts < ttlMs ? cached : null;
  }

  /** Look up a player's stats.
   *
   *  `force: true` always hits the WG API (explicit user queries, own
   *  account refreshes). Otherwise a cached result within `ttlMs` is
   *  returned; the default (Infinity) means "cache forever until an
   *  explicit query" — passive consumers like the replay camera menu never
   *  trigger network calls. On a fresh API result the disk cache, the
   *  nickname→accountId index and the trend snapshot are all updated.
   *
   *  Cache misses become ONE message on the shared FIFO pipeline: the WG
   *  query runs strictly after every earlier water-table query from any
   *  surface, never in parallel with one. */
  async function lookup(
    nickname: string,
    realm: string,
    opts: { force?: boolean; ttlMs?: number } = {},
  ): Promise<PlayerStats> {
    const { force = false, ttlMs = Number.POSITIVE_INFINITY } = opts;
    activeCalls++;
    loading.value = true;
    error.value = null;
    lookupError.value = null;
    try {
      if (index.value.size === 0) await readIndex();
      // Fast path (read-only, never queues): answer from cache.
      if (!force) {
        const cached = await cachedWithinTtl(nickname, realm, ttlMs);
        if (cached) return cached;
      }
      // Miss → enqueue on the shared pipeline (single writer). Identical
      // in-flight lookups share ONE queued message and its cache writes.
      // The worker then ALWAYS fetches — a queued message was enqueued
      // precisely because the freshest admissible snapshot was missing,
      // and same-player refreshes are deduped into this very message, so
      // re-checking the cache at execution time could only serve data
      // fetched with a different PR algorithm.
      const algo = prAlgoForRequest();
      const dedupeKey = `${indexKey(realm, nickname)}_${algo}`;
      const existing = inflight.get(dedupeKey);
      if (existing) return await existing;
      const message: Extract<StatsQueryMessage, { kind: "player-stats" }> = {
        kind: "player-stats",
        nickname,
        realm,
        force,
        ttlMs,
      };
      const task = query
        .enqueue(message, () => fetchAndCache(nickname, realm, algo))
        .finally(() => {
          // Release the slot on success AND failure so a rejected attempt
          // can be retried immediately.
          inflight.delete(dedupeKey);
        });
      inflight.set(dedupeKey, task);
      // `await` (not a bare return) so this call's rejection flows through
      // the catch/finally below — error state populates and `loading`
      // stays true until the queued message actually settles.
      return await task;
    } catch (e) {
      if (e instanceof LookupError) lookupError.value = e.payload;
      error.value = (e as Error).message;
      throw e;
    } finally {
      if (--activeCalls === 0) loading.value = false;
    }
  }

  /** Load a cached stats file from AppData (if present). Never hits the API. */
  async function loadCached(realm: string, accountId: number): Promise<PlayerStats | null> {
    const key = cacheKey(realm, accountId);
    if (cache.value.has(key)) return cache.value.get(key)!;
    return readCacheFile(realm, accountId);
  }

  return { cache, fetchedAt, index, loading, error, lookupError, lookup, loadCached };
});
