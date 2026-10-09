import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type GameProcessInfo } from "@/api";
import { useConfigStore } from "@/stores/config";

const OFFLINE: GameProcessInfo = {
  running: false,
  pid: null,
  kind: null,
  realm: null,
  exePath: null,
  matchedInstall: null,
};

/** Polls the game process state every 3 seconds — the PLURAL, multi-instance
 *  view: `processes` carries every running game client (one entry per OS
 *  process, so several clients — same realm different accounts, different
 *  realms, twin installs — are all visible), `preferredPid` the instance the
 *  backend's single-process surfaces follow, and `watchedPid` the one the
 *  USER picked to watch (the sidebar's instance cards; falls back to the
 *  preferred instance while unset). `process` derives the watched entry so
 *  the existing single-process consumers (live view, overlay lifecycle,
 *  plugin-update guards, ...) transparently follow the user's choice.
 *
 * The sidebar footer renders one card per process with the PID + which
 * client (Steam / Wargaming / ...) it is. When a new replay file appears
 * (arena watcher), WoWSP starts querying stats for everyone in the battle.
 *
 * The backend resolves which install each running exe belongs to by matching
 * its path against the detected installs, so we pass the full installs list
 * (from the config store) on every poll. */
export const useGameStatusStore = defineStore("gameStatus", () => {
  const processes = ref<GameProcessInfo[]>([]);
  const preferredPid = ref<number | null>(null);
  /** The user's watched instance (the sidebar card click). Null = follow the
   *  preferred instance. A watched pid that disappears (client exited) falls
   *  back to the preferred one on the next poll. */
  const watchedPid = ref<number | null>(null);

  /** The one process this app surfaces follow: the watched instance, else
   *  the preferred one, else any (degenerate report without a preference),
   *  else the offline projection. The setter is the singular-report compat
   *  path (tests, legacy callers): "THIS is the process" collapses the
   *  plural state to one entry + its preference. */
  const process = computed<GameProcessInfo>({
    get: () => {
      if (watchedPid.value != null) {
        const watched = processes.value.find((p) => p.pid === watchedPid.value);
        if (watched) return watched;
      }
      if (preferredPid.value != null) {
        const preferred = processes.value.find((p) => p.pid === preferredPid.value);
        if (preferred) return preferred;
      }
      return processes.value[0] ?? { ...OFFLINE };
    },
    set: (info) => {
      const pid = info.running ? info.pid ?? null : null;
      processes.value = pid != null ? [info] : [];
      preferredPid.value = pid;
      watchedPid.value = null;
    },
  });

  /** True while ANY game client runs (the plural view of `process.running`). */
  const anyRunning = computed(() => processes.value.length > 0);

  let pollHandle: number | null = null;

  async function check() {
    try {
      const config = useConfigStore();
      const report = await api.getGameProcesses(config.installs);
      processes.value = report.processes;
      preferredPid.value = report.preferredPid;
      // A watched instance that exited must not pin the view to a dead pid —
      // drop the selection so the preferred instance takes over.
      if (
        watchedPid.value != null &&
        !report.processes.some((p) => p.pid === watchedPid.value)
      ) {
        watchedPid.value = null;
      }
    } catch {
      processes.value = [];
      preferredPid.value = null;
      watchedPid.value = null;
    }
  }

  /** Watch a specific instance (the sidebar's instance-card click). Null
   *  (or the preferred pid) restores the default follow. */
  function selectProcess(pid: number | null) {
    watchedPid.value = pid;
  }

  /** Start polling (called on app mount). */
  function start() {
    void check();
    if (pollHandle === null) {
      pollHandle = window.setInterval(() => void check(), 3000);
    }
  }

  /** Stop polling. */
  function stop() {
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  return {
    processes,
    preferredPid,
    watchedPid,
    process,
    anyRunning,
    selectProcess,
    start,
    stop,
    check,
  };
});
