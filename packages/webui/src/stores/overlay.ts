import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type ArenaInfo, type CaptureResult } from "@/api";

/**
 * Live overlay state (Mode 2). The arena-info roster updates whenever the game
 * writes a fresh `tempArenaInfo.json`; the `visible` flag tracks whether the
 * user is currently holding Tab.
 */
export const useOverlayStore = defineStore("overlay", () => {
  const arenaInfo = ref<ArenaInfo | null>(null);
  const visible = ref(false);
  const lastCapture = ref<CaptureResult | null>(null);

  const allies = computed(() => arenaInfo.value?.vehicles.filter((v) => v.relation <= 1) ?? []);
  const enemies = computed(() => arenaInfo.value?.vehicles.filter((v) => v.relation > 1) ?? []);

  async function refreshArenaInfo(dir?: string) {
    arenaInfo.value = await api.readTempArenaInfo(dir);
  }

  async function setVisible(v: boolean) {
    visible.value = v;
    await api.setOverlayVisible(v);
    if (v) {
      lastCapture.value = await api.captureGameWindow();
    }
  }

  return { arenaInfo, visible, lastCapture, allies, enemies, refreshArenaInfo, setVisible };
});
