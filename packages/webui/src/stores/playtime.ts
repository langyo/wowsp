import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type PlaytimeOverview } from "@/api";

/**
 * Playtime ledger store — feeds the 游玩时间 view (commands/playtime.rs).
 * The Rust tracker observes the game client via the session poller, so the
 * frontend only reads: one overview fetch on start plus a slow 30 s poll
 * while the page keeps it alive (a running session's duration ticks with
 * that cadence). Polling lives behind start/stop like gameStatus so the
 * ledger stops being read the moment the view unmounts.
 */
export const usePlaytimeStore = defineStore("playtime", () => {
  const overview = ref<PlaytimeOverview | null>(null);
  const loaded = ref(false);
  let pollHandle: number | null = null;

  async function fetch() {
    try {
      overview.value = await api.getPlaytimeOverview();
      loaded.value = true;
    } catch {
      // Browser-dev mock doesn't serve the ledger — the view keeps its
      // empty state.
    }
  }

  /** Start fetching + polling (called on view mount). */
  function start() {
    void fetch();
    if (pollHandle === null) {
      pollHandle = window.setInterval(() => void fetch(), 30_000);
    }
  }

  /** Stop polling (called on view unmount). */
  function stop() {
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  return { overview, loaded, fetch, start, stop };
});
