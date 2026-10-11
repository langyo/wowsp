import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type PlayerShipStats, type ShipStatsHistoryPoint, type ShipStatsProgress } from "@/api";
import { prAlgoForRequest } from "@/stores/statsPrefs";
import { useStatsQueryStore, type StatsQueryMessage } from "@/stores/statsQuery";
import { useUpstreamHealthStore } from "@/stores/upstreamHealth";

/** Per-player per-ship stats store. Wraps `lookup_player_ship_stats` with an
 *  in-memory cache keyed by `${realm}_${accountId}`. The Rust layer also
 *  persists to `ship-stats/<realm>_<accountId>.json` for offline fallback.
 *
 *  Queries are multi-read / single-write: the TTL fast path reads the cache
 *  directly; every actual fetch is ONE "ship-stats" message on the shared
 *  FIFO pipeline (stores/statsQuery.ts), executed serially with every
 *  other water-table query in the app.
 *
 *  Degraded-transport streaming: the backend emits
 *  `wowsp://ship-stats-progress` while a fetch's documents crawl in —
 *  "slow" sources (15s elapsed, bytes still flowing) land in `slowStreams`
 *  (the title bar's yellow degraded-loading chip reads it), and "partial"
 *  rows fill this store's cache mid-flight so the lookup table renders
 *  progressively. The pending-load gate keeps roster-only fetches (which
 *  never run through `load()`) from touching the table cache. */
export const useShipStatsStore = defineStore("shipStats", () => {
  const query = useStatsQueryStore();
  const cache = ref<Map<string, PlayerShipStats[]>>(new Map());
  /** Per-ship history points per player — the baselines that let the UI
   *  compute real "recent N days" deltas from career totals. */
  const history = ref<Map<string, ShipStatsHistoryPoint[]>>(new Map());
  /** accountId-keyed fetch timestamps (`realm_accountId` → epoch ms) — the
   *  feed for load()'s `ttlMs` guard. */
  const fetchedAt = ref<Map<string, number>>(new Map());
  const loading = ref(false);
  /** How many queued fetches are in flight (the TTL fast path returns
   *  before this counts) — keeps `loading` true through queue wait and
   *  fetch alike. */
  let activeCalls = 0;
  const error = ref<string | null>(null);

  /** Fetch sources streaming past the slow threshold, keyed
   *  `${source}@${realm}_${accountId}` — value is when the phase rang.
   *  Drives the title bar's degraded-loading chip; every source emits a
   *  terminal phase (done/aborted) that removes its entry, so the chip
   *  can never stick. */
  const slowStreams = ref<Map<string, { since: number }>>(new Map());
  const anySlowStream = computed(() => slowStreams.value.size > 0);

  /** Keys (`realm_accountId`) with a load() currently pending — partial
   *  rows apply only to these. Not reactive: it gates writes, renders
   *  nothing. */
  const pendingLoads = new Set<string>();

  /** The Rust→JS event hook. Exported on the store for tests; production
   *  wiring is the `listenShipStatsProgress` subscription below. */
  function applyProgress(p: ShipStatsProgress) {
    const sourceKey = `${p.source}@${p.realm}_${p.accountId}`;
    if (p.phase === "slow") {
      if (!slowStreams.value.has(sourceKey)) {
        slowStreams.value.set(sourceKey, { since: Date.now() });
      }
      return;
    }
    if (p.phase === "done" || p.phase === "aborted") {
      slowStreams.value.delete(sourceKey);
      return;
    }
    // "partial": fill the table only while THIS store is awaiting the
    // player — a roster-only fetch's partials are none of its business,
    // and a late event after the final answer must not clobber it.
    const k = `${p.realm}_${p.accountId}`;
    if (!pendingLoads.has(k)) return;
    // A complete answer already exists for this player (fetchedAt marks
    // final answers): a partial never downgrades it — the stale-but-whole
    // table stays until the fresh one lands whole.
    if (fetchedAt.value.has(k)) return;
    const rows = (p.rows ?? []).filter((s) => s.battles > 0);
    if (rows.length === 0) return;
    // Monotonic fill: a later partial must not shrink the visible table
    // (the racer's full list followed by the primary's first batch, or
    // page boundaries mid-pagination).
    const existing = cache.value.get(k);
    if (existing && rows.length < existing.length) return;
    cache.value.set(k, rows);
  }

  /** Attach the progress listener once per window. */
  let listening = false;
  function ensureProgressListener() {
    if (listening) return;
    listening = true;
    void api.listenShipStatsProgress?.((p) => applyProgress(p));
  }
  ensureProgressListener();

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
   *  don't re-query the WG API. Actual fetches run as "ship-stats"
   *  messages on the shared FIFO pipeline, serially with every other
   *  water-table query. */
  async function load(
    accountId: number,
    realm: string,
    opts: { ttlMs?: number } = {},
  ): Promise<PlayerShipStats[]> {
    const k = key(realm, accountId);
    const { ttlMs = 0 } = opts;
    // Fast path (read-only, never queues).
    const cached = cache.value.get(k);
    if (cached && ttlMs > 0 && Date.now() - (fetchedAt.value.get(k) ?? 0) < ttlMs) {
      return cached;
    }
    const message: Extract<StatsQueryMessage, { kind: "ship-stats" }> = {
      kind: "ship-stats",
      accountId,
      realm,
      ttlMs,
    };
    // Captured at enqueue time — a PR-pref flip while the message waits in
    // the FIFO must not change the fetch's caliber.
    const algo = prAlgoForRequest();
    pendingLoads.add(k);
    activeCalls++;
    loading.value = true;
    error.value = null;
    try {
      // Executed only by the pipeline's worker (single writer), strictly
      // after every earlier queued query. Zero-pvp rows (kept by the
      // backend for the roster's ranked/co-op buckets — see the ship-scoped
      // pipeline in composables/useRosterStats) are not randoms-table rows:
      // this store feeds the per-ship table and its distributions, which
      // read the pvp career, so they filter out here exactly as they did
      // before the backend started retaining them.
      const stats = await query.enqueue(message, async () => {
        const fresh = (await api.lookupPlayerShipStats(accountId, realm, algo)).filter(
          (s) => s.battles > 0,
        );
        cache.value.set(k, fresh);
        fetchedAt.value.set(k, Date.now());
        return fresh;
      });
      return stats;
    } catch (e) {
      error.value = (e as Error).message;
      // Return stale cache if available. Mid-flight partial rows may have
      // replaced the cache for this key — they are fresher than nothing
      // when no older cache survived, and this load's failure keeps them
      // standing (the degraded "partial data" face).
      const stale = cache.value.get(k);
      if (stale) return stale;
      throw e;
    } finally {
      pendingLoads.delete(k);
      if (--activeCalls === 0) loading.value = false;
      // The Rust side appended a history point on the successful fetch (or
      // the fetch failed and history is unchanged either way) — refresh the
      // history cache so delta views see the latest baselines.
      void loadHistory(accountId, realm);
      // Settled fetches feed the upstream-fault chip (see stats.lookup).
      useUpstreamHealthStore().scheduleRefresh();
    }
  }

  /** Get a single ship's stats for a player (or null if unplayed). */
  function getShip(accountId: number, realm: string, shipId: number): PlayerShipStats | null {
    const stats = cache.value.get(key(realm, accountId));
    return stats?.find((s) => s.shipId === shipId) ?? null;
  }

  return {
    cache,
    history,
    loading,
    error,
    slowStreams,
    anySlowStream,
    load,
    loadHistory,
    getShip,
    applyProgress,
  };
});
