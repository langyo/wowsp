import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type ReplayMeta, type ReplayMetaLite } from "@/api";

/** Project a parsed replay header into the list-card shape (same fields the
 *  Rust lite reader produces), so externally picked files render with the
 *  regular card markup. */
function liteFromMeta(m: ReplayMeta): ReplayMetaLite {
  const own = m.vehicles.find((v) => v.relation === 0);
  return {
    path: m.path,
    dateTime: m.dateTime,
    matchGroup: m.matchGroup,
    mapName: m.mapName,
    mapId: m.mapId,
    scenario: m.scenario,
    eventType: m.eventType,
    botCount: m.botCount,
    ownShipId: own?.shipId ?? null,
    ownShipName: own?.shipName ?? null,
    playerCount: m.vehicles.length,
  };
}

/**
 * Holds the replay currently open for review (Mode 1). The holographic map
 * reads `current` to render the match; the replay list carries the parsed
 * descriptor metadata (date/mode/map/own ship) so the list view can render
 * info cards without opening each replay's packet stream.
 *
 * `external` holds session-temporary entries picked from anywhere on disk
 * (shared replays outside the game's replays folder). They queue-jump the
 * list right after the live card and disappear when closed or on reload —
 * never persisted, never mixed into the scanned list.
 */
export const useReplayStore = defineStore("replay", () => {
  const list = ref<ReplayMetaLite[]>([]);
  const external = ref<ReplayMetaLite[]>([]);
  const current = ref<ReplayMeta | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function refreshList(dir?: string) {
    list.value = await api.listReplaysMeta(dir);
  }

  async function open(path: string) {
    loading.value = true;
    error.value = null;
    try {
      current.value = await api.readReplayHeader(path);
    } catch (e) {
      error.value = (e as Error).message;
      current.value = null;
    } finally {
      loading.value = false;
    }
  }

  /** Header-parse picked files and queue them as external entries. Already
   *  open paths are skipped; unreadable files are reported back per path so
   *  the caller can toast them. */
  async function addExternal(paths: string[]): Promise<{
    added: string[];
    failed: { path: string; error: string }[];
  }> {
    const added: string[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const p of paths) {
      if (external.value.some((e) => e.path === p)) continue;
      try {
        external.value.push(liteFromMeta(await api.readReplayHeader(p)));
        added.push(p);
      } catch (e) {
        failed.push({ path: p, error: (e as Error).message });
      }
    }
    return { added, failed };
  }

  /** Drop an external entry (its card's ✕). Closes the viewer if that file
   *  is the one currently open. */
  function removeExternal(path: string) {
    external.value = external.value.filter((e) => e.path !== path);
    if (current.value?.path === path) {
      current.value = null;
      error.value = null;
    }
  }

  function clear() {
    current.value = null;
    error.value = null;
  }

  return {
    list,
    external,
    current,
    loading,
    error,
    refreshList,
    open,
    addExternal,
    removeExternal,
    clear,
  };
});
