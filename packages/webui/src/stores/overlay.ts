/**
 * Arena roster store for the MAIN window's live-battle view (ReplayView →
 * LiveBattlePanel): holds the roster pushed by the Rust arena-info watcher
 * (`start_arena_watcher` → `wowsp://arena-info` events).
 *
 * The in-game overlay window does NOT use this store — it is a static page
 * (overlay.html) listening to the same events with its own tiny script.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type ArenaInfo, type TabRowOrder, type VehicleEntry } from "@/api";

export const useOverlayStore = defineStore("arenaOverlay", () => {
  const arenaInfo = ref<ArenaInfo | null>(null);
  /** Realm for batch WG lookups (forwarded via the window URL, with a
   *  detect-game-install fallback for windows created without one). */
  const realm = ref("");
  const watching = ref(false);
  const error = ref<string | null>(null);
  /** Latest recognized in-game Tab row order (`wowsp://tab-order` events,
   *  written by LiveBattlePanel's listener). Matched to the live roster by
   *  `dateTime`; kept in the STORE (not the panel) so it survives panel
   *  unmounts — the live pane closes and reopens while a battle runs. */
  const tabOrder = ref<TabRowOrder | null>(null);

  let arenaUnlisten: (() => void) | null = null;

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

  /** One-shot read of tempArenaInfo.json (if the game is in a battle). The
   *  game DELETES the file when the battle ends / the player returns to
   *  port (mid-battle quits included — no .wowsreplay is written then), so
   *  an absent file must drop the cached roster instead of leaving a stale
   *  one ticking forever. A partially-written file fails the read (throws)
   *  and keeps the current value. */
  async function refreshArenaInfo(dir?: string) {
    try {
      const info = await api.readTempArenaInfo(dir);
      arenaInfo.value = info ?? null;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  /** Force-drop the cached roster (hard battle-duration cap — see
   *  ReplayView's battleCap watcher). Also drops the Tab row order: it
   *  belongs to that battle only. */
  function clearArenaInfo() {
    arenaInfo.value = null;
    tabOrder.value = null;
  }

  /** Store the latest recognized in-game Tab row order (written by
   *  LiveBattlePanel's `wowsp://tab-order` listener). */
  function applyTabOrder(order: TabRowOrder) {
    tabOrder.value = order;
  }

  /** Start the file watcher; incoming arena-info events update `arenaInfo`,
   *  incoming overlay-anchor events (Tab watcher) update `anchor`. */
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
    realm,
    allies,
    enemies,
    tabOrder,
    watching,
    error,
    initRealm,
    refreshArenaInfo,
    clearArenaInfo,
    applyTabOrder,
    startWatching,
    stopWatching,
  };
});
