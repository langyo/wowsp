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
 *  realms, twin installs — are all counted), `preferredPid` the instance the
 *  backend's single-process surfaces follow. `process` derives that
 *  preferred entry, keeping the singular shape every consumer has always
 *  read; the sidebar renders it as the one status card and hangs the
 *  running count under its status dot when OTHER clients are up too.
 *
 * When a new replay file appears (arena watcher), WoWSP starts querying
 * stats for everyone in the battle.
 *
 * The backend resolves which install each running exe belongs to by matching
 * its path against the detected installs, so we pass the full installs list
 * (from the config store) on every poll. */
export const useGameStatusStore = defineStore("gameStatus", () => {
  const processes = ref<GameProcessInfo[]>([]);
  const preferredPid = ref<number | null>(null);

  /** The one process the app surfaces follow: the preferred instance, else
   *  any (degenerate report without a preference), else the offline
   *  projection. The setter is the singular-report compat path (tests,
   *  legacy callers): "THIS is the process" collapses the plural state to
   *  one entry + its preference. */
  const process = computed<GameProcessInfo>({
    get: () => {
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
    },
  });

  let pollHandle: number | null = null;

  async function check() {
    try {
      const config = useConfigStore();
      const report = await api.getGameProcesses(config.installs);
      processes.value = report.processes;
      preferredPid.value = report.preferredPid;
    } catch {
      processes.value = [];
      preferredPid.value = null;
    }
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

  return { processes, preferredPid, process, start, stop, check };
});
