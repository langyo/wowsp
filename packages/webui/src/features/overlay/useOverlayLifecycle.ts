/**
 * Overlay lifecycle (main window): while the game is running AND the table
 * anchoring switch is not off (i.e. the in-game overlay feature is enabled),
 * ensure the hidden transparent overlay window exists (created once — it
 * preloads the webui so the first Tab press is instant) and the Rust Tab
 * watcher is running (`create_overlay_window` starts both, idempotently).
 * When the game exits or the table switch turns off (disabling the whole
 * Tab overlay), tear the window down.
 *
 * Mounted once from App.tsx (the main window root); the gameStatus store's
 * 3-second process poll drives it.
 */
import { watch } from "vue";

import { api } from "@/api";
import { i18n } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useOverlayConfigStore } from "@/stores/overlayConfig";

export function useOverlayLifecycle() {
  const game = useGameStatusStore();
  const installs = useConfigStore();
  const overlayCfg = useOverlayConfigStore();
  void overlayCfg.load();

  // Mirrors the last state we asked the backend for, so the watcher only
  // fires IPC on real transitions (and a failed call retries next change).
  let active = false;
  let createdRealm: string | null | undefined;

  async function sync() {
    const want = game.process.running && overlayCfg.table !== "off";
    // Realm of the running client, else of the selected install.
    const realm = game.process.realm ?? installs.activeInstall?.realm ?? null;
    // The realm is baked into the overlay window's URL — recreate the window
    // when it changes while active (e.g. a different client started).
    if (want && active && realm !== createdRealm) {
      try {
        await api.destroyOverlayWindow();
      } catch {
        // best-effort teardown; the create below replaces it anyway
      }
      active = false;
    }
    if (want === active) return;
    try {
      if (want) {
        const locale = (i18n.global.locale as unknown as { value: string }).value;
        await api.createOverlayWindow(realm ?? undefined, locale);
        active = true;
        createdRealm = realm;
      } else {
        await api.destroyOverlayWindow();
        active = false;
        createdRealm = undefined;
      }
    } catch {
      // Retry on the next state change (e.g. watcher lock hiccup).
      active = false;
    }
  }

  watch(
    [() => game.process.running, () => overlayCfg.table, () => game.process.realm],
    () => void sync(),
    { immediate: true },
  );
}
