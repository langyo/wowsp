/**
 * Arena overlay store (Mode 2). Holds the live roster pushed by the Rust
 * arena-info watcher (`start_arena_watcher` → `wowsp://arena-info` events),
 * plus the overlay window visibility flag.
 *
 * This is the store the dedicated overlay window (OverlayApp) consumes. It is
 * distinct from the popup registry (`stores/popupRegistry.ts`) which coordinates
 * modal/drawer z-index stacking in the main window.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type ArenaInfo, type VehicleEntry } from "@/api";

export const useOverlayStore = defineStore("arenaOverlay", () => {
  const arenaInfo = ref<ArenaInfo | null>(null);
  const visible = ref(false);
  const watching = ref(false);
  const error = ref<string | null>(null);

  let arenaUnlisten: (() => void) | null = null;

  const allies = computed<VehicleEntry[]>(
    () => arenaInfo.value?.vehicles.filter((v) => v.relation <= 1) ?? [],
  );
  const enemies = computed<VehicleEntry[]>(
    () => arenaInfo.value?.vehicles.filter((v) => v.relation > 1) ?? [],
  );

  async function setVisible(v: boolean) {
    visible.value = v;
    try {
      await api.setOverlayVisible(v);
    } catch {
      // non-fatal — the window may not exist yet
    }
  }

  /** One-shot read of tempArenaInfo.json (if the game is in a battle). */
  async function refreshArenaInfo(dir?: string) {
    try {
      const info = await api.readTempArenaInfo(dir);
      if (info) arenaInfo.value = info;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  /** Start the file watcher; incoming arena-info events update `arenaInfo`. */
  async function startWatching(dir?: string) {
    if (watching.value) return;
    try {
      await api.startArenaWatcher(dir);
      arenaUnlisten = (await api.listenArenaInfo((info) => {
        arenaInfo.value = info;
      })) as (() => void) | null;
      watching.value = true;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function stopWatching() {
    if (!watching.value) return;
    arenaUnlisten?.();
    arenaUnlisten = null;
    try {
      await api.stopArenaWatcher();
    } catch {
      // best-effort
    }
    watching.value = false;
  }

  return {
    arenaInfo,
    visible,
    allies,
    enemies,
    watching,
    error,
    setVisible,
    refreshArenaInfo,
    startWatching,
    stopWatching,
  };
});
