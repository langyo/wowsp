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
 * every cycle — fresh replay files only land while a client runs or right
 * after it exits, so the poll re-pulls battles only when the overview's
 * activity key moves (battlesActivityKey); an idle view never pays the
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
  /** Activity key the current `battles` payload was fetched under. Null
   *  until the first overview lands — start() fetches battles once
   *  unconditionally, so the initial key is only recorded, never
   *  re-triggered. */
  let battlesKey: string | null = null;

  async function fetch() {
    try {
      overview.value = await api.getPlaytimeOverview();
      loaded.value = true;
      const key = battlesActivityKey(overview.value);
      if (battlesKey === null) {
        // start()'s unconditional battles fetch already covered this key —
        // record it without re-triggering.
        battlesKey = key;
      } else if (key !== battlesKey) {
        // A moved key (new launch, or the run state flipping either way)
        // means replay files may have appeared since the last battles
        // fetch — the only moments that payload can change on disk. The
        // key advances only on a successful pull, so a transient failure
        // retries on the next poll instead of going stale until the next
        // game session.
        void fetchBattles().then((ok) => {
          if (ok) battlesKey = key;
        });
      }
    } catch {
      // Browser-dev mock doesn't serve the ledger — the view keeps its
      // empty state.
    }
  }

  async function fetchBattles(): Promise<boolean> {
    try {
      battles.value = await api.playtimeBattles();
      return true;
    } catch {
      // Same empty-state contract as fetch(): a backend without the scan
      // keeps whatever the previous cycle loaded (null initially).
      return false;
    }
  }

  /** Start fetching + polling (called on view mount). */
  function start() {
    void fetch();
    // The unconditional battles fetch — the overview fetch above only
    // records the initial activity key; it re-pulls on movement from
    // there on.
    void fetchBattles();
    if (pollHandle === null) {
      pollHandle = window.setInterval(() => {
        void fetch();
      }, 30_000);
    }
  }

  /** Stop polling (called on view unmount). */
  function stop() {
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  return { overview, battles, loaded, fetch, fetchBattles, start, stop };
});
