import { computed, defineComponent, onMounted, onUnmounted, ref, watch } from "vue";
import {
  AlertTriangle,
  AudioLines,
  Ban,
  ChevronDown,
  Ellipsis,
  ExternalLink,
  FolderSearch,
  ImageIcon,
  MousePointerClick,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Undo2,
} from "@lucide/vue";

import {
  HkButton,
  HkCheckbox,
  HkConfirmDialog,
  HkIconButton,
  HkModal,
  HkSpinner,
  HkSwitch,
  HkTabs,
  HMenu,
  useToast,
} from "@celestia-island/hikari";

import AsyncSearchCombo from "@/components/search/AsyncSearchCombo";
import {
  api,
  type CatalogEntry,
  type CatalogPreset,
  type ForeignModUnit,
  type CatalogTag,
  type CatalogProgress,
  type InstalledMod,
  type MigrationPlan,
  type MigrateReport,
  type ModInstallRecord,
  type ModKind,
  type PackagePlan,
  type PlanFile,
  type StaleBinInfo,
  type TextureAnalysis,
} from "@/api";
import {
  CATALOG_CATS,
  KIND_BIG,
  KIND_META,
  KIND_ORDER,
  catBig,
  catIcon,
  isCatalogCat,
  type BigCat,
  type CatalogCat,
} from "@/features/modhub/taxonomy";
import { listedEntries } from "@/features/modhub/catalogListed";
import AssetPreview from "@/features/modhub/AssetPreview";
import { resolveIdentity } from "@/features/modhub/migrateIdentity";
import {
  ignoreAll,
  ignoreFile,
  keptPending,
  masterChecked,
  restoreAll,
  restoreFile,
  selectAll,
  type DecideSelection,
} from "@/features/modhub/migrationDecide";
import { useRoute } from "vue-router";
import { openExternal } from "@/utils/openExternal";
import { sameGamePath } from "@/utils/gamePath";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { usePluginUpdatesStore } from "@/stores/pluginUpdates";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import "./ResourcesView.scss";

/** Right-hand pane content: the selected catalog entry, the selected
 *  installed unit, or the folder-install flow (which has no list row of its
 *  own — it is opened from the list's action row). */
type Selection =
  | { mode: "catalog"; entry: CatalogEntry }
  | { mode: "installed"; mod: InstalledMod }
  | { mode: "foreign"; unit: ForeignModUnit }
  | { mode: "component"; comp: TextureComponent }
  | { mode: "local" };

/** One covered game part under the material category — the unit the list
 *  speaks in there is WHAT is overridden (a ship, a space, a folder),
 *  not which mod dropped the files (several packs can fight over the
 *  same part; only one version ever wins). */
interface TextureComponent {
  /** `ship:<name> | space:<name> | dir:<name>` — stable row key. */
  key: string;
  label: string;
  units: InstalledMod[];
}

const REPO = "langyo/wowsp";

/**
 * Mod Hub (Resources page) — master/detail in the replay page's
 * secondary-sidebar shape.
 *
 * The flush left sidebar owns the title row (with the ⋯ tool menu), the
 * condition strips, the count pill and the whole filter stack (big category,
 * source + tool row, chips) above the scrolling row list; the right pane
 * shows what the selected row is and carries every action for it — nothing is
 * hidden behind a modal, and the pane keeps a placeholder until something is
 * picked.
 *
 * Online catalog: curated tool-type mods from `mod-index.json` (built from
 * GitHub Discussions by scripts/mod_hub_publish.py); install downloads the
 * release asset, verifies SHA-256 and unpacks through the same pipeline as
 * local installs. Installed: scan of the latest `bin/<version>/res_mods/`.
 */
export default defineComponent({
  name: "ResourcesView",
  setup() {
    const config = useConfigStore();
    const toast = useToast();
    const route = useRoute();
    const { uiLocale, dataLanguage } = useLanguage();

    const source = ref<"online" | "installed">("online");
    // Chosen scheme of the catalog entry on the pane — "" = the entry's
    // default package list. Reset on every pane change (rows, folder flow,
    // delisted notice) so a stale choice never leaks across entries.
    const selectedPreset = ref("");
    const bigCat = ref<BigCat>("function");
    const catalogFilter = ref<"all" | CatalogCat>("all");
    const filter = ref<"all" | ModKind>("all");
    const selection = ref<Selection | null>(null);

    const installed = ref<InstalledMod[]>([]);
    const foreignUnits = ref<ForeignModUnit[]>([]);
    const scanning = ref(false);

    const sourcePath = ref("");
    const analyzing = ref(false);
    const plan = ref<PackagePlan | null>(null);
    const planError = ref("");
    const installing = ref(false);
    const report = ref<
      { name: string; count: number; version: string; warnings: string[] } | null
    >(null);

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
    // Per-mod busy/progress maps (Vue instruments collection mutations,
    // so `.set`/`.delete` re-render). Only the mods currently being
    // processed appear here — every other row stays fully clickable while
    // one download runs, and parallel installs each track their own state.
    const busy = ref(new Map<string, "install" | "uninstall">());
    const progresses = ref(new Map<string, CatalogProgress>());
    const confirmTarget = ref<CatalogEntry | null>(null);

    // Installed-unit actions: relPath → "toggle" | "uninstall".
    const unitBusy = ref(new Map<string, "toggle" | "uninstall">());
    const unitTarget = ref<InstalledMod | null>(null);

    // Stale-bin migration: older `bin/<version>/res_mods` leftovers the
    // game stopped loading after an update — surfaced so they can be moved
    // into the current version instead of lingering as dead weight.
    const staleBins = ref<StaleBinInfo[]>([]);
    // `migrating` means "the wizard's execute step is in flight"; the ⋯ menu
    // entry and the stale banner button both disable on it.
    const migrating = ref(false);

    // ── Migration wizard state (plan → review → executing → done) ──
    const migrateWizardOpen = ref(false);
    const migFrom = ref("");
    const migStep = ref<"confirm" | "plan" | "review" | "executing" | "done">(
      "confirm",
    );
    const migPlan = ref<MigrationPlan | null>(null);
    const migError = ref("");
    // Decide-bucket verdicts: `keep` moves the file into the current bin,
    // `ignore` leaves it untouched in the stale one, neither deletes it.
    // The sets are disjoint (ignore wins); default is keep-all.
    const migDecide = ref<DecideSelection>({ keep: new Set(), ignore: new Set() });
    const migReport = ref<MigrateReport | null>(null);
    // Which auto-cleaned / reviewed group is expanded (duplicates /
    // superseded / ignored).
    const migGroupOpen = ref<"duplicate" | "superseded" | "ignored" | null>(null);

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
    // The install every mod operation targets: the user's selection, with
    // the RUNNING client's folder as the fallback (same order the ship
    // detail uses) so the page keeps working when no selection is present.
    const gameRoot = computed(
      () => config.activeInstall?.path ?? gameStatus.process.matchedInstall?.path ?? "",
    );

    /** Mutating res_mods while THAT client is running tears half-loaded
     *  mods — the backend rejects it root-scoped; this pre-check mirrors
     *  the same rule (a different client running elsewhere must not block
     *  work on the selected install) and gives the localized message.
     *  When the running process's folder is unknown, stay conservative and
     *  block (the old blanket behavior). */
    function gameRunning(): boolean {
      const runningRoot = gameStatus.process.matchedInstall?.path;
      const targetsRunningClient =
        gameStatus.process.running &&
        (runningRoot === undefined || sameGamePath(gameRoot.value, runningRoot));
      if (targetsRunningClient) {
        toast.error(t("resources.gameRunningBlock"));
        return true;
      }
      return false;
    }

    let unlisten: (() => void) | undefined;
    onMounted(() => {
      api
        .listenCatalogProgress?.((p) => {
          if (p.phase === "done") {
            progresses.value.delete(p.id);
          } else {
            progresses.value.set(p.id, p);
          }
        })
        ?.then((un) => (unlisten = un));
    });
    onUnmounted(() => unlisten?.());

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
      catalogFilter.value = "all";
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
      busy.value.set(entry.id, "install");
      try {
        const r = await api.modCatalogInstall(entry.id, gameRoot.value, preset);
        toast.success(t("resources.installedDone", { name: r.name, version: entry.version }));
        for (const c of r.conflicts ?? []) toast.info(c);
        await Promise.all([scan(), loadRecords(), pluginUpdates.refresh()]);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        busy.value.delete(entry.id);
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
      busy.value.set(entry.id, "uninstall");
      try {
        const r = await api.modCatalogUninstall(entry.id, gameRoot.value);
        toast.success(
          t("resources.uninstalledDone", {
            name: r.name,
            removed: r.removedFiles,
            restored: r.restoredFiles > 0 ? t("resources.restoredPart", { count: r.restoredFiles }) : "",
          }),
        );
        await Promise.all([scan(), loadRecords(), pluginUpdates.refresh()]);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        busy.value.delete(entry.id);
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
        await Promise.all([scan(), loadRecords()]);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        unitBusy.value.delete(unitKey(mod));
      }
    }

    async function scan() {
      if (!gameRoot.value || scanning.value) return;
      scanning.value = true;
      try {
        installed.value = await api.modHubScanInstalled(gameRoot.value);
        foreignUnits.value = await api.modHubForeignUnits(gameRoot.value).catch((e) => {
          console.warn("foreign-unit detection failed", e);
          return [];
        });
        staleBins.value = await api.modHubStaleVersions(gameRoot.value).catch((e) => {
          console.warn("stale-bin detection failed", e);
          return [];
        });
        safeMode.value = await api.modHubSafeMode(gameRoot.value).catch(() => false);
        // Reconcile ghost ledger records (files gone from disk) and orphaned
        // snapshot dirs; refresh the records list when something dropped.
        const rec = await api.modHubReconcile(gameRoot.value).catch(() => null);
        if (rec && rec.droppedRecords > 0) {
          records.value = await api.modHubRecords().catch(() => []);
          toast.info(t("resources.reconciled", { n: rec.droppedRecords }));
        }
      } finally {
        scanning.value = false;
      }
    }

    // ── Stale-bin migration wizard ─────────────────────────────────────────
    // plan (backend classifies the stale tree) → review (user checks which
    // stale-only files survive) → executing → done. Duplicates and files the
    // current tree superseded never reach the review list: they are cleaned
    // up automatically, the newer install always wins.

    /** Human size for a plan row (KB granularity, like the package list). */
    const migKb = (size: number) =>
      size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;

    /** Display name for a plan row: catalog/alias identity when the path
     *  maps to one, else null (the row then shows the raw path only). */
    const migIdentity = (f: PlanFile): string | null =>
      resolveIdentity(f.path, catalog.value, (e) => localized(e).name || e.nameEn || e.title);

    /** Decide-bucket paths in plan order — the input every selection
     *  helper (master checkbox, ignore-all) sweeps over. */
    const decidePaths = (): string[] => migPlan.value?.decide.map((f) => f.path) ?? [];

    /** Nothing left to decide — every decide file is ignored (or the list
     *  is empty): the master checkbox and ignore-all both stand down. */
    const decideAllIgnored = computed(
      () => !decidePaths().some((p) => !migDecide.value.ignore.has(p)),
    );

    async function loadMigPlan() {
      if (!gameRoot.value || !migFrom.value) return;
      migStep.value = "plan";
      migError.value = "";
      migPlan.value = null;
      migReport.value = null;
      migGroupOpen.value = null;
      try {
        const p = await api.modHubMigrationPlan(gameRoot.value, migFrom.value);
        migPlan.value = p;
        migDecide.value = { keep: new Set(p.decide.map((f) => f.path)), ignore: new Set() };
        migStep.value = "review";
      } catch (e) {
        migError.value = e instanceof Error ? e.message : String(e);
      }
    }

    /** Entry points: the ⋯ menu item and the stale banner button. Re-checks
     *  the same guards the mutations run (localized messages included) and
     *  defaults to the freshest stale bin. Landing on the confirm step is
     *  deliberate: planning hashes every stranded file, a heavy disk sweep
     *  the owner asked to gate behind an explicit start click. */
    function openMigrateWizard() {
      if (!gameRoot.value || staleBins.value.length === 0 || migrating.value) return;
      if (gameRunning() || safeModeBlocked()) return;
      if (!migFrom.value || !staleBins.value.some((b) => b.binVersion === migFrom.value)) {
        migFrom.value = staleBins.value[0]?.binVersion ?? "";
      }
      migrateWizardOpen.value = true;
      migStep.value = "confirm";
      migError.value = "";
    }

    /** Switch the wizard's source bin (only shown with >1 stale bins) —
     *  back to confirm; the plan is rebuilt only on an explicit start. */
    function pickMigFrom(v: string) {
      if (v === migFrom.value || migrating.value) return;
      migFrom.value = v;
      migStep.value = "confirm";
      migPlan.value = null;
    }

    /** Row checkbox: flips one file between keep (migrate) and drop
     *  (delete). The ignore verdict has its own actions below. */
    function toggleMigKeep(path: string, keep: boolean) {
      const next = new Set(migDecide.value.keep);
      if (keep) next.add(path);
      else next.delete(path);
      migDecide.value = { ...migDecide.value, keep: next };
    }

    /** Master checkbox over the decide list: one click selects (or clears)
     *  every still-pending file; ignored files are never touched. */
    function toggleMigKeepAll(keepAll: boolean) {
      migDecide.value = selectAll(migDecide.value, decidePaths(), keepAll);
    }

    function ignoreMigPath(path: string) {
      migDecide.value = ignoreFile(migDecide.value, path);
    }

    function restoreMigPath(path: string) {
      migDecide.value = restoreFile(migDecide.value, path);
    }

    function ignoreMigAll() {
      migDecide.value = ignoreAll(migDecide.value, decidePaths());
    }

    function restoreMigAll() {
      migDecide.value = restoreAll(migDecide.value);
    }

    function closeMigrate() {
      migrateWizardOpen.value = false;
      migStep.value = "confirm";
      migPlan.value = null;
      migError.value = "";
      migDecide.value = { keep: new Set(), ignore: new Set() };
      migReport.value = null;
      migGroupOpen.value = null;
    }

    async function startMigrate() {
      if (!gameRoot.value || !migPlan.value || migrating.value) return;
      if (gameRunning() || safeModeBlocked()) return;
      migrating.value = true;
      migStep.value = "executing";
      migError.value = "";
      try {
        const r = await api.modHubMigrationExecute(
          gameRoot.value,
          migFrom.value,
          [...migDecide.value.keep],
          [...migDecide.value.ignore],
        );
        migReport.value = r;
        migStep.value = "done";
        await Promise.all([scan(), loadRecords()]);
      } catch (e) {
        migError.value = e instanceof Error ? e.message : String(e);
        // Back to review so the plan stays visible instead of dead-ending
        // the wizard on a failed execute.
        migStep.value = "review";
      } finally {
        migrating.value = false;
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

    async function confirmInstall() {
      if (!plan.value || installing.value || gameRunning() || safeModeBlocked()) return;
      installing.value = true;
      try {
        const r = await api.modHubInstall(sourcePath.value.trim(), gameRoot.value, plan.value);
        report.value = {
          name: r.name,
          count: r.wroteFiles,
          version: r.binVersion,
          warnings: r.warnings,
        };
        plan.value = null;
        await Promise.all([scan(), loadRecords()]);
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
      catalogFilter.value = "all";
      filter.value = "all";
    });

    /** Big category of an installed unit's kind (preview routing). */
    function bigOfKind(kind: string): string {
        return (KIND_BIG as Record<string, string>)[kind] ?? "function";
    }

    /** Installer display name for badges/notes. */
    function installerLabel(installer: string): string {
      if (installer === "aslain") return t("resources.foreignSource.aslain");
      if (installer === "modstation") return t("resources.foreignSource.modstation");
      return installer;
    }

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
      // keeps the parts whose packs include that kind.
      if (filter.value !== "all") {
        const kind = filter.value;
        const hits = out.filter((comp) => comp.units.some((u) => u.kind === kind));
        out.length = 0;
        out.push(...hits);
      }
      return out;
    });

    /** The catalog entry a foreign unit paired to an installed unit's
     *  name — "which registered material pack is this" (wowsp.toml's
     *  identity), shown only when a pairing exists. */
    function pairedEntryOf(unit: InstalledMod): CatalogEntry | null {
      const hit = foreignUnits.value.find((f) => f.name === unit.name && f.identity);
      if (!hit?.identity) return null;
      return catalog.value.find((e) => e.id === hit.identity) ?? null;
    }

    /** A tag's localized label: exact locale, then the zh / en pair the
     *  registry guarantees, then the raw id (registry lag). */
    function tagLabel(tag: CatalogTag): string {
      const i18n = tag.i18n ?? {};
      return (
        i18n[uiLocale.value] ??
        (uiLocale.value.toLowerCase().startsWith("zh")
          ? (i18n["zh-CN"] ?? i18n["en-US"])
          : (i18n["en-US"] ?? i18n["zh-CN"])) ??
        tag.id
      );
    }

    /** A preset's label: zh locales take the Chinese name, everything
     *  else the English one (presets carry just the two). */
    function presetLabel(p: CatalogPreset): string {
      return uiLocale.value.toLowerCase().startsWith("zh")
        ? p.nameZh || p.nameEn
        : p.nameEn || p.nameZh;
    }

    /** The scheme the pane shows as active: the explicit choice, else the
     *  first preset (the default scheme). */
    function activePreset(entry: CatalogEntry): string {
      const list = entry.presets ?? [];
      return list.some((p) => p.id === selectedPreset.value)
        ? selectedPreset.value
        : (list[0]?.id ?? "");
    }

    /** Localized name/description from the thread's wowsp:i18n block:
     *  UI locale first, then the game-data language, then en-US. Matching
     *  falls back to the language subtag so `zh-SG` still finds `zh-CN`. */
    function localized(entry: CatalogEntry): { name: string; desc: string } {
      const table = entry.i18n ?? {};
      const wanted = [uiLocale.value, dataLanguage.value, "en-US"];
      for (const lang of wanted) {
        const text = table[lang];
        if (text?.name || text?.description) {
          return { name: text.name, desc: text.description };
        }
      }
      for (const lang of wanted) {
        const base = lang.split("-")[0]?.toLowerCase();
        const key = base && Object.keys(table).find((k) => k.split("-")[0].toLowerCase() === base);
        const text = key ? table[key] : undefined;
        if (text?.name || text?.description) {
          return { name: text.name, desc: text.description };
        }
      }
      return { name: entry.nameZh || entry.nameEn, desc: entry.description };
    }

    /** Query match for online entries: identity, published names and every
     *  localized variant (a user types what their UI language shows). */
    function entryMatches(entry: CatalogEntry, q: string): boolean {
      if (
        entry.id.includes(q) ||
        entry.nameEn.toLowerCase().includes(q) ||
        entry.nameZh.toLowerCase().includes(q) ||
        entry.title.toLowerCase().includes(q)
      ) {
        return true;
      }
      const text = localized(entry);
      if (text.name.toLowerCase().includes(q) || text.desc.toLowerCase().includes(q)) return true;
      return Object.values(entry.i18n ?? {}).some(
        (v) =>
          v.name?.toLowerCase().includes(q) || v.description?.toLowerCase().includes(q) || false,
      );
    }

    const modMatches = (m: InstalledMod, q: string) =>
      m.name.toLowerCase().includes(q) || m.relPath.toLowerCase().includes(q);

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
        (m) => catalogFilter.value === "all" || m.category === catalogFilter.value,
      ),
    );

    const shown = computed(() =>
      installedInCat.value.filter((m) => filter.value === "all" || m.kind === filter.value),
    );

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

    function comboRenderItem(raw: unknown) {
      if (source.value === "installed") {
        const mod = raw as InstalledMod;
        const meta = KIND_META[mod.kind];
        const Icon = meta.icon;
        return (
          <>
            <span class={["mod-row__tile", `mod-row__tile--${meta.class}`, "mod-row__tile--sm"]}>
              <Icon size={14} />
            </span>
            <span class="resources-view__combo-name">{mod.name}</span>
            {mod.version && <span class="resources-view__combo-ver">{mod.version}</span>}
          </>
        );
      }
      const entry = raw as CatalogEntry;
      const Icon = catIcon(entry.category);
      const text = localized(entry);
      return (
        <>
          <span class="mod-row__tile mod-row__tile--cat mod-row__tile--sm">
            <Icon size={14} />
          </span>
          <span class="resources-view__combo-name">{text.name || entry.title || entry.nameEn}</span>
        </>
      );
    }

    function comboSelect(raw: unknown) {
      if (source.value === "installed") selectInstalled(raw as InstalledMod);
      else selectCatalog(raw as CatalogEntry);
    }

    /** Empty-state text node — the list is a flex column of rows, so a bare
     *  string would render flush and full-contrast instead of reading as a
     *  placeholder. */
    const emptyNote = (text: string) => <div class="resources-view__empty">{text}</div>;

    /** What an empty online list means depends on WHY it is empty: mid-fetch
     *  is not the same as "nothing matched", and a failed fetch is already
     *  talking through the error banner above the list. */
    const catalogEmptyNote = () => {
      if (catalogLoading.value) return emptyNote(t("resources.refreshing"));
      if (catalogError.value) return null;
      const listed = listedEntries(catalog.value);
      return emptyNote(
        listed.length === 0 ? t("resources.catalogEmpty") : t("resources.empty"),
      );
    };

    const installedEmptyNote = () =>
      emptyNote(scanning.value ? t("resources.scanning") : t("resources.empty"));

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

    const catalogKb = (entry: CatalogEntry) =>
      entry.packages.reduce((sum, p) => sum + p.size, 0) > 0
        ? Math.max(1, Math.round(entry.packages.reduce((s, p) => s + p.size, 0) / 1024))
        : 0;

    const pkgKb = (size: number) => Math.max(1, Math.round(size / 1024));

    const discussionUrl = (n?: number | null) =>
      n ? `https://github.com/${REPO}/discussions/${n}` : "";

    function kindLabel(kind: ModKind): string {
      return t(`resources.kind.${kind}`);
    }

    /** Localized label for a texture-analysis code; falls back to the raw
     *  code when the locale has no entry (unknown nations, exotic dirs). */
    function texLabel(group: "cat" | "nation" | "species", code: string): string {
      const key = `resources.tex.${group}.${code}`;
      const label = t(key);
      return label === key ? code : label;
    }

    /** Compact breakdown of a texture-override tree — category / nation /
     *  species tags, the covered ship units, file-kind counts. Shared by the
     *  installed pane and the install plan card. */
    function renderTexAnalysis(a: TextureAnalysis) {
      const tags = [
        ...a.categories.map((c) => ({
          key: `cat-${c}`,
          text: texLabel("cat", c),
          cls: "tex-tag--cat",
        })),
        ...a.nations.map((n) => ({ key: `nat-${n}`, text: texLabel("nation", n), cls: "" })),
        ...a.species.map((s) => ({ key: `spc-${s}`, text: texLabel("species", s), cls: "" })),
        ...a.spaceNames.slice(0, 2).map((s) => ({ key: `space-${s}`, text: s, cls: "" })),
      ];
      const shownShips = a.ships.slice(0, 4);
      const meta = [
        t(a.truncated ? "resources.tex.filesOver" : "resources.tex.files", {
          count: a.fileCount,
        }),
        ...a.fileKinds.slice(0, 4).map((k) => `${k.ext} ${k.count}`),
      ].join(" · ");
      return (
        <div class="tex-analysis">
          {tags.length > 0 && (
            <div class="tex-analysis__tags">
              {tags.map((tag) => (
                <span key={tag.key} class={["tex-tag", tag.cls]}>
                  {tag.text}
                </span>
              ))}
            </div>
          )}
          {shownShips.length > 0 && (
            <div class="tex-analysis__ships" title={a.ships.join("\n")}>
              {shownShips.map((s) => (
                <span key={s} class="tex-ship">
                  {s}
                </span>
              ))}
              {a.ships.length > shownShips.length && (
                <span class="tex-ship tex-ship--more">
                  {t("resources.tex.moreShips", { count: a.ships.length - shownShips.length })}
                </span>
              )}
            </div>
          )}
          <div class="tex-analysis__meta">{meta}</div>
        </div>
      );
    }

    // The config store hydrates the active install asynchronously — rescan
    // once the game root shows up (the mount-time scan is a no-op before it).
    watch(gameRoot, (root) => {
      if (root && installed.value.length === 0) scan();
    });

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

    // ── Detail pane (one branch per mode; the switch narrows the union) ──
    // Every mode renders head / scrolling body / footer, so the action row
    // stays pinned to the pane's bottom-right while long content scrolls.

    function renderCatalogDetail(entry: CatalogEntry) {
      const text = localized(entry);
      const record = recordOf(entry.id);
      const foreignCopy = foreignCopyOf(entry);
      const upToDate = !!record && record.version === entry.version;
      const busyState = busy.value.get(entry.id);
      const busyInstall = busyState === "install";
      const busyUninstall = busyState === "uninstall";
      const progressEntry = progresses.value.get(entry.id);
      const url = discussionUrl(entry.discussion);
      const kb = catalogKb(entry);
      const CatIcon = catIcon(entry.category);
      return (
        <div class="mod-detail">
          <div class="mod-detail__head">
            <span class="mod-row__tile mod-row__tile--cat mod-row__tile--lg">
              <CatIcon size={24} />
            </span>
            <div class="mod-detail__id">
              <div class="mod-detail__name">{text.name || entry.title || entry.nameEn}</div>
              <div class="mod-detail__en">{entry.nameEn}</div>
            </div>
          </div>
          <div class="mod-detail__scroll">
            {foreignCopy && (
              <div class="mod-detail__foreign-copy">
                {t("resources.foreignCopy", {
                  source: installerLabel(foreignCopy.installer),
                })}
              </div>
            )}
            <div class="mod-detail__badges">
              {isCatalogCat(entry.category) && (
                <span class="mod-detail__badge">{t(`resources.cat.${entry.category}`)}</span>
              )}
              {record && !upToDate && (
                <span class="mod-detail__badge mod-detail__badge--warn">
                  {t("resources.installedAt", { version: record.version })}
                </span>
              )}
              {upToDate && (
                <span class="mod-detail__badge mod-detail__badge--ok">
                  {t("resources.installedBadge")}
                </span>
              )}
              {(entry.tags ?? []).map((id) => {
                const tag = tagTable.value.get(id);
                return (
                  <span
                    key={id}
                    class={[
                      "mod-detail__tag",
                      tag?.kind === "ip" ? "mod-detail__tag--ip" : "",
                      id === "ai-generated" ? "mod-detail__tag--ai" : "",
                    ]}
                  >
                    {tag ? tagLabel(tag) : id}
                  </span>
                );
              })}
            </div>
            {entry.presets && entry.presets.length > 0 && (
              <div class="mod-detail__presets">
                <span class="mod-detail__presets-label">{t("resources.presetLabel")}</span>
                <HkTabs
                  variant="segmented"
                  block
                  modelValue={activePreset(entry)}
                  onUpdate:modelValue={(v: string) => (selectedPreset.value = v)}
                  tabs={(entry.presets ?? []).map((p) => ({
                    key: p.id,
                    label: presetLabel(p),
                  }))}
                  renderPanels={false}
                />
              </div>
            )}
            {(text.desc || entry.description) && (
              <p class="mod-detail__desc">{text.desc || entry.description}</p>
            )}
            <div class="mod-detail__meta">
              <span>{t("resources.gameRange", { game: entry.game })}</span>
              {kb > 0 && (
                <span>{t("resources.pkgCount", { count: entry.packages.length, kb })}</span>
              )}
            </div>
            {entry.packages.length > 0 && (
              <ul class="mod-detail__pkgs">
                {entry.packages.map((p) => (
                  <li key={p.url}>
                    <span class="mod-detail__pkgname">{p.name}</span>
                    {p.size > 0 && <span class="mod-detail__pkgsize">{pkgKb(p.size)} KB</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div class="mod-detail__foot">
            {busyInstall && progressEntry && (
              <div class="mod-detail__progress">
                <div
                  class="mod-detail__progress-bar"
                  style={{
                    width: `${Math.min(
                      100,
                      progressEntry.total > 0
                        ? (progressEntry.received / progressEntry.total) * 100
                        : 12,
                    )}%`,
                  }}
                />
              </div>
            )}
            <div class="mod-detail__foot-row">
              {url && (
                <button
                  class="mod-detail__link"
                  data-hint={t("resources.openDiscussion")}
                  onClick={() => openExternal(url)}
                >
                  <ExternalLink size={13} />
                  {t("resources.discuss")}
                </button>
              )}
              <div class="mod-detail__actions">
                {record && (
                  <button
                    class="mod-detail__danger"
                    disabled={!!busyState}
                    onClick={() => (confirmTarget.value = entry)}
                  >
                    <Trash2 size={13} />
                    {busyUninstall ? t("resources.uninstalling") : t("resources.uninstall")}
                  </button>
                )}
                {!upToDate && !entry.bundled && (
                  <HkButton
                    size="sm"
                    variant="primary"
                    disabled={!!busyState || !gameRoot.value}
                    loading={busyInstall}
                    onClick={() =>
                      installMod(
                        entry,
                        entry.presets?.length
                          ? selectedPreset.value || entry.presets[0].id
                          : undefined,
                      )
                    }
                  >
                    {busyInstall
                      ? t("resources.installingMod")
                      : record
                        ? t("resources.update")
                        : foreignCopy
                          ? t("resources.reinstall")
                          : t("resources.install")}
                  </HkButton>
                )}
                {entry.bundled && (
                  <span class="mod-detail__bundled">{t("resources.bundledWithApp")}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      );
    }

    function renderInstalledDetail(mod: InstalledMod) {
      const meta = KIND_META[mod.kind];
      const Icon = meta.icon;
      const state = unitBusy.value.get(mod.relPath);
      return (
        <div class="mod-detail">
          <div class="mod-detail__head">
            <span class={["mod-row__tile", `mod-row__tile--${meta.class}`, "mod-row__tile--lg"]}>
              <Icon size={24} />
            </span>
            <div class="mod-detail__id">
              <div class="mod-detail__name">
                {mod.name}
                {mod.version && <span class="mod-row__ver">{mod.version}</span>}
              </div>
              <div class="mod-detail__en">{kindLabel(mod.kind)}</div>
            </div>
          </div>
          <div class="mod-detail__scroll">
            {mod.disabled && (
              <div class="mod-detail__badges">
                <span class="mod-detail__badge mod-detail__badge--warn">
                  {t("resources.disabled")}
                </span>
              </div>
            )}
            {(mod.warnings ?? []).length > 0 && (
              <ul class="plan-card__warnings">
                {(mod.warnings ?? []).map((w, i) => (
                  <li key={`${i}-${w}`}>
                    <AlertTriangle size={12} /> {w}
                  </li>
                ))}
              </ul>
            )}
            {mod.textureAnalysis && renderTexAnalysis(mod.textureAnalysis)}
            {/* The material section: one preview area per unit — texture
                thumbnails above, custom-model meshes (incl. the 3D stage)
                below, from a single asset listing. */}
            {bigOfKind(mod.kind) === "texture" && (
              <AssetPreview gameRoot={gameRoot.value} relPath={mod.relPath} mode="texture" />
            )}
            {mod.kind === "voice" && (
              <AssetPreview gameRoot={gameRoot.value} relPath={mod.relPath} mode="audio" />
            )}
            {mod.kind === "script" && (
              <AssetPreview
                gameRoot={gameRoot.value}
                relPath={mod.relPath}
                mode="model"
                silentEmpty
              />
            )}
            {mod.detail && <div class="mod-detail__desc">{mod.detail}</div>}
            {mod.paths.length > 0 ? (
              <ul class="mod-detail__paths">
                {mod.paths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : (
              <p class="mod-detail__hint">{t("resources.manifestOnly")}</p>
            )}
          </div>
          <div class="mod-detail__foot">
            <div class="mod-detail__foot-row">
              {mod.paths.length > 0 ? (
                <HkSwitch
                  size="sm"
                  modelValue={!mod.disabled}
                  disabled={!!state}
                  onUpdate:modelValue={(v: boolean) => toggleUnit(mod, v)}
                >
                  {mod.disabled ? t("resources.disabled") : t("resources.enabled")}
                </HkSwitch>
              ) : (
                <span class="mod-detail__hint">{t("resources.manifestOnlyShort")}</span>
              )}
              <div class="mod-detail__actions">
                <button
                  class="mod-detail__danger"
                  disabled={!!state}
                  onClick={() => (unitTarget.value = mod)}
                >
                  <Trash2 size={13} />
                  {state === "uninstall" ? t("resources.uninstalling") : t("resources.uninstall")}
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    function renderForeignDetail(unit: ForeignModUnit) {
      const paired = unit.identity
        ? listedEntries(catalog.value).find((e) => e.id === unit.identity)
        : undefined;
      return (
        <div class="mod-detail">
          <div class="mod-detail__head">
            <span class="mod-row__tile mod-row__tile--cat mod-row__tile--lg">
              <Puzzle size={24} />
            </span>
            <div class="mod-detail__id">
              <div class="mod-detail__name">{unit.name}</div>
              <div class="mod-detail__en">{installerLabel(unit.installer)}</div>
            </div>
          </div>
          <div class="mod-detail__scroll">
            <div class="mod-detail__badges">
              <span class="mod-detail__badge">
                {t("resources.foreignBadge", { source: installerLabel(unit.installer) })}
              </span>
              {unit.version && <span class="mod-detail__badge">v{unit.version}</span>}
              {paired && (
                <span class="mod-detail__badge mod-detail__badge--ok">
                  {t("resources.foreignPaired")}
                </span>
              )}
            </div>
            <p class="mod-detail__desc">
              {t("resources.foreignManaged", {
                name: unit.name,
                source: installerLabel(unit.installer),
              })}
            </p>
            {paired && (
              <p class="mod-detail__hint">
                {t("resources.foreignPairedHint", { name: localized(paired).name })}
              </p>
            )}
          </div>
          <div class="mod-detail__foot">
            <div class="mod-detail__foot-row">
              {paired && (
                <HkButton
                  size="sm"
                  variant="secondary"
                  onClick={() => selectCatalog(paired)}
                >
                  {t("resources.foreignOpenPaired")}
                </HkButton>
              )}
            </div>
          </div>
        </div>
      );
    }

    /** The material component pane: the covered part at the top, then one
     *  section per pack writing files there — registered pack name (from
     *  the wowsp.toml pairing) when known, the directory name otherwise —
     *  each with its texture previews and a jump to the catalog entry for
     *  replacing. */
    function renderComponentDetail(comp: TextureComponent) {
      return (
        <div class="mod-detail">
          <div class="mod-detail__head">
            <span class="mod-row__tile mod-row__tile--textures mod-row__tile--lg">
              <ImageIcon size={24} />
            </span>
            <div class="mod-detail__id">
              <div class="mod-detail__name">{comp.label}</div>
              <div class="mod-detail__en">
                {t("resources.componentSources", { count: comp.units.length })}
              </div>
            </div>
          </div>
          <div class="mod-detail__scroll">
            {comp.units.map((unit) => {
              const paired = pairedEntryOf(unit);
              return (
                <div class="mod-detail__component" key={unit.relPath}>
                  <div class="mod-detail__component-head">
                    <span class="mod-detail__component-name">
                      {paired
                        ? t("resources.componentFrom", {
                            name: localized(paired).name,
                          })
                        : unit.name}
                    </span>
                    {paired && (
                      <HkButton
                        size="sm"
                        variant="ghost"
                        onClick={() => selectCatalog(paired)}
                      >
                        {t("resources.componentReplace")}
                      </HkButton>
                    )}
                  </div>
                  <AssetPreview
                    gameRoot={gameRoot.value}
                    relPath={unit.relPath}
                    mode="image"
                  />
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    function renderLocalDetail() {
      return (
        <div class="mod-detail">
          <div class="mod-detail__head">
            <span class="mod-row__tile mod-row__tile--lg">
              <FolderSearch size={24} />
            </span>
            <div class="mod-detail__id">
              <div class="mod-detail__name">{t("resources.installSection")}</div>
              <div class="mod-detail__en">{t("resources.installHint")}</div>
            </div>
          </div>
          <div class="mod-detail__scroll">
            <div class="resources-installrow">
              <input
                type="text"
                v-model={sourcePath.value}
                placeholder={t("resources.pathPlaceholder")}
                spellcheck={false}
              />
              <button
                disabled={!sourcePath.value.trim() || analyzing.value || !gameRoot.value}
                onClick={analyze}
              >
                {analyzing.value ? t("resources.analyzing") : t("resources.browse")}
              </button>
            </div>
            {planError.value && (
              <div class="resources-banner resources-banner--error">{planError.value}</div>
            )}
            {report.value && (
              <div class="resources-banner resources-banner--ok">
                {t("resources.installedOk", {
                  name: report.value.name,
                  count: report.value.count,
                  version: report.value.version,
                })}
                {report.value.warnings.length > 0 && (
                  <ul class="plan-card__warnings resources-report-warnings">
                    {report.value.warnings.map((w, i) => (
                      <li key={`${i}-${w}`}>
                        <AlertTriangle size={12} /> {w}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {plan.value && (
              <div class={`plan-card plan-card--${KIND_META[plan.value.kind].class}`}>
                <div class="plan-card__head">
                  {(() => {
                    const Icon = KIND_META[plan.value!.kind].icon;
                    return <Icon size={18} />;
                  })()}
                  <strong>{plan.value.name}</strong>
                  <span class="plan-card__badge">{kindLabel(plan.value.kind)}</span>
                  {plan.value.detail && <span class="plan-card__detail">{plan.value.detail}</span>}
                </div>
                {plan.value.textureAnalysis && renderTexAnalysis(plan.value.textureAnalysis)}
                {plan.value.entries.length > 0 && (
                  <table class="plan-card__files">
                    <caption>{t("resources.planFiles")}</caption>
                    <tbody>
                      {plan.value.entries.map((e) => (
                        <tr key={e.fromRel + e.toRel}>
                          <td>{e.fromRel === "." ? "." : `${e.fromRel}/`}</td>
                          <td>→</td>
                          <td>{e.toRel}/</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {plan.value.warnings.length > 0 && (
                  <ul class="plan-card__warnings">
                    {plan.value.warnings.map((w) => (
                      <li key={w}>
                        <AlertTriangle size={12} /> {w}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <div class="mod-detail__foot">
            <div class="mod-detail__foot-row">
              <div class="mod-detail__actions">
                <HkButton
                  size="sm"
                  variant="primary"
                  disabled={!plan.value || installing.value || !gameRoot.value}
                  loading={installing.value}
                  onClick={confirmInstall}
                >
                  {installing.value ? t("resources.installing") : t("resources.confirmInstall")}
                </HkButton>
              </div>
            </div>
          </div>
        </div>
      );
    }

    function renderPane() {
      // A deep link into a delisted mod explains itself BEFORE the empty
      // state — the entry is real, just not openable anymore.
      const gone = delistedHit.value;
      if (!selection.value && gone) {
        const text = localized(gone);
        return (
          <div class="mod-detail mod-detail--empty">
            <div class="mod-detail__placeholder">
              <Ban size={30} />
              <strong class="mod-detail__placeholder-title">
                {t("resources.delistedTitle")}
              </strong>
              <p>
                {t("resources.delistedHint", {
                  name: text.name || gone.nameEn || gone.title,
                })}
              </p>
            </div>
          </div>
        );
      }
      const sel = selection.value;
      if (!sel) {
        return (
          <div class="mod-detail mod-detail--empty">
            <div class="mod-detail__placeholder">
              <MousePointerClick size={30} />
              <p>{t("resources.pickHint")}</p>
            </div>
          </div>
        );
      }
      switch (sel.mode) {
        case "catalog":
          return renderCatalogDetail(sel.entry);
        case "installed":
          return renderInstalledDetail(sel.mod);
        case "foreign":
          return renderForeignDetail(sel.unit);
        case "component":
          return renderComponentDetail(sel.comp);
        case "local":
          return renderLocalDetail();
      }
    }

    // ── Stale-bin migration wizard modal ─────────────────────────────────

    /** One auto-cleaned group (duplicates / superseded): collapsed to a
     *  count + one-line explanation, expandable to the raw file list. */
    function renderMigGroup(kind: "duplicate" | "superseded", files: PlanFile[]) {
      const open = migGroupOpen.value === kind;
      return (
        <div class="mig-wizard__group" key={kind}>
          <button
            type="button"
            class="mig-wizard__group-head"
            disabled={files.length === 0}
            onClick={() => (migGroupOpen.value = open ? null : kind)}
          >
            <ChevronDown size={14} class={["mig-wizard__chevron", { open }]} />
            <strong>{t(`resources.migrateGroup.${kind}`)}</strong>
            <span class="mig-wizard__count">{files.length}</span>
          </button>
          <p class="mig-wizard__hint">{t(`resources.migrateGroup.${kind}Hint`)}</p>
          {open && files.length > 0 && (
            <ul class="mig-wizard__files">
              {files.map((f) => (
                <li key={f.path} title={f.path}>
                  {f.path}
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }

    /** A decide row: checkbox (= keep), the resolved identity name when the
     *  path maps to a catalog entry / known Aslain directory, the raw path,
     *  the size, and the ignore action ("leave alone" in the stale bin).
     *  The row is a div — the checkable part is its own label so the ignore
     *  button never toggles the checkbox. */
    const renderMigRow = (f: PlanFile) => {
      const identity = migIdentity(f);
      return (
        <div key={f.path} class="mig-wizard__row" title={f.path}>
          <label class="mig-wizard__row-body">
            <HkCheckbox
              modelValue={migDecide.value.keep.has(f.path)}
              onUpdate:modelValue={(v: boolean) => toggleMigKeep(f.path, v)}
            />
            <span class="mig-wizard__row-main">
              <span class="mig-wizard__row-name">{identity ?? f.path}</span>
              {identity && <span class="mig-wizard__row-path">{f.path}</span>}
            </span>
          </label>
          <span class="mig-wizard__row-size">{migKb(f.size)}</span>
          <HkIconButton
            size={24}
            variant="ghost"
            data-hint={t("resources.migrateIgnore")}
            onClick={() => ignoreMigPath(f.path)}
          >
            <Ban size={14} />
          </HkIconButton>
        </div>
      );
    };

    /** An ignored row: no checkbox (the verdict is made), the identity/path
     *  pair in a dimmer dress, and the way back (restore to kept). */
    const renderMigIgnoredRow = (f: PlanFile) => {
      const identity = migIdentity(f);
      return (
        <div key={f.path} class="mig-wizard__row mig-wizard__row--ignored" title={f.path}>
          <span class="mig-wizard__row-body">
            <span class="mig-wizard__row-main">
              <span class="mig-wizard__row-name">{identity ?? f.path}</span>
              {identity && <span class="mig-wizard__row-path">{f.path}</span>}
            </span>
          </span>
          <span class="mig-wizard__row-size">{migKb(f.size)}</span>
          <HkIconButton
            size={24}
            variant="ghost"
            data-hint={t("resources.migrateUnignore")}
            onClick={() => restoreMigPath(f.path)}
          >
            <Undo2 size={14} />
          </HkIconButton>
        </div>
      );
    };

    function renderMigrateWizard() {
      const plan = migPlan.value;
      const step = migStep.value;
      const busy = step === "executing";
      const title = t("resources.staleMigrate");
      const footers = (() => {
        if (step === "done") {
          return [
            {
              label: t("common.close"),
              variant: "primary" as const,
              onClick: closeMigrate,
            },
          ];
        }
        if (busy) return [];
        const cancel = {
          label: t("resources.migrateCancel"),
          variant: "secondary" as const,
          onClick: closeMigrate,
        };
        if (step === "review" && plan) {
          return [
            cancel,
            {
              label: t("resources.migrateStart"),
              variant: "primary" as const,
              disabled:
                plan.duplicate.length + plan.superseded.length + plan.decide.length === 0,
              onClick: () => void startMigrate(),
            },
          ];
        }
        if (step === "confirm") {
          return [
            cancel,
            {
              label: t("resources.migrateScanStart"),
              variant: "primary" as const,
              onClick: () => void loadMigPlan(),
            },
          ];
        }
        if (step === "plan" && migError.value) {
          return [
            cancel,
            {
              label: t("common.retry"),
              variant: "primary" as const,
              onClick: () => void loadMigPlan(),
            },
          ];
        }
        return [cancel];
      })();

      return (
        <HkModal
          modelValue={migrateWizardOpen.value}
          onUpdate:modelValue={(v: boolean) => {
            // Opening is driven by the entry points; an in-flight execute
            // must not be dismissable mid-sweep.
            if (v || busy) return;
            closeMigrate();
          }}
          title={title}
          width="34rem"
          footerActions={footers}
        >
          <div class="mig-wizard">
            {step === "confirm" && (
              <>
                {staleBins.value.length > 1 && (
                  <HkTabs
                    block
                    variant="segmented"
                    modelValue={migFrom.value}
                    onUpdate:modelValue={(v: string) => pickMigFrom(v)}
                    tabs={staleBins.value.map((b) => ({
                      key: b.binVersion,
                      label: `bin/${b.binVersion} (${b.fileCount})`,
                    }))}
                    renderPanels={false}
                  />
                )}
                <p class="mig-wizard__status">{t("resources.migrateScanIntro", { from: migFrom.value, count: staleBins.value.find((b) => b.binVersion === migFrom.value)?.fileCount ?? 0 })}</p>
                <p class="mig-wizard__status mig-wizard__status--muted">
                  {t("resources.migrateScanNote")}
                </p>
              </>
            )}
            {step === "plan" &&
              (migError.value ? (
                <div class="resources-banner resources-banner--error">{migError.value}</div>
              ) : (
                <p class="mig-wizard__status">
                  <HkSpinner size="sm" tone="current" />
                  {t("resources.migrateAnalyzing", { from: migFrom.value })}
                </p>
              ))}

            {step === "review" && plan && (
              <>
                {staleBins.value.length > 1 && (
                  <HkTabs
                    block
                    variant="segmented"
                    modelValue={migFrom.value}
                    onUpdate:modelValue={(v: string) => pickMigFrom(v)}
                    tabs={staleBins.value.map((b) => ({
                      key: b.binVersion,
                      label: `bin/${b.binVersion}`,
                    }))}
                    renderPanels={false}
                  />
                )}
                {migError.value && (
                  <div class="resources-banner resources-banner--error">{migError.value}</div>
                )}
                {plan.duplicate.length +
                  plan.superseded.length +
                  plan.decide.length ===
                0 ? (
                  <p class="mig-wizard__empty">{t("resources.migrateEmpty")}</p>
                ) : (
                  <>
                    {renderMigGroup("duplicate", plan.duplicate)}
                    {renderMigGroup("superseded", plan.superseded)}
                    <div class="mig-wizard__group">
                      <div class="mig-wizard__group-head mig-wizard__group-head--static">
                        <HkCheckbox
                          modelValue={
                            masterChecked(
                              decidePaths(),
                              migDecide.value.keep,
                              migDecide.value.ignore,
                            ) as boolean
                          }
                          disabled={decideAllIgnored.value}
                          data-hint={t("resources.migrateToggleAll")}
                          onUpdate:modelValue={(v: boolean) => toggleMigKeepAll(v)}
                        />
                        <strong>{t("resources.migrateGroup.decide")}</strong>
                        <span class="mig-wizard__count">
                          {(() => {
                            const { kept, pending } = keptPending(
                              decidePaths(),
                              migDecide.value.keep,
                              migDecide.value.ignore,
                            );
                            return t("resources.migrateKeptCount", {
                              kept,
                              total: pending,
                            });
                          })()}
                        </span>
                        <HkButton
                          variant="ghost"
                          size="sm"
                          disabled={decideAllIgnored.value}
                          onClick={ignoreMigAll}
                        >
                          {t("resources.migrateIgnoreAll")}
                        </HkButton>
                      </div>
                      <p class="mig-wizard__hint">{t("resources.migrateGroup.decideHint")}</p>
                      {(() => {
                        const ignore = migDecide.value.ignore;
                        const rows = plan.decide.filter((f) => !ignore.has(f.path));
                        return rows.length > 0 ? (
                          <div class="mig-wizard__rows">
                            {rows.map(renderMigRow)}
                          </div>
                        ) : null;
                      })()}
                    </div>
                    {migDecide.value.ignore.size > 0 && (
                      <div class="mig-wizard__group">
                        <button
                          type="button"
                          class="mig-wizard__group-head"
                          onClick={() =>
                            (migGroupOpen.value =
                              migGroupOpen.value === "ignored" ? null : "ignored")
                          }
                        >
                          <ChevronDown
                            size={14}
                            class={[
                              "mig-wizard__chevron",
                              { open: migGroupOpen.value === "ignored" },
                            ]}
                          />
                          <strong>{t("resources.migrateGroup.ignored")}</strong>
                          <span class="mig-wizard__count">{migDecide.value.ignore.size}</span>
                        </button>
                        <p class="mig-wizard__hint">
                          {t("resources.migrateGroup.ignoredHint")}
                        </p>
                        <div class="mig-wizard__group-foot">
                          <HkButton variant="ghost" size="sm" onClick={restoreMigAll}>
                            {t("resources.migrateUnignoreAll")}
                          </HkButton>
                        </div>
                        {migGroupOpen.value === "ignored" && (
                          <div class="mig-wizard__rows">
                            {plan.decide
                              .filter((f) => migDecide.value.ignore.has(f.path))
                              .map(renderMigIgnoredRow)}
                          </div>
                        )}
                      </div>
                    )}
                    <p class="mig-wizard__hint mig-wizard__hint--foot">
                      {t("resources.migrateCleanupNote")}
                    </p>
                  </>
                )}
              </>
            )}

            {step === "executing" && (
              <p class="mig-wizard__status">
                <HkSpinner size="sm" tone="current" />
                {t("resources.migrateExecuting", {
                  from: migFrom.value,
                  to: plan?.toVersion ?? "",
                })}
              </p>
            )}

            {step === "done" && migReport.value && (
              <>
                <div class="resources-banner resources-banner--ok">
                  {t("resources.migrateDone", {
                    moved: migReport.value.movedFiles,
                    to: migReport.value.toVersion,
                    skipped: migReport.value.skippedFiles,
                  })}
                </div>
                {(migReport.value.ignoredFiles ?? 0) > 0 && (
                  <p class="mig-wizard__status mig-wizard__status--muted">
                    {t("resources.migrateDoneIgnored", {
                      ignored: migReport.value.ignoredFiles,
                      from: migReport.value.fromVersion,
                    })}
                  </p>
                )}
              </>
            )}
          </div>
        </HkModal>
      );
    }

    return () => {
      const sourceTabs = [
        { key: "online", label: t("resources.source.online") },
        { key: "installed", label: t("resources.source.installed") },
      ];
      const bigCatTabs = [
        { key: "function", label: t("resources.big.function"), icon: <Puzzle size={14} /> },
        { key: "texture", label: t("resources.big.texture"), icon: <ImageIcon size={14} /> },
        { key: "voice", label: t("resources.big.voice"), icon: <AudioLines size={14} /> },
      ];
      const selKey = selectedRowKey.value;
      return (
        <div class="resources-view">
          {/* ── Master/detail in the replay page's secondary-sidebar shape:
              the sidebar owns the title row, the condition strips, the count
              pill and the whole filter stack above the scrolling list; the
              pane shows what the selected row is. ── */}
          <aside class="resources-view__side">
            <div class="resources-view__side-head">
              <div class="resources-view__side-head-row">
                <h2 class="resources-view__side-title">{t("resources.title")}</h2>
                <span class="resources-view__side-actions">
                  {/* Tool menu: safe mode + the migration wizard — the ⋯
                      button rides the title row like the replay list's head
                      actions; refresh / folder-install ride the source row
                      below as its trailing ghost pair. */}
                  <span class="resources-view__tools" ref={toolsAnchor}>
                    <HkIconButton
                      size={24}
                      variant="ghost"
                      data-hint={t("resources.toolsMenu")}
                      onClick={() => (toolsOpen.value = !toolsOpen.value)}
                    >
                      <Ellipsis size={15} />
                    </HkIconButton>
                    <HMenu
                      variant="popup"
                      title={t("resources.toolsMenu")}
                      open={toolsOpen.value}
                      anchorRef={toolsAnchor.value}
                      placement="bottom-end"
                      items={[
                        {
                          key: "safe-enter",
                          label: t("resources.safeModeEnter"),
                          icon: ShieldCheck,
                          disabled: !gameRoot.value || safeMode.value || safeModeBusy.value,
                        },
                        {
                          key: "safe-exit",
                          label: t("resources.safeModeExit"),
                          icon: Undo2,
                          disabled: !safeMode.value || safeModeBusy.value,
                        },
                        {
                          key: "migrate",
                          label: t("resources.staleMigrate"),
                          icon: RefreshCw,
                          disabled:
                            !gameRoot.value || staleBins.value.length === 0 || migrating.value,
                        },
                      ]}
                      onSelect={({ key }: { key: string | number }) => {
                        toolsOpen.value = false;
                        if (key === "safe-enter") safeModeAsk.value = "on";
                        else if (key === "safe-exit") safeModeAsk.value = "off";
                        else if (key === "migrate") openMigrateWizard();
                      }}
                      onUpdate:open={(v: boolean) => (toolsOpen.value = v)}
                    />
                  </span>
                </span>
              </div>

              {/* Compact condition strip: only what NEEDS attention stays a
                  banner — a missing install speaks the replay list's quiet
                  no-client note, while safe mode / stale bins keep the
                  banner chrome (both carry an action). Tooling lives in the
                  ⋯ menu. */}
              {!gameRoot.value && (
                <p class="resources-view__side-note">{t("resources.noGame")}</p>
              )}

              {safeMode.value && gameRoot.value && (
                <div class="resources-banner resources-banner--warn">
                  <AlertTriangle size={16} />
                  <span class="resources-banner__text">{t("resources.safeModeOn")}</span>
                  <HkButton
                    size="sm"
                    disabled={safeModeBusy.value}
                    loading={safeModeBusy.value}
                    onClick={() => (safeModeAsk.value = "off")}
                  >
                    {t("resources.safeModeExit")}
                  </HkButton>
                </div>
              )}

              {staleBins.value.length > 0 && gameRoot.value && !safeMode.value && (
                <div class="resources-banner resources-banner--warn">
                  <AlertTriangle size={16} />
                  <span class="resources-banner__text">
                    {t("resources.staleBinBanner", {
                      version: staleBins.value.map((b) => b.binVersion).join(", "),
                      count: staleBins.value.reduce((n, b) => n + b.fileCount, 0),
                    })}
                  </span>
                  <HkButton
                    size="sm"
                    variant="primary"
                    disabled={migrating.value}
                    loading={migrating.value}
                    onClick={openMigrateWizard}
                  >
                    {t("resources.staleMigrate")}
                  </HkButton>
                </div>
              )}

              {/* The count pill mirrors the replay list's count — scoped to
                  the ACTIVE source AND big category, i.e. exactly what the
                  "all" chip below counts; narrower chip/filter states show
                  in the list itself. */}
              <span class="resources-view__count">
                {t("resources.countLine", {
                  count:
                    source.value === "online"
                      ? catalogInCat.value.length
                      : installedInCat.value.length,
                })}
              </span>

              {/* Big category — the row-filling segmented strip. */}
              <HkTabs
                variant="segmented"
                block
                modelValue={bigCat.value}
                onUpdate:modelValue={(v: string) => (bigCat.value = v as BigCat)}
                tabs={bigCatTabs}
                renderPanels={false}
              />

              {/* Source switch + the three tool triggers (search popup,
                  refresh/rescan, folder install) ride one row — all ghost
                  icon-button sized, the segmented group carries the height. */}
              <div class="resources-view__row">
                <div class="resources-view__rowmain">
                  <HkTabs
                    variant="segmented"
                    modelValue={source.value}
                    onUpdate:modelValue={(v: string) => pickSource(v as "online" | "installed")}
                    tabs={sourceTabs}
                    renderPanels={false}
                  />
                </div>
                <AsyncSearchCombo
                  key={source.value}
                  ghost
                  search={comboSearch}
                  itemKey={(raw: unknown) =>
                    source.value === "installed"
                      ? (raw as InstalledMod).relPath
                      : (raw as CatalogEntry).id
                  }
                  renderItem={comboRenderItem}
                  onSelect={comboSelect}
                  title={t("resources.searchMod")}
                  placeholder={t("resources.listFilter")}
                  searchingText={t("resources.searching")}
                  minChars={1}
                  align="right"
                  noResultsText={t("resources.empty")}
                />
                <HkIconButton
                  size={24}
                  variant="ghost"
                  disabled={refreshDisabled.value}
                  data-hint={source.value === "online" ? t("resources.refresh") : t("resources.scan")}
                  aria-label={
                    source.value === "online" ? t("resources.refresh") : t("resources.scan")
                  }
                  onClick={refresh}
                >
                  <RefreshCw size={15} class={refreshSpinning.value ? "spin" : undefined} />
                </HkIconButton>
                <HkIconButton
                  size={24}
                  variant="ghost"
                  data-hint={t("resources.installSection")}
                  aria-label={t("resources.installSection")}
                  onClick={openLocal}
                >
                  <FolderSearch size={15} />
                </HkIconButton>
              </div>

              {source.value === "online" && catalogError.value && (
                <div class="resources-banner resources-banner--error">
                  {t("resources.catalogError", { error: catalogError.value })}
                </div>
              )}

              {/* Sub-division chips, scoped to the active big category. */}
              <div class="resources-chips">
                {source.value === "online" ? (
                  <>
                    <button
                      class={["chip", catalogFilter.value === "all" && "chip--on"]}
                      onClick={() => (catalogFilter.value = "all")}
                    >
                      {t("resources.cat.all")} · {catalogInCat.value.length}
                    </button>
                    {CATALOG_CATS.filter(
                      (c) =>
                        catBig(c) === bigCat.value && (catCounts.value.get(c) ?? 0) > 0,
                    ).map((c) => (
                      <button
                        key={c}
                        class={["chip", catalogFilter.value === c && "chip--on"]}
                        onClick={() => (catalogFilter.value = c)}
                      >
                        {t(`resources.cat.${c}`)} · {catCounts.value.get(c)}
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    <button
                      class={["chip", filter.value === "all" && "chip--on"]}
                      onClick={() => (filter.value = "all")}
                    >
                      {t("resources.filterAll")} · {installedInCat.value.length}
                    </button>
                    {KIND_ORDER.filter(
                      (k) => KIND_BIG[k] === bigCat.value && (kindCounts.value.get(k) ?? 0) > 0,
                    ).map((k) => (
                      <button
                        key={k}
                        class={["chip", filter.value === k && "chip--on"]}
                        onClick={() => (filter.value = k)}
                      >
                        {kindLabel(k)} · {kindCounts.value.get(k)}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>

            {/* ── The compact list (the master half): the sidebar's
                scroller — the filter stack above stays put ── */}
            <div class="resources-view__side-scroll">
              {source.value === "online"
                ? catalogShown.value.length === 0
                  ? catalogEmptyNote()
                  : catalogShown.value.map((entry) => {
                      const text = localized(entry);
                      const record = recordOf(entry.id);
                      const upToDate = !!record && record.version === entry.version;
                      const busyInstall = busy.value.get(entry.id) === "install";
                      const RowIcon = catIcon(entry.category);
                      return (
                        <button
                          key={entry.id}
                          class={["mod-row", selKey === entry.id && "mod-row--active"]}
                          onClick={() => selectCatalog(entry)}
                        >
                          <span class="mod-row__tile mod-row__tile--cat">
                            <RowIcon size={20} />
                          </span>
                          <span class="mod-row__body">
                            <span class="mod-row__name">
                              {text.name || entry.title || entry.nameEn}
                            </span>
                            <span class="mod-row__sub">{text.desc || entry.nameEn}</span>
                          </span>
                          <span class="mod-row__tail">
                            {busyInstall ? (
                              <span class="mod-row__spinner" />
                            ) : upToDate ? (
                              <span class="mod-row__badge mod-row__badge--ok">
                                {t("resources.installedBadge")}
                              </span>
                            ) : record ? (
                              <span class="mod-row__badge mod-row__badge--up">
                                {t("resources.update")}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })
                : bigCat.value === "texture" && textureComponents.value.length === 0
                  ? installedEmptyNote()
                  : bigCat.value === "texture"
                    ? textureComponents.value.map((comp) => {
                        const active =
                          selection.value?.mode === "component" &&
                          selection.value.comp.key === comp.key;
                        return (
                          <button
                            key={comp.key}
                            class={["mod-row", active && "mod-row--active"]}
                            onClick={() => selectComponent(comp)}
                          >
                            <span class="mod-row__tile mod-row__tile--textures">
                              <ImageIcon size={20} />
                            </span>
                            <span class="mod-row__body">
                              <span class="mod-row__name">{comp.label}</span>
                              <span class="mod-row__sub">
                                {t("resources.componentSources", {
                                  count: comp.units.length,
                                })}
                              </span>
                            </span>
                          </button>
                        );
                      })
                    : shown.value.length === 0
                      ? installedEmptyNote()
                      : shown.value.map((m) => {
                      const meta = KIND_META[m.kind];
                      const Icon = meta.icon;
                      const state = unitBusy.value.get(m.relPath);
                      return (
                        <button
                          key={m.relPath}
                          class={[
                            "mod-row",
                            m.disabled && "mod-row--disabled",
                            selKey === m.relPath && "mod-row--active",
                          ]}
                          onClick={() => selectInstalled(m)}
                        >
                          <span class={["mod-row__tile", `mod-row__tile--${meta.class}`]}>
                            <Icon size={20} />
                          </span>
                          <span class="mod-row__body">
                            <span class="mod-row__name">
                              {m.name}
                              {m.version && <span class="mod-row__ver">{m.version}</span>}
                            </span>
                            <span class="mod-row__sub">
                              {m.textureAnalysis?.ships?.length
                                ? t("resources.texCover", {
                                    count: m.textureAnalysis.ships.length,
                                    ships: m.textureAnalysis.ships.slice(0, 2).join(" · "),
                                  })
                                : `${kindLabel(m.kind)} · ${m.relPath}`}
                            </span>
                          </span>
                          <span class="mod-row__tail">
                            {state ? (
                              <span class="mod-row__spinner" />
                            ) : m.disabled ? (
                              <span class="mod-row__badge mod-row__badge--off">
                                {t("resources.disabled")}
                              </span>
                            ) : null}
                            {aslainNames.value.has(m.name) && (
                              <span class="mod-row__badge mod-row__badge--src">
                                {t("resources.foreignSource.aslain")}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
            </div>

            {source.value === "installed" && modstationUnits.value.length > 0 && (
              <div class="resources-view__foreign-strip">
                <span class="resources-view__foreign-strip-title">
                  {t("resources.foreignSource.modstation")}
                </span>
                {modstationUnits.value.map((unit) => (
                  <button
                    key={`${unit.installer}/${unit.key}`}
                    class={[
                      "mod-row",
                      selection.value?.mode === "foreign" &&
                        selection.value.unit.key === unit.key &&
                        selection.value.unit.installer === unit.installer &&
                        "mod-row--active",
                    ]}
                    onClick={() => selectForeign(unit)}
                  >
                    <span class="mod-row__tile mod-row__tile--cat">
                      <Puzzle size={20} />
                    </span>
                    <span class="mod-row__body">
                      <span class="mod-row__name">{unit.name}</span>
                      <span class="mod-row__sub">
                        {unit.identity
                          ? t("resources.foreignPaired")
                          : t("resources.foreignUnpaired")}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Catalog metadata rides a quiet footer (the count itself moved
                into the pill above); the installed list has none — its count
                IS the pill. */}
            {source.value === "online" && (
              <div class="resources-view__side-foot">
                {t("resources.catalogMeta", {
                  source: catalogSource.value,
                  time: catalogFetched.value.slice(0, 10),
                })}
              </div>
            )}
          </aside>

          {/* ── The detail half: what the selected row is, and every
              action for it, with the actions pinned bottom-right ── */}
          <section class="resources-view__main">{renderPane()}</section>

          <HkConfirmDialog
            open={!!confirmTarget.value}
            title={t("resources.uninstall")}
            message={t("resources.confirmUninstall", { name: confirmTarget.value?.nameZh || confirmTarget.value?.nameEn || "" })}
            confirmLabel={t("resources.uninstall")}
            onConfirm={uninstallMod}
            onUpdate:open={(v: boolean) => {
              if (!v) confirmTarget.value = null;
            }}
          />

          <HkConfirmDialog
            open={!!safeModeAsk.value}
            title={t(safeModeAsk.value === "on" ? "resources.safeModeEnter" : "resources.safeModeExit")}
            message={t(
              safeModeAsk.value === "on"
                ? "resources.confirmSafeModeEnter"
                : "resources.confirmSafeModeExit",
            )}
            confirmLabel={t(
              safeModeAsk.value === "on" ? "resources.safeModeEnter" : "resources.safeModeExit",
            )}
            onConfirm={doSafeMode}
            onUpdate:open={(v: boolean) => {
              if (!v) safeModeAsk.value = null;
            }}
          />

          {/* Stale-bin migration wizard: plan → review → executing → done. */}
          {renderMigrateWizard()}

          <HkConfirmDialog
            open={!!unitTarget.value}
            title={t("resources.uninstall")}
            message={t("resources.confirmUnitUninstall", {
              name: unitTarget.value?.name || "",
            })}
            confirmLabel={t("resources.uninstall")}
            onConfirm={uninstallUnit}
            onUpdate:open={(v: boolean) => {
              if (!v) unitTarget.value = null;
            }}
          />
        </div>
      );
    };
  },
});
