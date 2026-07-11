import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type ArenaInfo, type CaptureResult } from "@/api";
import { transport } from "@/transport";

/** Tauri event the Rust arena watcher emits on a fresh tempArenaInfo.json. */
const ARENA_INFO_EVENT = "wowsp://arena-info";

/**
 * Live overlay state (Mode 2). The arena-info roster updates whenever the game
 * writes a fresh `tempArenaInfo.json` (pushed via the Rust notify watcher);
 * the `visible` flag tracks whether the user is currently holding Tab.
 */
export const useOverlayStore = defineStore("overlay", () => {
  const arenaInfo = ref<ArenaInfo | null>(null);
  const visible = ref(false);
  const lastCapture = ref<CaptureResult | null>(null);
  const watching = ref(false);
  let unlisten: (() => void) | null = null;

  const allies = computed(() => arenaInfo.value?.vehicles.filter((v) => v.relation <= 1) ?? []);
  const enemies = computed(() => arenaInfo.value?.vehicles.filter((v) => v.relation > 1) ?? []);

  async function refreshArenaInfo(dir?: string) {
    arenaInfo.value = await api.readTempArenaInfo(dir);
  }

  /** Start the Rust file watcher and subscribe to its push events. Idempotent. */
  async function startWatching(dir?: string) {
    if (watching.value) return;
    await api.startArenaWatcher(dir);
    if (transport.listen) {
      unlisten = await transport.listen<ArenaInfo>(ARENA_INFO_EVENT, (info) => {
        arenaInfo.value = info;
      });
    }
    watching.value = true;
  }

  async function stopWatching() {
    if (!watching.value) return;
    await api.stopArenaWatcher();
    unlisten?.();
    unlisten = null;
    watching.value = false;
  }

  async function setVisible(v: boolean) {
    visible.value = v;
    await api.setOverlayVisible(v);
    if (v) {
      lastCapture.value = await api.captureGameWindow();
    }
  }

  return {
    arenaInfo,
    visible,
    lastCapture,
    watching,
    allies,
    enemies,
    refreshArenaInfo,
    startWatching,
    stopWatching,
    setVisible,
  };
});
