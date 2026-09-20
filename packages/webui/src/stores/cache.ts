/**
 * Resource-pack + auxiliary-cache state for the Settings → cache management
 * panel. Owns the pack status/update snapshots, the in-flight download
 * progress (fed by the `wowsp://pack-progress` stream) and the GitHub mirror
 * preference (persisted through network-config.json, same file the network
 * section edits).
 *
 * Startup policy lives in AppShell: the model pack auto-downloads only when
 * ENTIRELY missing (lite install / wiped cache); an outdated-but-present
 * pack is surfaced here as `updateAvailable` instead of silently re-pulling
 * ~1.2 GB.
 */
import { defineStore } from "pinia";
import { computed, reactive, ref } from "vue";

import { api, type NetworkConfig, type PackProgress, type PackStatus, type PackUpdate } from "@/api";

export const PACK_IDS = ["models", "dogtags"] as const;
export type PackId = (typeof PACK_IDS)[number];

export function isPackId(id: string): id is PackId {
  return (PACK_IDS as readonly string[]).includes(id);
}

export const useCacheStore = defineStore("resourceCache", () => {
  const packs = ref<PackStatus[]>([]);
  const updates = ref<PackUpdate[]>([]);
  const auxCaches = ref<{ scope: string; sizeBytes: number }[]>([]);
  /** Per-pack live progress from the download stream; a terminal phase
   *  ("done"/"error") stays until the next refresh so the panel can show
   *  the outcome briefly. */
  const progress = reactive<Partial<Record<PackId, PackProgress>>>({});
  const updatesLoading = ref(false);
  const updatesCheckedAt = ref(0);
  /** ghproxy-style mirror prefix; saved through setNetworkConfig so the
   *  rest of the network config round-trips untouched. */
  const githubMirror = ref<string | null>(null);
  let progressWired = false;

  /** Status of one pack (null before the first refresh). */
  function pack(id: PackId): PackStatus | null {
    return packs.value.find((p) => p.id === id) ?? null;
  }

  function updateOf(id: PackId): PackUpdate | null {
    return updates.value.find((u) => u.id === id) ?? null;
  }

  /** True when ANY pack has a known update available — drives the update
   *  banner in the cache section. */
  const anyUpdateAvailable = computed(() =>
    updates.value.some((u) => u.updateAvailable),
  );

  function wireProgressStream() {
    if (progressWired) return;
    progressWired = true;
    // Outside the Tauri shell (browser dev) there is no event source; the
    // optional listener simply stays unset there. The store lives for the
    // app's lifetime, so the returned unlisten is intentionally dropped.
    const un = api.listenPackProgress?.((p) => {
      if (!isPackId(p.id)) return;
      progress[p.id] = p;
    });
    if (un instanceof Promise) void un.catch(() => {});
  }

  /** Refresh the cheap LOCAL state (no network). */
  async function refreshStatus() {
    try {
      packs.value = await api.getPackStatus();
    } catch {
      // older shell / mock — keep whatever we had
    }
    try {
      auxCaches.value = await api.auxCacheOverview();
    } catch {
      auxCaches.value = [];
    }
  }

  /** Refresh the REMOTE stamps (GitHub / mirror reachability required). */
  async function refreshUpdates() {
    updatesLoading.value = true;
    try {
      updates.value = await api.checkPackUpdates();
      updatesCheckedAt.value = Date.now();
    } catch {
      // offline / older shell — keep previous snapshot
    } finally {
      updatesLoading.value = false;
    }
  }

  /** Load the mirror preference from the network config (idempotent). */
  async function loadMirror() {
    try {
      const cfg = await api.getNetworkConfig();
      githubMirror.value = cfg.githubMirror ?? null;
    } catch {
      githubMirror.value = null;
    }
  }

  /** Persist the mirror preference, spreading the rest of the config back
   *  so unrelated fields (proxy, resource CDN) survive the round-trip. */
  async function saveMirror(value: string | null) {
    const current = await api.getNetworkConfig();
    const next: NetworkConfig = {
      ...current,
      githubMirror: value?.trim() || null,
    };
    await api.setNetworkConfig(next);
    githubMirror.value = next.githubMirror ?? null;
  }

  /** Explicit pack download (initial or update). Progress arrives through
   *  the event stream; the panel derives its buttons from `progress`. */
  async function download(id: PackId) {
    wireProgressStream();
    progress[id] = { id, phase: "download", received: 0, total: 0 };
    try {
      await api.packDownload(id);
    } catch (e) {
      // Early rejections (busy guard, unknown id, network-stack failure)
      // never reach install_pack, so no error EVENT arrives — surface the
      // rejection here or the panel would sit on a dead progress bar.
      progress[id] = {
        id,
        phase: "error",
        received: 0,
        total: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    await refreshStatus();
    await refreshUpdates();
  }

  async function cancel() {
    try {
      await api.packCancel();
    } catch {
      /* best-effort */
    }
  }

  async function clearPack(id: PackId) {
    try {
      await api.clearPack(id);
    } catch {
      /* refused while downloading etc. */
    }
    await refreshStatus();
    await refreshUpdates();
  }

  async function clearAuxCache(scope: string) {
    try {
      await api.clearAuxCache(scope);
    } catch {
      /* best-effort */
    }
    try {
      auxCaches.value = await api.auxCacheOverview();
    } catch {
      /* keep previous */
    }
  }

  function init() {
    wireProgressStream();
    void refreshStatus();
    void loadMirror();
  }

  return {
    packs,
    updates,
    auxCaches,
    progress,
    updatesLoading,
    updatesCheckedAt,
    githubMirror,
    anyUpdateAvailable,
    pack,
    updateOf,
    refreshStatus,
    refreshUpdates,
    loadMirror,
    saveMirror,
    download,
    cancel,
    clearPack,
    clearAuxCache,
    init,
  };
});
