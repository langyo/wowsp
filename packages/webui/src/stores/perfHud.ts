import { ref } from "vue";
import { defineStore } from "pinia";

/**
 * Session-only switch for the holographic replay map's performance HUD
 * (features/holographic/perfHud.ts). The default follows the build
 * flavor — dev builds show the overlay, packaged release builds don't —
 * and the settings' feedback pane flips it either way. Session-scoped on
 * purpose: nothing touches localStorage (the old stored `wowsp.perf`
 * flag could be set by support tooling but never cleared from a packaged
 * build, which is exactly how the overlay ended up permanently stuck on
 * release builds), so every app start lands back on the build default.
 */
export const usePerfHudStore = defineStore("perfHud", () => {
  const enabled = ref(import.meta.env.DEV);

  function setEnabled(v: boolean): void {
    enabled.value = v;
  }

  return { enabled, setEnabled };
});
