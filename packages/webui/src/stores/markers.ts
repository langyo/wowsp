/** Local player-markers store (玩家标记): the user-built colored list and
 *  the marker lookup every battle surface shares (the overlay reads the
 *  backend command directly — it is bare DOM).
 *
 *  Matching contract: colorOf(nickname, accountId) — the exact nickname
 *  (unicode-lowercased, the roster's name) first, the resolved account id
 *  second (rename-proof). The user's own markers are strictly local (no
 *  login, no sync, no upload); entries may also carry the backend's
 *  merged cloud ban-list matches (source "cloud" — see
 *  commands/markers/cloud.rs), which never persist and always lose to a
 *  local judgment. */
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

  /** Newest-fetch-wins guard: the initial load and the event-driven
   *  refetches all write entries — a slower EARLIER answer resolving last
   *  must never clobber a fresher one (the initial load racing the first
   *  cloud refresh is exactly that shape). */
  let fetchSeq = 0;

  /** Load once (idempotent); every battle surface awaits this. The
   *  listener registers before the first fetch resolves so the earliest
   *  possible change event is already covered. */
  async function ensureLoaded(): Promise<void> {
    if (loaded.value) return;
    loaded.value = true;
    // A rejected listen IPC must not surface as an unhandled rejection —
    // the store simply keeps its own fetches as the refresh path.
    void watchChanges().catch(() => undefined);
    const seq = ++fetchSeq;
    const list = await api.markersList();
    if (seq === fetchSeq) entries.value = list;
  }

  /** Re-fetch on the backend's markers-changed broadcast. The overlays
   *  already listened; the store needed it too once the CLOUD side
   *  started writing (a battle's cloud check now refreshes the list
   *  independently of any main-window edit). Debounced trailing — a
   *  local write's own event re-fetches the same truth, and the import
   *  batch must not fan out one fetch per item. */
  let unlistenChanges: (() => void) | null = null;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  async function watchChanges(): Promise<void> {
    if (unlistenChanges) return;
    unlistenChanges =
      (await api.listenMarkersChanged?.(() => {
        if (!loaded.value) return;
        if (refetchTimer) clearTimeout(refetchTimer);
        refetchTimer = setTimeout(() => {
          refetchTimer = null;
          const seq = ++fetchSeq;
          void api
            .markersList()
            .then((list) => {
              if (seq === fetchSeq) entries.value = list;
            })
            .catch(() => {
              /* a failed refresh keeps the last list */
            });
        }, 300);
      })) ?? null;
  }

  /** The marker color for a roster row; null = unmarked. Nickname first
   *  (the user typed the name), account id sharpens the match when known
   *  on both sides (renames keep matching). */
  function colorOf(nickname?: string | null, accountId?: number | null): MarkerColor | null {
    return entryOf(nickname, accountId)?.color ?? null;
  }

  /** The full entry behind a roster row (colorOf's lookup, entry form) —
   *  callers that need the provenance (a cloud row un-marks by DISMISS,
   *  not by markers_remove) read source/accountId off it. Same matching
   *  contract: nickname first, account id second. */
  function entryOf(
    nickname?: string | null,
    accountId?: number | null,
  ): MarkerEntry | null {
    if (nickname) {
      const hit = byNickname.value.get(normNickname(nickname));
      if (hit) return hit;
    }
    if (accountId != null) {
      const hit = byAccountId.value.get(accountId);
      if (hit) return hit;
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

  return { entries, loaded, ensureLoaded, colorOf, entryOf, add, remove, importBatch };
});
