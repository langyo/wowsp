import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type RankedSeasonStats } from "@/api";
import { aggregateRankedWinrate } from "@/utils/ranked";
import { useStatsQueryStore, type StatsQueryMessage } from "@/stores/statsQuery";

/** Ranked battle stats store. Wraps `get_ranked_stats` with an in-memory
 *  cache. Actual fetches run as "ranked-stats" messages on the shared FIFO
 *  pipeline (stores/statsQuery.ts), serially with every other water-table
 *  query; the slot-identity/TTL fast path reads without queueing. */
export const useRankedStore = defineStore("ranked", () => {
  const query = useStatsQueryStore();
  const seasons = ref<RankedSeasonStats[]>([]);
  const loading = ref(false);
  /** How many queued fetches are in flight (the TTL fast path returns
   *  before this counts) — keeps `loading` true through queue wait and
   *  fetch alike. */
  let activeCalls = 0;
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
  /** Identity + fetch time of what the slot holds (plain closure state like
   *  `token` — only load() reads it) — load()'s `ttlMs` guard may only
   *  serve the cache for the SAME player and season window. */
  let loaded: {
    realm: string;
    accountId: number;
    seasonCount?: number;
    fetchedAt: number;
  } | null = null;

  /** Load a player's ranked seasons. `seasonCount` omitted = EVERY season
   *  the backend lists (unplayed ones drop server-side), so the season-
   *  timeline modal and the aggregated winrate cover the full ranked
   *  history, not a recent window. `ttlMs` serves the slot unchanged when
   *  the same request was fulfilled within the window — the dashboard
   *  passes one so revisits don't re-query the WG API. Actual fetches run
   *  as "ranked-stats" messages on the shared FIFO pipeline. */
  async function load(
    id: number,
    realm: string,
    seasonCount?: number,
    opts: { ttlMs?: number } = {},
  ) {
    const ttlMs = opts.ttlMs ?? 0;
    // Fast path (read-only, never queues).
    const cur = loaded;
    if (
      ttlMs > 0 &&
      cur != null &&
      cur.accountId === id &&
      cur.realm === realm &&
      cur.seasonCount === seasonCount &&
      Date.now() - cur.fetchedAt < ttlMs
    ) {
      return;
    }
    const current = ++token;
    const message: Extract<StatsQueryMessage, { kind: "ranked-stats" }> = {
      kind: "ranked-stats",
      accountId: id,
      realm,
      seasonCount,
      ttlMs,
    };
    activeCalls++;
    loading.value = true;
    error.value = null;
    try {
      // Executed only by the pipeline's worker (single writer), strictly
      // after every earlier queued query; the supersedence token still
      // gates which run may write the shared slot.
      const data = await query.enqueue(message, async () => {
        const rows = await api.getRankedStats(id, realm, seasonCount);
        if (current !== token) return rows;
        seasons.value = rows;
        accountId.value = id;
        loaded = { realm, accountId: id, seasonCount, fetchedAt: Date.now() };
        return rows;
      });
      return data;
    } catch (e) {
      if (current !== token) return;
      error.value = (e as Error).message;
      seasons.value = [];
      accountId.value = null;
      loaded = null;
    } finally {
      if (--activeCalls === 0) loading.value = false;
    }
  }

  /** Drop cached seasons (and the derived winrate) before a new lookup. */
  function reset() {
    token++;
    seasons.value = [];
    error.value = null;
    accountId.value = null;
    loaded = null;
  }

  return { seasons, loading, error, accountId, winrate, battles, load, reset };
});
