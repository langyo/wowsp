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
  /** True once the current roster's battle is KNOWN over: the game deleted
   *  tempArenaInfo.json (battle end / return to port / mid-battle quit).
   *  The roster itself is deliberately KEPT — the live page keeps showing
   *  the last battle (with an "ended" badge) instead of blanking into the
   *  waiting state, until a new battle's roster replaces it or the hard
   *  duration cap clears it. */
  const battleEnded = ref(false);

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
   *  port (mid-battle quits included — no .wowsreplay is written then):
   *  an absent read flips `battleEnded` on but KEEPS the roster, so the
   *  live page keeps presenting the last battle until the next one starts.
   *  Stale-roster drift is bounded elsewhere — the hard duration cap (see
   *  ReplayView's battleCap watcher) force-clears, and a new battle's file
   *  replaces the roster and clears the flag. A partially-written file
   *  fails the read (throws) and keeps the current value. */
  async function refreshArenaInfo(dir?: string) {
    try {
      const info = await api.readTempArenaInfo(dir);
      if (info) {
        arenaInfo.value = info;
        battleEnded.value = false;
      } else if (arenaInfo.value) {
        battleEnded.value = true;
      }
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  /** Force-drop the cached roster (hard battle-duration cap — see
   *  ReplayView's battleCap watcher). Also drops the Tab row order: it
   *  belongs to that battle only. Unlike the poll's end-of-battle path this
   *  clears outright — a roster past its mode's duration cap is stale
   *  garbage, not a finished battle worth keeping on screen. */
  function clearArenaInfo() {
    arenaInfo.value = null;
    tabOrder.value = null;
    battleEnded.value = false;
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
        // Watcher events only fire for a NEWER tempArenaInfo.json — i.e. a
        // new battle's roster, which ends the retained-battle state.
        arenaInfo.value = info;
        battleEnded.value = false;
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
    battleEnded,
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
