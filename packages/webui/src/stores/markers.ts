/** Local player-markers store (玩家标记): the user-built colored list and
 *  the marker lookup every battle surface shares (the overlay reads the
 *  backend command directly — it is bare DOM).
 *
 *  Matching contract: colorOf(nickname, accountId) — the exact nickname
 *  (unicode-lowercased, the roster's name) first, the resolved account id
 *  second (rename-proof). Strictly local data: no login, no sync, no
 *  upload — the markers are the user's own judgments. */
import { computed, ref } from "vue";
import { defineStore } from "pinia";

import { api } from "@/api";
import type {
  MarkerColor,
  MarkerEntry,
  MarkerImportItem,
  MarkerImportResult,
} from "@/api";

/** The three colors, in list order. */
export const MARKER_COLORS = ["red", "yellow", "purple"] as const;

function normNickname(name: string): string {
  return name.trim().toLowerCase();
}

export const useMarkersStore = defineStore("markers", () => {
  const entries = ref<MarkerEntry[]>([]);
  const loaded = ref(false);

  const byNickname = computed(
    () => new Map(entries.value.map((entry) => [normNickname(entry.nickname), entry])),
  );
  const byAccountId = computed(() => {
    const map = new Map<number, MarkerEntry>();
    for (const entry of entries.value) {
      if (entry.accountId != null) map.set(entry.accountId, entry);
    }
    return map;
  });

  /** Load once (idempotent); every battle surface awaits this. */
  async function ensureLoaded(): Promise<void> {
    if (loaded.value) return;
    loaded.value = true;
    entries.value = await api.markersList();
  }

  /** The marker color for a roster row; null = unmarked. Nickname first
   *  (the user typed the name), account id sharpens the match when known
   *  on both sides (renames keep matching). */
  function colorOf(nickname?: string | null, accountId?: number | null): MarkerColor | null {
    if (nickname) {
      const hit = byNickname.value.get(normNickname(nickname));
      if (hit) return hit.color;
    }
    if (accountId != null) {
      const hit = byAccountId.value.get(accountId);
      if (hit) return hit.color;
    }
    return null;
  }

  /** Add or update (same nickname upserts). The backend returns the full
   *  list, which becomes the store's truth (disk is authoritative). */
  async function add(
    nickname: string,
    color: MarkerColor,
    note?: string | null,
    accountId?: number | null,
  ): Promise<void> {
    entries.value = await api.markersAdd(nickname, color, note, accountId);
  }

  async function remove(nickname: string): Promise<void> {
    entries.value = await api.markersRemove(nickname);
  }

  /** Batch import (the ApeRadar wizard, 海猴雷达导入): markers_add's
   *  upsert semantics per item, ONE atomic write + ONE change event for
   *  the whole batch. The backend returns the refreshed list plus
   *  add/update/skip counters; the list becomes the store's truth (disk
   *  is authoritative) and the counters ride back to the caller's toast. */
  async function importBatch(items: MarkerImportItem[]): Promise<MarkerImportResult> {
    const result = await api.markersImport(items);
    entries.value = result.list;
    return result;
  }

  return { entries, loaded, ensureLoaded, colorOf, add, remove, importBatch };
});
