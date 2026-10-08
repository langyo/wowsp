import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type PlaytimeBattles, type PlaytimeOverview } from "@/api";
import { battlesActivityKey } from "@/components/playtime/battleBreakdown";

/**
 * Playtime ledger store — feeds the 游玩时间 view (commands/playtime.rs).
 * The Rust tracker observes the game client via the session poller, so the
 * frontend only reads: one overview + battles fetch on start, then a slow
 * 30 s overview poll while the page keeps it alive (a running session's
 * duration ticks with that cadence). The battles payload is NOT refetched
 * every idle cycle — fresh replay files can land while a client runs or
 * right after it exits, so the poll re-pulls battles during a run and when
 * the overview's activity key moves; an idle view never pays the
 * potentially multi-MB scan round trip again. Polling lives behind
 * start/stop like gameStatus so the ledger stops being read the moment the
 * view unmounts.
 */
export const usePlaytimeStore = defineStore("playtime", () => {
  const overview = ref<PlaytimeOverview | null>(null);
  /** Replay-derived battle rows (the battles card + breakdown); null until
   *  the first fetch lands. */
  const battles = ref<PlaytimeBattles | null>(null);
  const loaded = ref(false);
  let pollHandle: number | null = null;
  let overviewSeq = 0;
  let battlesSeq = 0;
  let lifecycleSeq = 0;
  let pendingPollBattles: Promise<boolean> | null = null;
  /** Activity key covered by a successful battles scan. A failed scan
   *  leaves it unchanged so the next overview poll retries. */
  let battlesKey: string | null = null;

  async function fetchOverview(initialBattles?: Promise<boolean>) {
    const seq = ++overviewSeq;
    const lifecycle = lifecycleSeq;
    try {
      const next = await api.getPlaytimeOverview();
      if (seq !== overviewSeq) return;
      overview.value = next;
      loaded.value = true;
      const key = battlesActivityKey(next);
      if (initialBattles || next.lastLaunch?.running || key !== battlesKey) {
        // A large replay directory can take longer than the poll interval.
        // Keep its scan alive rather than queuing and superseding it forever.
        if (!initialBattles && pendingPollBattles) return;
        const ok = await (initialBattles ?? scanForPoll());
        // Same-activity overview polls do not invalidate a successful scan.
        // A changed activity or remount still needs its own scan.
        if (ok && lifecycle === lifecycleSeq && key === battlesActivityKey(overview.value)) {
          battlesKey = key;
        }
      }
    } catch {
      // Browser-dev mock doesn't serve the ledger — the view keeps its
      // empty state.
    }
  }

  async function fetch() {
    await fetchOverview();
  }

  async function fetchBattles(): Promise<boolean> {
    const seq = ++battlesSeq;
    try {
      const next = await api.playtimeBattles();
      if (seq !== battlesSeq) return false;
      battles.value = next;
      return true;
    } catch {
      // Same empty-state contract as fetch(): a backend without the scan
      // keeps whatever the previous cycle loaded (null initially).
      return false;
    }
  }

  const refreshing = ref(false);

  /** Manual "refresh now" (the toolbar's refresh button): re-pull the
   *  overview AND the battles unconditionally. The poll's activity-key
   *  gate never re-pulls battles while the game is idle, so replay folders
   *  that changed on disk outside a session (a freshly pinned source,
   *  files copied in by hand) otherwise wait for the next launch. */
  async function refreshAll() {
    refreshing.value = true;
    try {
      await fetch();
      if (await fetchBattles()) {
        battlesKey = battlesActivityKey(overview.value);
      }
    } finally {
      refreshing.value = false;
    }
  }

  /** Rebuild the ledger from disk (the 录像来源 manager's 重建 action):
   *  the backend drops its parse + history cache and answers rows built
   *  from the replays currently present. Bumping the battles sequence
   *  first discards any in-flight poll scan — its pre-reset rows must not
   *  overwrite the rebuilt ledger when they land. */
  async function resetBattles() {
    ++battlesSeq;
    battles.value = await api.playtimeBattlesReset();
    battlesKey = battlesActivityKey(overview.value);
  }

  /** One poll-driven scan at a time: a large replay tree can outlast the
   *  30 s poll interval, and queueing a fresh scan every cycle would
   *  supersede the running one forever. Callers share the live promise. */
  function scanForPoll(): Promise<boolean> {
    if (pendingPollBattles) return pendingPollBattles;
    const pending = fetchBattles().finally(() => {
      if (pendingPollBattles === pending) pendingPollBattles = null;
    });
    pendingPollBattles = pending;
    return pending;
  }

  /** Start fetching + polling (called on view mount). */
  function start() {
    // Keep the initial scan independent of overview availability, but let
    // its successful completion acknowledge the initial activity key.
    const initialBattles = scanForPoll();
    void fetchOverview(initialBattles);
    if (pollHandle === null) {
      pollHandle = window.setInterval(() => {
        void fetch();
      }, 30_000);
    }
  }

  /** Stop polling (called on view unmount). */
  function stop() {
    ++overviewSeq;
    ++battlesSeq;
    ++lifecycleSeq;
    pendingPollBattles = null;
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  return {
    overview,
    battles,
    loaded,
    refreshing,
    fetch,
    fetchBattles,
    refreshAll,
    resetBattles,
    start,
    stop,
  };
});
