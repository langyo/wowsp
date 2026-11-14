/** Updates-section state for SettingsBody: the GitHub mirror ladder
 *  (list + probe), the dynamic data-source rows and the two-step
 *  aux-cache clears. */
import { computed, ref } from "vue";

import { useToast } from "@celestia-island/hikari";

import { api, type GithubMirrorLadder, type MirrorProbeRow } from "@/api";
import { t } from "@/i18n";
import { useCacheStore } from "@/stores/cache";
import { notifySettingsSaved } from "@/stores/settingsSavedFlash";
import { useUpdaterStore } from "@/stores/updater";
import { formatLocalStamp } from "@/utils/format";

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

/** The display label of one inventory version fact. The registry reports
 *  two shapes here: semver / build-id / hash6 values are IDs and stay
 *  verbatim, while RFC3339 stamps (the res-pack and data-pack versions)
 *  are times and render as the same local wall clock the installed column
 *  uses — a raw `2026-11-06T14:34:10Z` chip beside a `2026-11-06 14:34`
 *  one read as two different kinds of value. Empty versions render no chip
 *  (the row's version column simply stays empty). */
export function formatResourceVersion(version?: string | null): string | null {
  if (!version) return null;
  // Only timestamp-SHAPED versions are times; a bare date or a hash never
  // matches, so IDs cannot be mistaken for stamps.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(version)
    ? formatLocalStamp(version)
    : version;
}

/** The ladder served when `github_mirror_ladder` is missing (browser dev
 *  / older shell): the same set the Rust side ships, so the list stays
 *  renderable — user rows simply start empty. */
const FALLBACK_LADDER: GithubMirrorLadder = {
  official: "https://github.com",
  builtIn: [
    "https://ghp.ci",
    "https://gh-proxy.com",
    "https://ghfast.top",
    "https://ghproxy.net",
  ],
  user: [],
};

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

/** One display row of the mirror ladder. */
export interface MirrorListRow {
  prefix: string;
  kind: "official" | "builtin" | "user";
}

export function useSettingsUpdatesState() {
  const cacheStore = useCacheStore();
  const updater = useUpdaterStore();
  const toast = useToast();

  // ── GitHub mirror ladder (settings list) ──────────────────────────────
  // The ladder loads lazily when the section opens (ensureLadder, called
  // by the settings body); until then the fallback set renders so the
  // list never flashes empty in browser dev. probeState holds one entry
  // per prefix: "testing" while the probe call is in flight, the
  // backend's MirrorProbeRow afterwards — absent = never probed.
  const ladder = ref<GithubMirrorLadder>(FALLBACK_LADDER);
  const ladderLoading = ref(false);
  const probing = ref(false);
  const probeState = ref<Record<string, MirrorProbeRow | "testing">>({});
  /** The add-row input draft. */
  const newMirrorDraft = ref("");
  let ladderLoaded = false;

  /** Ladder rows in display order (official → built-in → user — the same
   *  order the probe answers in). */
  const mirrorRows = computed<MirrorListRow[]>(() => [
    { prefix: ladder.value.official, kind: "official" },
    ...ladder.value.builtIn.map((prefix) => ({ prefix, kind: "builtin" as const })),
    ...ladder.value.user.map((prefix) => ({ prefix, kind: "user" as const })),
  ]);

  /** Load the ladder once per hook lifetime (idempotent; a missing
   *  command falls back to the static set). */
  async function ensureLadder() {
    if (ladderLoaded || ladderLoading.value) return;
    ladderLoading.value = true;
    try {
      ladder.value = await api.githubMirrorLadder();
    } catch {
      ladder.value = FALLBACK_LADDER;
    } finally {
      ladderLoaded = true;
      ladderLoading.value = false;
    }
  }

  /** Probe every ladder row once: mark all rows "testing", await the
   *  single backend call, fold the rows back in by prefix. A refused
   *  probe (older shell) drops the pending marks so rows fall back to
   *  "untested" instead of spinning forever. */
  async function probeMirrors() {
    if (probing.value) return;
    probing.value = true;
    const pending: Record<string, MirrorProbeRow | "testing"> = {};
    for (const row of mirrorRows.value) pending[row.prefix] = "testing";
    probeState.value = pending;
    try {
      const folded = { ...pending };
      for (const row of await api.githubMirrorProbe()) folded[row.prefix] = row;
      probeState.value = folded;
    } catch {
      probeState.value = {};
    } finally {
      probing.value = false;
    }
  }

  /** True while an add/remove save is in flight — a second click would
   *  re-read the config before the first save's response lands and drop
   *  its entry. */
  const mirrorSaving = ref(false);

  /** Add a custom mirror prefix: trimmed, trailing slashes stripped,
   *  https-enforced, deduped against the whole ladder, persisted through
   *  the cache store (which spreads the rest of the network config). The
   *  ladder's user rows re-sync from the store's adopted (sanitized)
   *  response. */
  async function addMirror(raw: string) {
    if (mirrorSaving.value) return;
    await ensureLadder();
    const url = raw.trim().replace(/\/+$/, "");
    if (!url.startsWith("https://")) {
      toast.warning(t("settings.mirrorAddInvalid"));
      return;
    }
    if (mirrorRows.value.some((row) => row.prefix === url)) {
      // Already on the ladder (built-in or user) — just clear the draft.
      newMirrorDraft.value = "";
      return;
    }
    mirrorSaving.value = true;
    try {
      await cacheStore.saveMirrors([...ladder.value.user, url]);
      ladder.value = { ...ladder.value, user: [...cacheStore.githubMirrors] };
      newMirrorDraft.value = "";
      notifySettingsSaved();
    } catch {
      // best-effort — desktop persists it
    } finally {
      mirrorSaving.value = false;
    }
  }

  /** Remove one custom mirror prefix (built-in rows cannot be removed —
   *  the section only renders the control on user rows). */
  async function removeMirror(url: string) {
    if (mirrorSaving.value) return;
    await ensureLadder();
    if (!ladder.value.user.includes(url)) return;
    mirrorSaving.value = true;
    try {
      await cacheStore.saveMirrors(ladder.value.user.filter((m) => m !== url));
      ladder.value = { ...ladder.value, user: [...cacheStore.githubMirrors] };
      const next = { ...probeState.value };
      delete next[url];
      probeState.value = next;
      notifySettingsSaved();
    } catch {
      // best-effort — desktop persists it
    } finally {
      mirrorSaving.value = false;
    }
  }

  /** Two-step delete confirm per pack (id of the armed row). */
  const clearArmed = ref<string | null>(null);
  /** Two-step aux-cache clear confirm (scope of the armed row). */
  const auxArmed = ref<string | null>(null);
  /** Two-step confirm for the caches family row's one cleanup verb. */
  const cleanArmed = ref(false);

  /** True while an app update is pending (or streaming) — the resource
   *  pack must wait for it: app first, pack after the restart. */
  const appUpdatePending = computed(() => updater.available && !updater.portable);

  // ── dynamic data sources (resources section) ──────────────────────────
  // The managed rows above the aux caches: the ship-data hot-update pack
  // (data-latest) and the mod-hub catalog. Both show a state stamp and
  // offer an explicit refresh; failures keep the previous stamp — a
  // source the panel cannot reach right now must not read as "bundled".
  const dataPackVersion = ref<string | null>(null);
  const dataPackBusy = ref(false);
  const modCatalogStamp = ref<string | null>(null);
  const modCatalogBusy = ref(false);
  // The registry walk (Settings → resources): one row per runtime-managed
  // resource, spec + on-disk state. It now backs three surfaces — the status
  // card's footprint, the family rows' sizes AND the details panel's audit
  // table — so it loads when the section opens and after every explicit
  // action.
  const resourceRows = ref<Awaited<ReturnType<typeof api.resourcesStatus>> | null>(null);

  async function loadResourceRows() {
    try {
      resourceRows.value = await api.resourcesStatus();
    } catch {
      // keep the previous walk (or none) — the walk is read-only
    }
  }

  /** Total on-disk footprint of the walk's present rows — the status card's
   *  one number. Computed from the walk ONLY (the aux-cache overview measures
   *  the same directories, so it must never be added on top), and the
   *  compile-time bundled snapshot is excluded: it lives inside the app
   *  binary and the user cannot reclaim it. */
  const walkTotalBytes = computed(() =>
    (resourceRows.value ?? []).reduce(
      (sum, row) =>
        row.present && row.sizeBytes > 0 && row.root !== "bundled"
          ? sum + row.sizeBytes
          : sum,
      0,
    ),
  );

  /** The newest check stamp across the walk (the status card's "last
   *  checked"); null until some row records one. */
  const walkCheckedAt = computed(() => {
    let newest: string | null = null;
    for (const row of resourceRows.value ?? []) {
      if (row.checkedAt && (newest == null || row.checkedAt > newest)) newest = row.checkedAt;
    }
    return newest;
  });

  /** Summed size of one family's rows: a family row shows ONE number for the
   *  group instead of one per member. Absent rows and unknown ids add 0. */
  function familyBytes(ids: readonly string[]): number {
    return (resourceRows.value ?? []).reduce(
      (sum, row) => (row.present && ids.includes(row.id) ? sum + row.sizeBytes : sum),
      0,
    );
  }

  /** Run one management verb, then re-walk the registry. The store verbs
   *  keep their own slices fresh, but the walk is what the status card's
   *  footprint and the rows' sizes come from — without this the card would
   *  keep advertising the bytes a delete just freed for the rest of the
   *  session. Shared by the family rows AND the details body so the two
   *  surfaces cannot drift on the contract. */
  async function runVerb(verb: () => Promise<unknown>) {
    await verb();
    await loadResourceRows();
  }

  /** The pack's raw current/latest hash line — the state chip's tooltip AND
   *  the details body's visible audit row render it (both shells read one
   *  derivation, so they can never drift). */
  const packHashHint = computed(() => {
    const st = cacheStore.status;
    const upd = cacheStore.update;
    const parts: string[] = [];
    if (st?.present) {
      parts.push(
        `${t("settings.resCurrent")}: ${
          st.legacyStamp ? t("settings.resLegacy") : hash6(st.treeSha256)
        }`,
      );
      if (st.version && !st.legacyStamp) parts.push(formatStamp(st.version));
    }
    if (upd) parts.push(`${t("settings.resLatest")}: ${hash6(upd.latestTreeSha256)}`);
    return parts.join(" · ");
  });

  // The status card's ONE check verb: re-check every refreshable lane through
  // the shared refresh entry (data-pack lane, res manifest and the AI
  // manifest behind it) and re-walk the registry. Fetch-only — downloads stay
  // behind their own consented rows.
  const checkingAll = ref(false);

  async function checkAll(): Promise<boolean> {
    if (checkingAll.value) return false;
    checkingAll.value = true;
    try {
      await api.refreshResources();
      return true;
    } catch {
      // a lane failure is already logged shell-side; the reload below
      // reports whatever state actually landed
      return false;
    } finally {
      await loadResourceRows();
      checkingAll.value = false;
    }
  }

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
      void loadResourceRows();
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
    ladder,
    ladderLoading,
    mirrorRows,
    probing,
    probeState,
    mirrorSaving,
    newMirrorDraft,
    ensureLadder,
    probeMirrors,
    addMirror,
    removeMirror,
    clearArmed,
    auxArmed,
    cleanArmed,
    appUpdatePending,
    dataPackVersion,
    dataPackBusy,
    modCatalogStamp,
    modCatalogBusy,
    resourceRows,
    loadResourceRows,
    walkTotalBytes,
    walkCheckedAt,
    familyBytes,
    packHashHint,
    runVerb,
    checkAll,
    refreshDataPackRow,
    refreshModCatalogRow,
  };
}
