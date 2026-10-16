/**
 * Live-battle display lifecycle (main window): while the game runs, the
 * view-mode switch (`overlayConfig.table`) picks which display backend is
 * up —
 *
 * - `"detect"`: the hidden transparent overlay window exists (created once
 *   — it preloads the webui so the first Tab press is instant) and the
 *   Rust Tab watcher is running (`create_overlay_window` starts both,
 *   idempotently);
 * - `"ingame"`: no overlay window at all — the stats bridge starts instead
 *   (`ingame_bridge_start`, idempotent) so the in-game plugin's requests
 *   get answered and its unbound view renders the panel inside the game;
 * - `"off"`: both down.
 *
 * Game exit or a view-mode flip tears the previously-active backend down.
 *
 * Mounted once from App.tsx (the main window root); the gameStatus store's
 * 3-second process poll drives it.
 */
import { watch } from "vue";

import { api } from "@/api";
import { i18n } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useIngamePluginStore } from "@/stores/ingamePlugin";
import { useOverlayConfigStore } from "@/stores/overlayConfig";

export function useOverlayLifecycle() {
  const game = useGameStatusStore();
  const installs = useConfigStore();
  const overlayCfg = useOverlayConfigStore();
  const plugin = useIngamePluginStore();
  void overlayCfg.load();

  // Mirrors the last state we asked the backend for, so the watcher only
  // fires IPC on real transitions (and a failed call retries next change).
  let active = false;
  let bridgeActive = false;
  let createdRealm: string | null | undefined;
  let syncing = false;
  let syncRequested = false;

  function locale(): string {
    return (i18n.global.locale as unknown as { value: string }).value;
  }

  async function sync() {
    if (!overlayCfg.loaded) return;
    const running = game.process.running;
    const mode = overlayCfg.table;
    const wantOverlay = running && mode === "detect";
    const wantBridge = running && mode === "ingame";
    // Realm of the running client: the probe's ground truth while its
    // telemetry stream is fresh (the local player's cluster straight off
    // the game's roster), else the process/install detection.
    const realm =
      plugin.liveSelfRealm || (game.process.realm ?? installs.activeInstall?.realm ?? null);
    // The realm is baked into the overlay window's URL — recreate the window
    // when it changes while active (e.g. a different client started).
    if (active && (!wantOverlay || realm !== createdRealm)) {
      try {
        await api.destroyOverlayWindow();
        active = false;
        createdRealm = undefined;
      } catch {
        // Retain the active state so the next transition retries teardown.
        // Starting a replacement now could leave both backends running.
        return;
      }
    }
    if (bridgeActive && !wantBridge) {
      try {
        await api.stopIngameBridge();
        bridgeActive = false;
      } catch {
        return;
      }
    }
    // Teardown may have outlived the requested replacement. Recompute first
    // so an off/exit arriving during cleanup cannot start a cancelled mode.
    if (syncRequested) return;
    // Stop the previous backend before starting its replacement. Starts
    // remain best-effort on mobile/older shells and retry next transition.
    if (wantOverlay && !active) {
      try {
        await api.createOverlayWindow(realm ?? undefined, locale());
        active = true;
        createdRealm = realm;
      } catch {
        // Retry on the next state change (e.g. watcher lock hiccup).
      }
    }
    if (wantBridge && !bridgeActive) {
      try {
        await api.startIngameBridge(locale());
        bridgeActive = true;
      } catch {
        // Retry on the next state change.
      }
    }
  }

  // An IPC still in flight owns its transition. Changes arriving meanwhile
  // request another pass against current state instead of racing its flags.
  async function requestSync() {
    syncRequested = true;
    if (syncing) return;
    syncing = true;
    try {
      while (syncRequested) {
        syncRequested = false;
        await sync();
      }
    } finally {
      syncing = false;
    }
  }

  watch(
    [
      () => game.process.running,
      () => overlayCfg.table,
      () => overlayCfg.loaded,
      () => game.process.realm,
      // The active install's realm rides the same list: the config store's
      // selection can flip AFTER the overlay window was created (the
      // backend follows the running client a beat after startup — on a
      // Lesta machine whose persisted pick was another install, the
      // watcher below never fired, the window kept the stale realm in its
      // URL, and every stats lookup of the session ran against the WRONG
      // cluster — chips stuck on their no-data face all battle).
      () => installs.activeInstall?.realm ?? null,
      // The probe's ground-truth realm is part of the same decision: it
      // both corrects a wrong detection (the window recreates with the
      // true realm) and lapses back to detection when the identity
      // expires (the store clears it 35 s after the stream stops) —
      // without it here, a lapsed or corrected value would leave a stale
      // window realm with no path to re-sync.
      () => plugin.liveSelfRealm,
    ],
    () => void requestSync(),
    { immediate: true },
  );
}
