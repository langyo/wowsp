/** Updates-section state for SettingsBody: the GitHub mirror draft, the
 *  dynamic data-source rows and the two-step aux-cache clears. */
import { computed, ref } from "vue";

import { api } from "@/api";
import { t } from "@/i18n";
import { useCacheStore } from "@/stores/cache";
import { useUpdaterStore } from "@/stores/updater";

/** Human-readable bytes (1 decimal under GB, integer above). */
export function formatBytes(n: number): string {
  if (!n) return "0 MB";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** The release `updated_at` stamp shown as a local date-time. */
export function formatStamp(stamp?: string | null): string {
  if (!stamp) return t("settings.cacheVersionUnknown");
  const d = new Date(stamp);
  return Number.isNaN(d.getTime()) ? stamp : d.toLocaleString();
}

/** The display form of a tree hash — its LAST 6 hex chars, upper-case
 *  (the "game build id" convention the publisher's delta tags use). */
export function hash6(hash?: string | null): string {
  if (!hash) return t("settings.resVersionUnknown");
  return hash.slice(-6).toUpperCase();
}

/** Aux-cache scope → i18n keys (unknown future scopes render raw). */
const AUX_LABELS: Record<string, { title: string; desc: string }> = {
  "image-cache": {
    title: "settings.cacheAuxImageCache",
    desc: "settings.cacheAuxImageCacheDesc",
  },
  gameparams: {
    title: "settings.cacheAuxGameparams",
    desc: "settings.cacheAuxGameparamsDesc",
  },
  encyclopedia: {
    title: "settings.cacheAuxEncyclopedia",
    desc: "settings.cacheAuxEncyclopediaDesc",
  },
  community: {
    title: "settings.cacheAuxCommunity",
    desc: "settings.cacheAuxCommunityDesc",
  },
};

export function auxTitle(scope: string): string {
  const key = AUX_LABELS[scope]?.title;
  return key ? t(key) : scope;
}

export function auxDesc(scope: string): string {
  const key = AUX_LABELS[scope]?.desc;
  return key ? t(key) : "";
}

export function useSettingsUpdatesState() {
  const cacheStore = useCacheStore();
  const updater = useUpdaterStore();

  /** Mirror input draft; commits through the cache store (which spreads
   *  the rest of the network config). */
  const mirrorDraft = ref("");
  const mirrorSavedFlash = ref(false);
  let mirrorFlashTimer: number | undefined;
  /** Two-step delete confirm per pack (id of the armed row). */
  const clearArmed = ref<string | null>(null);
  /** Two-step aux-cache clear confirm (scope of the armed row). */
  const auxArmed = ref<string | null>(null);
  /** Common ghproxy presets — click to fill the input. The same set the
   *  app rotates through automatically (see github_mirror.rs), plus ghp.ci
   *  which the built-in ladder tries first. */
  const MIRROR_PRESETS = [
    "https://ghp.ci",
    "https://ghfast.top",
    "https://gh-proxy.com",
    "https://ghproxy.net",
  ] as const;

  const mirrorDirty = computed(
    () => (mirrorDraft.value.trim() || null) !== (cacheStore.githubMirror ?? null),
  );

  async function saveMirror() {
    if (!mirrorDirty.value) return;
    try {
      await cacheStore.saveMirror(mirrorDraft.value || null);
      mirrorDraft.value = cacheStore.githubMirror ?? "";
      mirrorSavedFlash.value = true;
      window.clearTimeout(mirrorFlashTimer);
      mirrorFlashTimer = window.setTimeout(() => (mirrorSavedFlash.value = false), 1600);
    } catch {
      // best-effort — desktop persists it
    }
  }

  /** True while an app update is pending (or streaming) — the resource
   *  pack must wait for it: app first, pack after the restart. */
  const appUpdatePending = computed(() => updater.available && !updater.portable);

  // ── dynamic data sources (updates section) ──────────────────────────
  // The managed rows above the aux caches: the ship-data hot-update pack
  // (data-latest) and the mod-hub catalog. Both show a state stamp and
  // offer an explicit refresh; failures keep the previous stamp — a
  // source the panel cannot reach right now must not read as "bundled".
  const dataPackVersion = ref<string | null>(null);
  const dataPackBusy = ref(false);
  const modCatalogStamp = ref<string | null>(null);
  const modCatalogBusy = ref(false);

  async function refreshDataPackRow(force: boolean) {
    if (dataPackBusy.value) return;
    dataPackBusy.value = true;
    try {
      if (force) await api.refreshDataPack();
      dataPackVersion.value = await api.dataPackInfo();
    } catch {
      // keep the previous stamp
    } finally {
      dataPackBusy.value = false;
    }
  }

  async function refreshModCatalogRow(force: boolean) {
    if (modCatalogBusy.value) return;
    modCatalogBusy.value = true;
    try {
      // force=false serves the 6-hour cache; the row's button passes
      // true for an explicit refresh, same as the Mod Hub page's.
      const idx = await api.modCatalogRefresh(force);
      modCatalogStamp.value = idx?.fetchedAt ?? null;
    } catch {
      // keep the previous stamp
    } finally {
      modCatalogBusy.value = false;
    }
  }

  return {
    cacheStore,
    updater,
    mirrorDraft,
    mirrorSavedFlash,
    clearArmed,
    auxArmed,
    MIRROR_PRESETS,
    mirrorDirty,
    saveMirror,
    appUpdatePending,
    dataPackVersion,
    dataPackBusy,
    modCatalogStamp,
    modCatalogBusy,
    refreshDataPackRow,
    refreshModCatalogRow,
  };
}
