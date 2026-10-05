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
  /** True while the Steam rescan command is in flight (the view's button
   *  busy state). */
  const importing = ref(false);
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

  /** Scan the Steam client's userdata and import a larger career total.
   *  Resolves to the imported seconds DELTA (0 when nothing better was
   *  found); the overview itself updates in place either way. Note the
   *  delta is display-only: the Rust snapshot recomputes against its own
   *  clock, so a live open session's growth can fold a few seconds in. */
  async function importSteam(): Promise<number> {
    const before = overview.value?.totalSeconds ?? 0;
    importing.value = true;
    try {
      overview.value = await api.playtimeImportSteam();
      return Math.max(0, (overview.value?.totalSeconds ?? 0) - before);
    } catch {
      // Unreachable in the desktop shell; browser-dev has no ledger. The
      // view maps this to the "nothing found" feedback.
      return 0;
    } finally {
      importing.value = false;
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

  return { overview, loaded, importing, fetch, importSteam, start, stop };
});
