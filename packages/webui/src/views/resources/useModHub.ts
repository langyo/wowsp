/** The Mod Hub state machine (the Resources view minus rendering):
 *  installed-unit scans, the online catalog + records ledger, install /
 *  uninstall / toggle actions, safe mode and the ?mod / ?migrate deep
 *  links. The migration wizard's state lives in useMigrateWizard, which
 *  takes this composable's return value as its input. */
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useToast } from "@celestia-island/hikari";

import {
  api,
  type CatalogEntry,
  type CatalogProgress,
  type CatalogTag,
  type ForeignModUnit,
  type InstalledMod,
  type ModInstallRecord,
  type ModKind,
  type PackagePlan,
  type PnfLoaderStatus,
  type StaleBinInfo,
} from "@/api";
import {
  KIND_BIG,
  catBig,
  isCatalogCat,
  type BigCat,
  type CatalogCat,
} from "@/features/modhub/taxonomy";
import { listedEntries } from "@/features/modhub/catalogListed";
import { requestModOpDisclaimer } from "@/features/modhub/ModOpDisclaimer";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { usePluginUpdatesStore } from "@/stores/pluginUpdates";
import { useStaleBinsStore } from "@/stores/staleBins";
import { t } from "@/i18n";
import { sameGamePath } from "@/utils/gamePath";
import { entryMatches, installerLabel, localized } from "./display";
import type { Selection, TextureComponent } from "./types";

export function useModHub() {
  const config = useConfigStore();
  const toast = useToast();
  const route = useRoute();
  const router = useRouter();
  const staleStore = useStaleBinsStore();

  const source = ref<"online" | "installed">("online");
  // Chosen scheme of the catalog entry on the pane — "" = the entry's
  // default package list. Reset on every pane change (rows, folder flow,
  // delisted notice) so a stale choice never leaks across entries.
  const selectedPreset = ref("");
  const bigCat = ref<BigCat>("function");
  // Sub-division chip selections (multi-select, union semantics): an
  // EMPTY set shows everything, each clicked chip adds/removes its
  // bucket. No "all" pseudo-chip — clearing the selection is the all
  // view, which is why these reset wholesale on a big-category switch.
  const catalogCats = ref(new Set<CatalogCat>());
  const kindFilters = ref(new Set<ModKind>());
  const selection = ref<Selection | null>(null);

  const installed = ref<InstalledMod[]>([]);
  const foreignUnits = ref<ForeignModUnit[]>([]);
  const scanning = ref(false);

  const sourcePath = ref("");
  const analyzing = ref(false);
  const plan = ref<PackagePlan | null>(null);
  const planError = ref("");
  const installing = ref(false);
  const report = ref<{
    name: string;
    count: number;
    version: string;
    warnings: string[];
    mirrored: string[];
  } | null>(null);

  // ── Online catalog state ──
  const catalog = ref<CatalogEntry[]>([]);
  // Tag registry: ids on entries mean nothing without it — loaded once
  // per mount (the backend caches/refreshes its own copy).
  const tagTable = ref(new Map<string, CatalogTag>());
  const catalogSource = ref("");
  const catalogFetched = ref("");
  const catalogLoading = ref(false);
  const catalogError = ref("");
  const records = ref<ModInstallRecord[]>([]);
  // Per-mod download-progress map (Vue instruments collection mutations,
  // so `.set`/`.delete` re-render). Only the mods currently being
  // processed appear here — every other row stays fully clickable while
  // one download runs, and parallel installs each track their own state.
  // Busy state itself is NOT local: the rows read the pluginUpdates
  // store's SHARED per-item table (the `busy` alias below), so the
  // sidebar's batch pass and the live page's probe card disable the
  // same items here, and an install started here shows up on them.
  const progresses = ref(new Map<string, CatalogProgress>());
  const confirmTarget = ref<CatalogEntry | null>(null);

  // Installed-unit actions: relPath → "toggle" | "uninstall".
  const unitBusy = ref(new Map<string, "toggle" | "uninstall">());
  const unitTarget = ref<InstalledMod | null>(null);
  // ModStation uninstall target — its trees live outside res_mods, so
  // they uninstall through their own command instead of unit_ops.
  const foreignTarget = ref<ForeignModUnit | null>(null);

  // Stale-bin migration: older `bin/<version>/res_mods` leftovers the
  // game stopped loading after an update — surfaced so they can be moved
  // into the current version instead of lingering as dead weight.
  const staleBins = ref<StaleBinInfo[]>([]);
  // ModAPI marker health — PnF content with a missing marker is the
  // "everything silently dead" shape (banner + one-click heal).
  const loaderStatus = ref<PnfLoaderStatus | null>(null);
  const restoringLoader = ref(false);
  // `migrating` means "the wizard's execute step is in flight"; the ⋯ menu
  // entry and the stale banner button both disable on it. (Owned by the
  // wizard composable — see useMigrateWizard.)
  // Set by the sidebar prompt's deep link (?migrate=1) on mount; the
  // first completed scan consumes it by opening the wizard.
  let autoMigrateArmed = false;
  /** The wizard opener is bound by the view AFTER useMigrateWizard is
   *  created (scan runs only after setup completes, so the binding is
   *  always in place before the armed deep link can consume it). */
  let openMigrateWizard: (() => void) | null = null;
  function bindMigrateWizard(open: () => void) {
    openMigrateWizard = open;
  }

  // ── Migration wizard state (plan → review → executing → done) ──
  // lives in useMigrateWizard (it receives this composable's return).

  // Safe mode: the whole current res_mods is quarantined under a
  // `.wowsp-disabled` rename — one click to test the game with every
  // res_mods mod bypassed (the fastest crash bisect), one click to bring
  // everything back.
  const safeMode = ref(false);
  const safeModeAsk = ref<"on" | "off" | null>(null);
  const safeModeBusy = ref(false);

  // Header overflow menu (the ⋯ button): tool entries that used to be
  // free-floating banners — safe mode both ways, the migration wizard.
  const toolsOpen = ref(false);
  const toolsAnchor = ref<HTMLElement | null>(null);

  const gameStatus = useGameStatusStore();
  const pluginUpdates = usePluginUpdatesStore();
  // The catalog rows' busy state = the pluginUpdates store's shared
  // per-item table (probe + mod ids → op in flight). One map across
  // every update surface: a sidebar batch pass or a live-page probe op
  // disables its item here, and these rows' own installs register in
  // the same table so the other surfaces disable too.
  const busy = computed(() => pluginUpdates.itemBusy);
  // The install every mod operation targets: the user's selection, with
  // the RUNNING client's folder as the fallback (same order the ship
  // detail uses) so the page keeps working when no selection is present.
  const gameRoot = computed(
    () => config.activeInstall?.path ?? gameStatus.process.matchedInstall?.path ?? "",
  );
  let scanGeneration = 0;
  onBeforeUnmount(() => {
    scanGeneration++;
  });

  /** Mutating res_mods while THAT client is running tears half-loaded
   *  mods — the backend rejects it root-scoped; this pre-check mirrors
   *  the same rule (a different client running elsewhere must not block
   *  work on the selected install) and gives the localized message.
   *  Multi-instance: ANY running client whose folder matches the target
   *  blocks it — the watched instance alone is not the whole picture.
   *  When a running process's folder is unknown, stay conservative and
   *  block (the old blanket behavior). */
  function gameRunning(): boolean {
    const roots = gameStatus.processes
      .filter((p) => p.running)
      .map((p) => p.matchedInstall?.path ?? null);
    if (roots.length === 0) return false;
    // Unknown folder → stay conservative and block (the old blanket
    // behavior); otherwise only a root match on the target blocks.
    const targetsRunningClient =
      roots.some((r) => r == null) ||
      roots.some((r) => r != null && sameGamePath(gameRoot.value, r));
    if (targetsRunningClient) {
      toast.error(t("resources.gameRunningBlock"));
      return true;
    }
    return false;
  }

  let detach: (() => void) | undefined;
  onMounted(() => {
    // One subscription on the shared download bus, filtered to mod
    // installs; the package counters ride the event's `detail`.
    detach = api.listenDownloadProgress?.((p) => {
      if (p.kind !== "mod-package") return;
      if (p.phase === "done") {
        progresses.value.delete(p.id);
      } else {
        const detail = p.detail ?? {};
        progresses.value.set(p.id, {
          id: p.id,
          phase: p.phase,
          package: detail.package ?? 0,
          packages: detail.packages ?? 0,
          received: p.received,
          total: p.total,
        });
      }
    });
  });
  onUnmounted(() => detach?.());

  async function loadCatalog(force: boolean) {
    if (catalogLoading.value) return;
    catalogLoading.value = true;
    catalogError.value = "";
    try {
      const index = await api.modCatalogRefresh(force);
      catalog.value = index.mods;
      catalogSource.value = index.sourceVersion;
      catalogFetched.value = index.fetchedAt;
    } catch (e) {
      catalogError.value = e instanceof Error ? e.message : String(e);
    } finally {
      catalogLoading.value = false;
    }
  }

  async function loadRecords() {
    try {
      records.value = await api.modHubRecords();
    } catch {
      records.value = [];
    }
  }

  // The shared busy table draining to empty means an update pass on
  // ANOTHER surface (sidebar batch, live probe card) just finished —
  // this page's own ops reload the ledger themselves, but the rows'
  // up-to-date badges must follow a foreign pass too, so one ledger
  // reload rides the busy→idle transition.
  watch(
    () => pluginUpdates.itemBusy.size,
    (now, was) => {
      if ((was ?? 0) > 0 && now === 0) void loadRecords();
    },
  );

  // ── Deep link (?mod=<catalog id>): the settings' roster plugin button ──
  // lands here. The query is watched REACTIVELY: the settings surface is a
  // modal stacked on top of this view, so a click while /resources is
  // already active re-uses this component instance — a mount-time read of
  // route.query would never fire. The index may still be loading on a cold
  // visit, so the pending id survives until the catalog has (or clearly
  // never has) the row; filters reset so the row is visible in the list.
  const pendingDeepLink = ref("");
  watch(
    () => route.query.mod,
    (v) => {
      if (typeof v === "string" && v) pendingDeepLink.value = v;
    },
    { immediate: true },
  );

  // ── Deep link (?migrate=1): the sidebar's game-upgrade prompt ────────
  // Reactive for the same reason as ?mod= above — the sidebar outlives
  // this view, so a prompt click while /resources is already active must
  // re-fire here. The wizard needs scan results: a cold visit leaves the
  // flag armed for the first completed scan to consume, a warm click
  // (stale bins already on screen) opens right away. Either way the
  // query is stripped at once so a refresh never re-triggers it.
  watch(
    () => route.query.migrate,
    (v) => {
      if (v !== "1") return;
      autoMigrateArmed = true;
      void router.replace({ query: { ...route.query, migrate: undefined } });
      if (!scanning.value && staleBins.value.length > 0) {
        autoMigrateArmed = false;
        openMigrateWizard?.();
      }
    },
    { immediate: true },
  );
  /** A deep link that resolved to a DELISTED entry — the pane then says
   *  so instead of opening a detail (the entry stays in the index only
   *  for this explanation; lists and search never show it). */
  const delistedHit = ref<CatalogEntry | null>(null);
  let deepLinkForced = false;
  watch(catalog, (mods) => {
    const want = pendingDeepLink.value;
    if (!want || !mods.length) return;
    const hit = mods.find((m) => m.id === want);
    if (!hit) {
      // A stale cached index predates the row — force one refresh before
      // giving up (offline / genuinely absent entries stop here).
      if (!deepLinkForced) {
        deepLinkForced = true;
        void loadCatalog(true);
      }
      return;
    }
    pendingDeepLink.value = "";
    selectedPreset.value = "";
    if (hit.delisted) {
      // Force-opened a withdrawn mod (closed discussion thread): explain
      // instead of opening the detail — there is nothing to install. An
      // open selection would mask the notice (the pane prefers it), so
      // the deep link takes over the pane.
      selection.value = null;
      delistedHit.value = hit;
      return;
    }
    delistedHit.value = null;
    source.value = "online";
    bigCat.value = catBig(hit.category);
    catalogCats.value = new Set();
    selection.value = { mode: "catalog", entry: hit };
  });

  /** The ledger is global: only records of THIS install (or legacy
   *  unstamped ones) describe what is installed here. */
  const recordOf = (id: string) =>
    records.value.find(
      (r) => r.id === id && (!r.gameRoot || r.gameRoot === gameRoot.value),
    );

  /** Installed units are keyed by their primary path (unique per unit). */
  const unitKey = (m: InstalledMod) => m.relPath;

  async function installMod(entry: CatalogEntry, preset?: string) {
    if (!gameRoot.value || busy.value.has(entry.id) || gameRunning() || safeModeBlocked()) {
      return;
    }
    if (!(await requestModOpDisclaimer())) return;
    // Captured before the RPC: installing over a foreign (Aslain) copy
    // is a REGISTRATION — the backend cuts the foreign installer's
    // manifest rows, the follow-up toast says ownership moved.
    const tookOverForeign = !!foreignCopyOf(entry);
    try {
      // The shared run registers the row in the store-wide busy table
      // and fans out the freshness sync (sidebar badge + live probe)
      // when it lands.
      const r = await pluginUpdates.runMod(entry.id, gameRoot.value, preset);
      toast.success(t("resources.installedDone", { name: r.name, version: entry.version }));
      if (tookOverForeign) {
        toast.info(t("resources.registeredOverForeign", { name: r.name }));
      }
      for (const v of r.mirroredBins ?? []) {
        toast.info(t("resources.mirroredBins", { version: v }));
      }
      for (const c of r.conflicts ?? []) toast.info(c);
      await Promise.all([scan(), loadRecords(), pluginUpdates.syncFreshness()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      progresses.value.delete(entry.id);
    }
  }

  async function uninstallMod() {
    const entry = confirmTarget.value;
    if (!entry || !gameRoot.value || busy.value.has(entry.id)) return;
    if (gameRunning() || safeModeBlocked()) {
      confirmTarget.value = null;
      return;
    }
    confirmTarget.value = null;
    if (!(await requestModOpDisclaimer())) return;
    try {
      const r = await pluginUpdates.runModUninstall(entry.id, gameRoot.value);
      toast.success(
        t("resources.uninstalledDone", {
          name: r.name,
          removed: r.removedFiles,
          restored: r.restoredFiles > 0 ? t("resources.restoredPart", { count: r.restoredFiles }) : "",
        }),
      );
      await Promise.all([scan(), loadRecords(), pluginUpdates.syncFreshness()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      progresses.value.delete(entry.id);
    }
  }

  // ── Installed-unit actions (temporary disable via `.bak`, uninstall) ──

  async function toggleUnit(mod: InstalledMod, enabled: boolean) {
    if (
      !gameRoot.value ||
      unitBusy.value.has(unitKey(mod)) ||
      gameRunning() ||
      safeModeBlocked()
    ) {
      return;
    }
    if (!(await requestModOpDisclaimer())) return;
    unitBusy.value.set(unitKey(mod), "toggle");
    try {
      await api.modHubSetUnitEnabled(mod.relPath, gameRoot.value, enabled);
      toast.success(
        enabled
          ? t("resources.unitEnabled", { name: mod.name })
          : t("resources.unitDisabled", { name: mod.name }),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      unitBusy.value.delete(unitKey(mod));
      await scan();
    }
  }

  async function uninstallUnit() {
    const mod = unitTarget.value;
    if (!mod || !gameRoot.value || unitBusy.value.has(unitKey(mod))) return;
    if (gameRunning() || safeModeBlocked()) {
      unitTarget.value = null;
      return;
    }
    unitTarget.value = null;
    if (!(await requestModOpDisclaimer())) return;
    unitBusy.value.set(unitKey(mod), "uninstall");
    try {
      const r = await api.modHubUninstallUnit(mod.relPath, gameRoot.value);
      toast.success(
        t("resources.uninstalledDone", {
          name: r.name,
          removed: r.removedFiles,
          restored: r.restoredFiles > 0 ? t("resources.restoredPart", { count: r.restoredFiles }) : "",
        }),
      );
      // The unit's ledger rows leave with its files — freshness sync.
      await Promise.all([scan(), loadRecords(), pluginUpdates.syncFreshness()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      unitBusy.value.delete(unitKey(mod));
    }
  }

  // ── Foreign-unit actions ──────────────────────────────────────────────
  // Aslain units are anchored in the installed list by their manifest
  // name, so their toggle / uninstall ride the SAME unit_ops handlers
  // above (the backend also syncs Aslain's manifest row). Only
  // ModStation trees — outside res_mods entirely — need their own path.
  async function uninstallModstation() {
    const unit = foreignTarget.value;
    if (!unit || !gameRoot.value) return;
    if (gameRunning() || safeModeBlocked()) {
      foreignTarget.value = null;
      return;
    }
    foreignTarget.value = null;
    if (!(await requestModOpDisclaimer())) return;
    try {
      await api.modHubUninstallModstationUnit(gameRoot.value, unit.key);
      toast.success(t("resources.modstationUninstalled", { name: unit.name }));
      await scan();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function scan() {
    if (!gameRoot.value || scanning.value) return;
    scanning.value = true;
    const root = gameRoot.value;
    const generation = ++scanGeneration;
    const isCurrent = () => generation === scanGeneration;
    try {
      // Publish one root's snapshot together. A root switch immediately
      // starts its own scan; the superseded scan cannot publish or launch
      // more root-scoped work after its current request settles.
      const mods = await api.modHubScanInstalled(root);
      if (!isCurrent()) return;
      const foreign = await api.modHubForeignUnits(root).catch((e) => {
        console.warn("foreign-unit detection failed", e);
        return [];
      });
      if (!isCurrent()) return;
      const stale = await api.modHubStaleVersions(root).catch((e) => {
        console.warn("stale-bin detection failed", e);
        return [];
      });
      if (!isCurrent()) return;
      const loader = await api.modHubPnfLoaderStatus(root).catch((e) => {
        console.warn("loader-marker detection failed", e);
        return null;
      });
      if (!isCurrent()) return;
      const quarantined = await api.modHubSafeMode(root).catch(() => false);
      if (!isCurrent()) return;
      installed.value = mods;
      foreignUnits.value = foreign;
      staleBins.value = stale;
      loaderStatus.value = loader;
      safeMode.value = quarantined;
      // Same data the sidebar prompt polls — adopt it so the footer row
      // clears the moment a migration finishes, not on the next poll.
      staleStore.adopt(root, stale);
      // Reconcile ghost ledger records (files gone from disk) and orphaned
      // snapshot dirs; refresh the records list when something dropped.
      const rec = await api.modHubReconcile(root).catch(() => null);
      if (!isCurrent()) return;
      if (rec && rec.droppedRecords > 0) {
        const refreshed = await api.modHubRecords().catch(() => []);
        if (!isCurrent()) return;
        records.value = refreshed;
        toast.info(t("resources.reconciled", { n: rec.droppedRecords }));
      }
      // Sidebar deep-link (?migrate=1): once the first scan says there is
      // something to migrate, open the wizard on its confirm step. Fired
      // once — later scans never resurrect a wizard the user closed.
      if (autoMigrateArmed) {
        autoMigrateArmed = false;
        openMigrateWizard?.();
      }
    } catch (e) {
      if (isCurrent()) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      if (isCurrent()) scanning.value = false;
    }
  }

  /** Mutations are refused while res_mods is quarantined — pre-check so
   *  the localized message shows instead of the backend's English one. */
  function safeModeBlocked(): boolean {
    if (safeMode.value) {
      toast.error(t("resources.safeModeBlock"));
      return true;
    }
    return false;
  }

  async function doSafeMode() {
    const dir = safeModeAsk.value;
    safeModeAsk.value = null;
    if (!dir || !gameRoot.value || safeModeBusy.value || gameRunning()) return;
    if (!(await requestModOpDisclaimer())) return;
    safeModeBusy.value = true;
    try {
      const active = await api.modHubSetSafeMode(gameRoot.value, dir === "on");
      toast.success(
        active ? t("resources.safeModeOnDone") : t("resources.safeModeOffDone"),
      );
      await scan();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      safeModeBusy.value = false;
    }
  }

  async function analyze() {
    if (!sourcePath.value.trim() || analyzing.value) return;
    analyzing.value = true;
    plan.value = null;
    planError.value = "";
    report.value = null;
    try {
      plan.value = await api.modHubClassifyPath(sourcePath.value.trim());
    } catch (e) {
      planError.value = e instanceof Error ? e.message : String(e);
    } finally {
      analyzing.value = false;
    }
  }

  async function restoreLoaderMarker() {
    if (!gameRoot.value || restoringLoader.value || gameRunning() || safeModeBlocked()) return;
    if (!(await requestModOpDisclaimer())) return;
    restoringLoader.value = true;
    try {
      const wrote = await api.modHubRestorePnfLoaderMarker(gameRoot.value);
      if (wrote) toast.success(t("resources.pnfLoaderRestored"));
      await scan();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      restoringLoader.value = false;
    }
  }

  async function confirmInstall() {
    if (!plan.value || installing.value || gameRunning() || safeModeBlocked()) return;
    if (!(await requestModOpDisclaimer())) return;
    installing.value = true;
    try {
      const r = await api.modHubInstall(sourcePath.value.trim(), gameRoot.value, plan.value);
      report.value = {
        name: r.name,
        count: r.wroteFiles,
        version: r.binVersion,
        warnings: r.warnings,
        mirrored: r.mirroredBins ?? [],
      };
      plan.value = null;
      // A local-package install writes ledger rows too — freshness sync.
      await Promise.all([scan(), loadRecords(), pluginUpdates.syncFreshness()]);
    } catch (e) {
      planError.value = e instanceof Error ? e.message : String(e);
    } finally {
      installing.value = false;
    }
  }

  // ── Marketplace filtering: big category → chips → shared query ──

  const catalogInCat = computed(() =>
    listedEntries(catalog.value).filter((m) => catBig(m.category) === bigCat.value),
  );
  const installedInCat = computed(() =>
    installed.value.filter((m) => KIND_BIG[m.kind] === bigCat.value),
  );

  // A chip picked under one big category must not leak an empty list into
  // the next one — reset both sub-filters on the category switch.
  watch(bigCat, () => {
    catalogCats.value = new Set();
    kindFilters.value = new Set();
  });

  /** The non-WoWSP copy of a catalog entry, when a foreign unit paired
   *  against it (and WoWSP itself has no record of installing it). */
  function foreignCopyOf(entry: CatalogEntry): ForeignModUnit | null {
    if (recordOf(entry.id)) return null;
    return foreignUnits.value.find((f) => f.identity === entry.id) ?? null;
  }

  /** Aslain rows are already anchored into the installed list by the
   *  res_mods scan — badge them by name match instead of re-listing. */
  const aslainNames = computed(() => {
    const names = new Set<string>();
    for (const f of foreignUnits.value) {
      if (f.installer === "aslain") names.add(f.name);
    }
    return names;
  });

  /** The catalog entry an installed unit paired against at scan time —
   *  the backend's identity verdict first (name or Aslain-alias match
   *  against the online index), then the legacy foreign-row name match
   *  so pre-identity payloads keep pairing. */
  function pairedEntryOf(unit: InstalledMod): CatalogEntry | null {
    if (unit.identity) {
      const byId = catalog.value.find((e) => e.id === unit.identity);
      if (byId) return byId;
    }
    const hit = foreignUnits.value.find((f) => f.name === unit.name && f.identity);
    if (!hit?.identity) return null;
    return catalog.value.find((e) => e.id === hit.identity) ?? null;
  }

  /** Display name of an installed unit: the paired entry's localized
   *  catalog name once we know which registered mod this copy is (the
   *  raw directory names — `AdvancedTorpedoMarkerPy` and friends — stay
   *  in the sub line), else the raw name. */
  function unitDisplayName(unit: InstalledMod): string {
    const paired = pairedEntryOf(unit);
    return paired ? localized(paired).name || unit.name : unit.name;
  }

  /** The Aslain row backing this unit — manifest-row name match, or the
   *  row that paired to the same catalog identity. */
  function aslainRowOf(unit: InstalledMod): ForeignModUnit | null {
    return (
      foreignUnits.value.find(
        (f) => f.installer === "aslain" && f.name === unit.name,
      ) ??
      (unit.identity
        ? foreignUnits.value.find(
            (f) => f.installer === "aslain" && f.identity === unit.identity,
          ) ?? null
        : null)
    );
  }

  /** Is this unit part of an Aslain install? Rows name-match; leftover
   *  directories (files the modpack wrote but never listed) count once
   *  the install carries any Aslain manifest at all. */
  function isAslainUnit(unit: InstalledMod): boolean {
    return aslainNames.value.has(unit.name) || aslainRowOf(unit) !== null;
  }

  /** The relationship sentence under a paired installed unit: who
   *  installed the files, what the catalog entry is, and what WoWSP
   *  knows about it — the three-way identity story in one line. */
  function pairedRelationOf(unit: InstalledMod, paired: CatalogEntry): string {
    if (recordOf(paired.id)) return t("resources.pairedRelation.managed");
    if (aslainRowOf(unit)) {
      return t("resources.pairedRelation.aslain", {
        source: installerLabel("aslain"),
      });
    }
    if (aslainNames.value.size > 0) {
      return t("resources.pairedRelation.extra", {
        source: installerLabel("aslain"),
      });
    }
    return t("resources.pairedRelation.plain");
  }

  /** ModStation units live in bin/<ver>/mods/ — the res_mods scan never
   *  sees them, so the installed source lists them in their own strip. */
  const modstationUnits = computed(() =>
    foreignUnits.value.filter((f) => f.installer === "modstation"),
  );

  /** Installed material units grouped by what they cover. Rows speak
   *  "which part", the detail pane gathers every pack writing there. */
  const textureComponents = computed<TextureComponent[]>(() => {
    const out: TextureComponent[] = [];
    const byKey = new Map<string, TextureComponent>();
    const push = (key: string, label: string, unit: InstalledMod) => {
      let comp = byKey.get(key);
      if (!comp) {
        comp = { key, label, units: [] };
        byKey.set(key, comp);
        out.push(comp);
      }
      comp.units.push(unit);
    };
    for (const m of installedInCat.value) {
      const analysis = m.textureAnalysis;
      // A pack can cover ship camos AND unrelated spaces at once — both
      // halves stay visible (a part covered only by spaces would vanish
      // under an else-if). No analysis at all → the directory is the
      // part.
      let pushed = false;
      if (analysis?.ships?.length) {
        for (const ship of analysis.ships) {
          push(`ship:${ship}`, ship, m);
          pushed = true;
        }
      }
      if (analysis?.spaceNames?.length) {
        for (const space of analysis.spaceNames) {
          // The ship's own space would double-list under its ship row.
          const shipHit = analysis.ships?.some((ship) =>
            space.toLowerCase().includes(ship.toLowerCase()),
          );
          if (!shipHit) {
            push(`space:${space}`, space, m);
            pushed = true;
          }
        }
      }
      if (!pushed) push(`dir:${m.relPath}`, m.name, m);
    }
    // Most-covered parts first; labels keep it stable within a count.
    out.sort((a, b) => b.units.length - a.units.length || a.label.localeCompare(b.label));
    // The kind chips keep meaning in the component view too: a chip
    // keeps the parts whose packs include that kind (any selected kind
    // qualifies — the chips' union semantics).
    if (kindFilters.value.size > 0) {
      const hits = out.filter((comp) =>
        comp.units.some((u) => kindFilters.value.has(u.kind)),
      );
      out.length = 0;
      out.push(...hits);
    }
    return out;
  });

  /** The scheme the pane shows as active: the explicit choice, else the
   *  first preset (the default scheme). */
  function activePreset(entry: CatalogEntry): string {
    const list = entry.presets ?? [];
    return list.some((p) => p.id === selectedPreset.value)
      ? selectedPreset.value
      : (list[0]?.id ?? "");
  }

  const modMatches = (m: InstalledMod, q: string) =>
    m.name.toLowerCase().includes(q) ||
    m.relPath.toLowerCase().includes(q) ||
    unitDisplayName(m).toLowerCase().includes(q);

  const kindCounts = computed(() => {
    const map = new Map<ModKind, number>();
    for (const m of installedInCat.value) map.set(m.kind, (map.get(m.kind) ?? 0) + 1);
    return map;
  });

  const catCounts = computed(() => {
    const map = new Map<string, number>();
    for (const m of catalogInCat.value) map.set(m.category, (map.get(m.category) ?? 0) + 1);
    return map;
  });

  const catalogShown = computed(() =>
    catalogInCat.value.filter(
      (m) =>
        catalogCats.value.size === 0 ||
        (isCatalogCat(m.category) && catalogCats.value.has(m.category)),
    ),
  );

  const shown = computed(() =>
    installedInCat.value.filter(
      (m) => kindFilters.value.size === 0 || kindFilters.value.has(m.kind),
    ),
  );

  /** Chip toggles: reassign a fresh Set so the reactive swap is plain. */
  function toggleCatalogCat(c: CatalogCat) {
    const next = new Set(catalogCats.value);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    catalogCats.value = next;
  }

  function toggleKindFilter(k: ModKind) {
    const next = new Set(kindFilters.value);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    kindFilters.value = next;
  }

  // ── Row → pane selection (the master/detail pair) ──
  // Every real selection replaces the delisted notice (it only exists to
  // answer a deep link until the user picks something).

  function selectCatalog(entry: CatalogEntry) {
    delistedHit.value = null;
    selectedPreset.value = "";
    source.value = "online";
    selection.value = { mode: "catalog", entry };
  }

  function selectInstalled(mod: InstalledMod) {
    delistedHit.value = null;
    selectedPreset.value = "";
    source.value = "installed";
    selection.value = { mode: "installed", mod };
  }

  function selectForeign(unit: ForeignModUnit) {
    delistedHit.value = null;
    selectedPreset.value = "";
    source.value = "installed";
    selection.value = { mode: "foreign", unit };
  }

  function selectComponent(comp: TextureComponent) {
    delistedHit.value = null;
    selectedPreset.value = "";
    source.value = "installed";
    selection.value = { mode: "component", comp };
  }

  function openLocal() {
    delistedHit.value = null;
    selectedPreset.value = "";
    selection.value = { mode: "local" };
  }

  /** Source switch: the list underneath is about to be a different dataset,
   *  so a selection that belongs to the other one is dropped (picking a
   *  combo hit re-selects right after, in the same tick). The folder flow
   *  is source-independent and survives. */
  function pickSource(next: "online" | "installed") {
    if (next === source.value) return;
    source.value = next;
    delistedHit.value = null;
    selectedPreset.value = "";
    const mode = selection.value?.mode;
    if (
      mode === "catalog" ||
      mode === "installed" ||
      mode === "foreign" ||
      mode === "component"
    ) {
      selection.value = null;
    }
  }

  const selectedRowKey = computed(() => {
    const sel = selection.value;
    if (sel?.mode === "catalog") return sel.entry.id;
    if (sel?.mode === "installed") return sel.mod.relPath;
    return "";
  });

  // ── Trailing search combo: jump straight into a mod ──
  // Scoped to the ACTIVE source — a popup that kept returning catalog hits
  // while the installed list is on screen would be a different list than
  // the one behind it. The combo is re-keyed on source change (see the
  // render below) so a swap drops the previous source's candidates instead
  // of re-rendering them through the other branch's row renderer.

  async function comboSearch(query: string): Promise<unknown[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return source.value === "online"
      ? listedEntries(catalog.value).filter((m) => entryMatches(m, q)).slice(0, 12)
      : installed.value.filter((m) => modMatches(m, q)).slice(0, 12);
  }

  function comboSelect(raw: unknown) {
    if (source.value === "installed") selectInstalled(raw as InstalledMod);
    else selectCatalog(raw as CatalogEntry);
  }

  // ── Row 3 refresh: source decides what "refresh" means ──

  function refresh() {
    if (source.value === "online") void loadCatalog(true);
    else void scan();
  }

  const refreshSpinning = computed(() =>
    source.value === "online" ? catalogLoading.value : scanning.value,
  );
  // The online catalog works without a game install; rescanning installed
  // mods needs the res_mods root, hence the asymmetric disable.
  const refreshDisabled = computed(() => source.value === "installed" && !gameRoot.value);

  /** All installed rows, confirmations and migration plans belong to the
   *  selected install — the view's gameRoot watch calls this to
   *  invalidate them synchronously, so an old row can never invoke an
   *  action against the newly selected root, even mid-scan. */
  function invalidateRoot() {
    scanGeneration++;
    scanning.value = false;
    installed.value = [];
    foreignUnits.value = [];
    staleBins.value = [];
    loaderStatus.value = null;
    safeMode.value = false;
    selection.value = null;
    selectedPreset.value = "";
    confirmTarget.value = null;
    unitTarget.value = null;
    foreignTarget.value = null;
    safeModeAsk.value = null;
  }

  onMounted(() => {
    scan();
    loadCatalog(false);
    loadRecords();
    void api.modTags()
      .then((idx) => {
        const m = new Map<string, CatalogTag>();
        for (const t of idx.tags) m.set(t.id, t);
        tagTable.value = m;
      })
      .catch(() => {});
  });

  return {
    // shared refs
    source,
    selectedPreset,
    bigCat,
    catalogCats,
    kindFilters,
    selection,
    installed,
    foreignUnits,
    scanning,
    sourcePath,
    analyzing,
    plan,
    planError,
    installing,
    report,
    catalog,
    tagTable,
    catalogSource,
    catalogFetched,
    catalogLoading,
    catalogError,
    records,
    progresses,
    confirmTarget,
    unitBusy,
    unitTarget,
    foreignTarget,
    staleBins,
    loaderStatus,
    restoringLoader,
    safeMode,
    safeModeAsk,
    safeModeBusy,
    toolsOpen,
    toolsAnchor,
    delistedHit,
    busy,
    gameRoot,
    pluginUpdates,
    // catalog / installed projections
    catalogInCat,
    installedInCat,
    aslainNames,
    modstationUnits,
    textureComponents,
    kindCounts,
    catCounts,
    catalogShown,
    shown,
    selectedRowKey,
    refreshSpinning,
    refreshDisabled,
    // actions
    bindMigrateWizard,
    gameRunning,
    loadCatalog,
    loadRecords,
    recordOf,
    unitKey,
    installMod,
    uninstallMod,
    toggleUnit,
    uninstallUnit,
    uninstallModstation,
    scan,
    safeModeBlocked,
    doSafeMode,
    analyze,
    restoreLoaderMarker,
    confirmInstall,
    foreignCopyOf,
    pairedEntryOf,
    unitDisplayName,
    isAslainUnit,
    pairedRelationOf,
    activePreset,
    modMatches,
    toggleCatalogCat,
    toggleKindFilter,
    selectCatalog,
    selectInstalled,
    selectForeign,
    selectComponent,
    openLocal,
    pickSource,
    comboSearch,
    comboSelect,
    refresh,
    invalidateRoot,
  };
}

export type ModHubCtx = ReturnType<typeof useModHub>;
