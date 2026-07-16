import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type GameInstall } from "@/api";

const GAME_CONFIG_FILE = "game-config.json";

/**
 * Holds the detected game install + user settings (realm, replay dir).
 * The game-install detection runs once on app start; users can re-run it or
 * pin a manual path. The active install (which client the replay list + stats
 * read from) is persisted to AppData so switching clients survives a restart.
 */
export const useConfigStore = defineStore("config", () => {
  const installs = ref<GameInstall[]>([]);
  const activeInstall = ref<GameInstall | null>(null);
  const detecting = ref(false);

  // Path remembered from the previous session (restored by `load()`, consumed
  // by `detect()` so a previously-selected client survives a rescan).
  let rememberedPath: string | null = null;

  /** Load the persisted active-install path from AppData. Call once on app
   *  startup BEFORE `detect()`; `detect()` then re-resolves it against the
   *  fresh scan and keeps it if the install still exists. */
  async function load() {
    try {
      const raw = await api.appdataRead(GAME_CONFIG_FILE);
      if (raw) {
        const data = JSON.parse(raw) as { activePath?: string | null };
        rememberedPath = data.activePath ?? null;
      }
    } catch {
      // file doesn't exist yet — that's fine
    }
  }

  async function detect() {
    detecting.value = true;
    try {
      installs.value = await api.detectGameInstall();
      // Prefer the remembered client (from last session) if it's still among
      // the detected installs; otherwise keep the current selection if valid;
      // otherwise fall back to the first detected install.
      const pickByPath = (path: string | null) =>
        path ? installs.value.find((i) => i.path === path) ?? null : null;
      const resolved =
        pickByPath(rememberedPath) ??
        pickByPath(activeInstall.value?.path ?? null) ??
        installs.value[0] ??
        null;
      activeInstall.value = resolved;
      rememberedPath = null; // consumed
      await persist();
    } finally {
      detecting.value = false;
    }
  }

  /** Switch the active client. Used by the replay-view client selector + the
   *  sidebar. Persists the choice so it survives a restart. */
  async function selectInstall(path: string) {
    const found = installs.value.find((i) => i.path === path);
    if (found) {
      activeInstall.value = found;
      await persist();
    }
  }

  async function setManualPath(path: string) {
    activeInstall.value = await api.setGamePath(path);
    await persist();
  }

  /** Persist the active install's path (just the path — `detect()` re-resolves
   *  kind/realm on the next scan, so we don't risk storing a stale kind). */
  async function persist() {
    try {
      await api.appdataWrite(
        GAME_CONFIG_FILE,
        JSON.stringify({ activePath: activeInstall.value?.path ?? null }),
      );
    } catch {
      // best-effort — don't fail the action if persistence is unavailable
    }
  }

  return {
    installs,
    activeInstall,
    detecting,
    detect,
    load,
    selectInstall,
    setManualPath,
  };
});
