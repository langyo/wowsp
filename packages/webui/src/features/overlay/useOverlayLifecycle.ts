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

  function locale(): string {
    return (i18n.global.locale as unknown as { value: string }).value;
  }

  async function sync() {
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
    if (wantOverlay && active && realm !== createdRealm) {
      try {
        await api.destroyOverlayWindow();
      } catch {
        // best-effort teardown; the create below replaces it anyway
      }
      active = false;
    }
    // Overlay window (the "detect" backend).
    if (wantOverlay !== active) {
      try {
        if (wantOverlay) {
          await api.createOverlayWindow(realm ?? undefined, locale());
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
    // In-game stats bridge (the "ingame" backend). Best-effort both ways:
    // on mobile (or an older shell) the invoke rejects — the panel mode is
    // desktop-only, and the failed call retries on the next transition.
    if (wantBridge !== bridgeActive) {
      try {
        if (wantBridge) {
          await api.startIngameBridge(locale());
        } else {
          await api.stopIngameBridge();
        }
        bridgeActive = wantBridge;
      } catch {
        bridgeActive = false;
      }
    }
  }

  watch(
    [
      () => game.process.running,
      () => overlayCfg.table,
      () => game.process.realm,
      // The probe's ground-truth realm is part of the same decision: it
      // both corrects a wrong detection (the window recreates with the
      // true realm) and lapses back to detection when the identity
      // expires (the store clears it 35 s after the stream stops) —
      // without it here, a lapsed or corrected value would leave a stale
      // window realm with no path to re-sync.
      () => plugin.liveSelfRealm,
    ],
    () => void sync(),
    { immediate: true },
  );
}
