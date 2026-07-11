import { defineStore } from "pinia";
import { ref } from "vue";

import { api } from "@/api";

/** Polls the game process state every 3 seconds. The sidebar shows a green dot
 *  when the game is running. When a new replay file appears (arena watcher),
 *  WoWSP starts querying stats for everyone in the battle. */
export const useGameStatusStore = defineStore("gameStatus", () => {
  const running = ref(false);
  let pollHandle: number | null = null;

  async function check() {
    try {
      running.value = await api.isGameRunning();
    } catch {
      running.value = false;
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

  return { running, start, stop, check };
});
