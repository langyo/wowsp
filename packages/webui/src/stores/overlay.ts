/**
 * Arena overlay store (Mode 2). Holds the live roster pushed by the Rust
 * arena-info watcher (`start_arena_watcher` → `wowsp://arena-info` events)
 * plus the latest overlay anchor pushed by the Rust Tab watcher
 * (`wowsp://overlay-anchor`).
 *
 * Window VISIBILITY is driven natively by the Rust Tab watcher (it shows /
 * hides the overlay window without stealing focus) — the web content simply
 * renders whenever the window is visible, so there is no `visible` flag to
 * keep in sync here.
 *
 * This is the store the dedicated overlay window (OverlayApp) consumes. It is
 * distinct from the popup registry (`stores/popupRegistry.ts`) which
 * coordinates modal/drawer z-index stacking in the main window.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type ArenaInfo, type OverlayAnchor, type VehicleEntry } from "@/api";

export const useOverlayStore = defineStore("arenaOverlay", () => {
  const arenaInfo = ref<ArenaInfo | null>(null);
  const anchor = ref<OverlayAnchor | null>(null);
  /** Realm for batch WG lookups (forwarded via the window URL, with a
   *  detect-game-install fallback for windows created without one). */
  const realm = ref("");
  const watching = ref(false);
  const error = ref<string | null>(null);

  let arenaUnlisten: (() => void) | null = null;
  let anchorUnlisten: (() => void) | null = null;

  const allies = computed<VehicleEntry[]>(
    () => arenaInfo.value?.vehicles.filter((v) => v.relation <= 1) ?? [],
  );
  const enemies = computed<VehicleEntry[]>(
    () => arenaInfo.value?.vehicles.filter((v) => v.relation > 1) ?? [],
  );

  /** Resolve the realm once on mount: URL query first (`?realm=eu` appended
   *  by `create_overlay_window`), else the first detected install. */
  async function initRealm() {
    if (realm.value) return;
    const fromUrl = new URLSearchParams(window.location.search).get("realm");
    if (fromUrl) {
      realm.value = fromUrl;
      return;
    }
    try {
      const installs = await api.detectGameInstall();
      if (installs[0]?.realm) realm.value = installs[0].realm;
    } catch {
      // fall through to the default
    }
    if (!realm.value) realm.value = "asia";
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

  /** Start the file watcher; incoming arena-info events update `arenaInfo`,
   *  incoming overlay-anchor events (Tab watcher) update `anchor`. */
  async function startWatching(dir?: string) {
    if (watching.value) return;
    try {
      await api.startArenaWatcher(dir);
      arenaUnlisten = (await api.listenArenaInfo((info) => {
        arenaInfo.value = info;
        // A new battle invalidates the previous anchor (rows were for the
        // old roster); Rust re-anchors on the next Tab press anyway.
        anchor.value = null;
      })) as (() => void) | null;
      anchorUnlisten = (await api.listenOverlayAnchor((a) => {
        anchor.value = a;
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
    anchorUnlisten?.();
    anchorUnlisten = null;
    try {
      await api.stopArenaWatcher();
    } catch {
      // best-effort
    }
    watching.value = false;
  }

  return {
    arenaInfo,
    anchor,
    realm,
    allies,
    enemies,
    watching,
    error,
    initRealm,
    refreshArenaInfo,
    startWatching,
    stopWatching,
  };
});
