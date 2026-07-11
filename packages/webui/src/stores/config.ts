import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type GameInstall } from "@/api";

/**
 * Holds the detected game install + user settings (realm, replay dir).
 * The game-install detection runs once on app start; users can re-run it or
 * pin a manual path.
 */
export const useConfigStore = defineStore("config", () => {
  const installs = ref<GameInstall[]>([]);
  const activeInstall = ref<GameInstall | null>(null);
  const detecting = ref(false);

  async function detect() {
    detecting.value = true;
    try {
      installs.value = await api.detectGameInstall();
      if (!activeInstall.value && installs.value.length > 0) {
        activeInstall.value = installs.value[0];
      }
    } finally {
      detecting.value = false;
    }
  }

  async function setManualPath(path: string) {
    activeInstall.value = await api.setGamePath(path);
  }

  return { installs, activeInstall, detecting, detect, setManualPath };
});
