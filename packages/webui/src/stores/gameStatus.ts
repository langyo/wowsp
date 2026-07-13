import { defineStore } from "pinia";
import { ref } from "vue";

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

/** Polls the game process state every 3 seconds. The sidebar footer shows the
 *  PID + which client (Steam / Wargaming / ...) is running. When a new replay
 *  file appears (arena watcher), WoWSP starts querying stats for everyone in
 *  the battle.
 *
 *  The backend resolves which install the running exe belongs to by matching
 *  its path against the detected installs, so we pass the full installs list
 *  (from the config store) on every poll. */
export const useGameStatusStore = defineStore("gameStatus", () => {
  const process = ref<GameProcessInfo>({ ...OFFLINE });
  let pollHandle: number | null = null;

  async function check() {
    try {
      const config = useConfigStore();
      process.value = await api.getGameProcess(config.installs);
    } catch {
      process.value = { ...OFFLINE };
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

  return { process, start, stop, check };
});
