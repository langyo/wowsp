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
  type GameInstall,
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
import { appliesToRealm, realmOfInstall } from "@/features/modhub/servers";
import { requestModOpDisclaimer } from "@/features/modhub/ModOpDisclaimer";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useIngamePluginStore } from "@/stores/ingamePlugin";
import {
  failureDetail,
  usePluginUpdatesStore,
  type PluginItemOp,
} from "@/stores/pluginUpdates";
import { modSyncState, useModSyncStore } from "@/stores/modSync";
import { useStaleBinsStore } from "@/stores/staleBins";
import { t } from "@/i18n";
import { sameGamePath } from "@/utils/gamePath";
import { installFolderName, installLabelOf } from "@/utils/installLabel";
import {
  entryMatches,
  installedPresetOf,
  installerLabel,
  localized,
} from "./display";
import type { Selection, TextureComponent } from "./types";

/** One OTHER client's share of a "Sync all clients" reconcile plan:
 *  which applicable catalog mods it is missing (with the preset the
 *  active client's ledger record carries — a folded family's legacy
 *  record maps onto its scheme), and which of its catalog mods the
 *  active set does not carry (uninstall candidates by ledger-record id,
 *  realm-agnostic). */
export interface SyncAllClientPlan {
  install: GameInstall;
  label: string;
  installs: { entry: CatalogEntry; preset: string | null }[];
  uninstalls: { id: string; name: string }[];
}

/** The whole reconcile: per-other-client diffs plus the confirm
 *  dialog's totals. */
export interface SyncAllPlan {
  clients: SyncAllClientPlan[];
  totalInstalls: number;
  totalUninstalls: number;
}

/** Short label of a fan-out target client (kind · realm, falling back
 *  to the folder name when neither resolves). */
function syncLabelOf(install: GameInstall): string {
  return installLabelOf(install) || installFolderName(install.path);
}

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
  // Ledger fetch in flight — gates the "Sync all clients" menu entry,
  // which needs a fresh records read to plan per-client work.
  const recordsLoading = ref(false);
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
  // ── Multi-client sync (统一多客户端管理) ────────────────────────────
  // The mode preference lives in stores/modSync (default ON). While ON
  // and more than one install is detected, catalog install/uninstall fan
  // out to EVERY client (the active one first, realm-filtered); while
  // OFF everything behaves single-client and the page shows the
  // "managing individually" banner.
  const modSync = useModSyncStore();
  /** The "Sync all clients" reconcile: the plan awaiting its confirm
   *  dialog (null = closed), and its execute-in-flight flag. */
  const syncAllAsk = ref<SyncAllPlan | null>(null);
  const syncAllBusy = ref(false);
  const safeModeAsk = ref<"on" | "off" | null>(null);
  const safeModeBusy = ref(false);
  // The nuclear reset: purge EVERY mod, then reinstall only the units our
  // own ledger records. Two-step like safe mode (confirm dialog first).
  // "simple" = ours-only confirm, "choice" = two-scope dialog (only when a
  // third-party installer's units are on disk).
  const purgeAsk = ref<"simple" | "choice" | null>(null);
  const purgeBusy = ref(false);

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
  // the same table so the other surfaces disable too. The multi-client
  // fan-outs / reconcile hold their mod ids here TOO (fanOutBusy): the
  // shared table has gaps between per-target RPCs, and a row must stay
  // disabled for the whole fan-out, not flicker clickable between
  // clients. Markers are ADD/DELETE per mod id (never a wholesale
  // replacement): a row fan-out running while the reconcile holds its
  // own markers must not clobber them, or that run's rows would flicker
  // clickable mid-flight (the shared table's single-flight still blocks
  // the duplicate RPC — the merge only keeps the UI honest).
  const fanOutBusy = ref(new Map<string, PluginItemOp>());
  const busy = computed<Map<string, PluginItemOp>>(() => {
    if (fanOutBusy.value.size === 0) return pluginUpdates.itemBusy;
    const merged = new Map(pluginUpdates.itemBusy);
    for (const [id, op] of fanOutBusy.value) {
      if (!merged.has(id)) merged.set(id, op);
    }
    return merged;
  });
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

  /** Whether ANY running game process belongs to `root` — the same
   *  multi-instance rule as gameRunning, parameterized for the
   *  multi-client surfaces (the reconcile targets roots the active
   *  client's own check never covers) and SILENT: the reconcile records
   *  a skip warning naming the client instead of the block toast. A
   *  running process whose folder is unknown counts conservatively. */
  function clientRunning(root: string): boolean {
    const roots = gameStatus.processes
      .filter((p) => p.running)
      .map((p) => p.matchedInstall?.path ?? null);
    if (roots.length === 0) return false;
    return roots.some((r) => r == null || sameGamePath(root, r));
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
    if (recordsLoading.value) return;
    recordsLoading.value = true;
    try {
      records.value = await api.modHubRecords();
    } catch {
      records.value = [];
    } finally {
      recordsLoading.value = false;
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
    // A folded style family answers deep links to its legacy
    // one-entry-per-variant ids too (old links keep working).
    const hit = mods.find(
      (m) => m.id === want || m.supersedes?.[want] !== undefined,
    );
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
    // Land on the installed scheme (a legacy record's folded preset),
    // same as a sidebar row click.
    const deepRecord = recordOfEntry(hit);
    selectedPreset.value = deepRecord
      ? installedPresetOf(hit, deepRecord)
      : "";
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

  /** The ledger record backing a catalog entry ON ONE ROOT: its exact
   *  id, or — for a folded style family — a superseded one-entry-per-
   *  variant id (the record installed under `battle.panel.ttaro` backs
   *  `battle.panel`). Legacy unstamped records count for every root
   * (same rule as `recordOf`). Root-parametrized because the multi-
   * client sync ops resolve records per TARGET client, not just the
   * active one. */
  const recordOfEntryOn = (entry: CatalogEntry, root: string) =>
    records.value.find(
      (r) =>
        (r.id === entry.id || entry.supersedes?.[r.id] !== undefined) &&
        (!r.gameRoot || sameGamePath(r.gameRoot, root)),
    );

  /** The active root's record backing a catalog entry (see
   *  recordOfEntryOn). */
  const recordOfEntry = (entry: CatalogEntry) =>
    recordOfEntryOn(entry, gameRoot.value);

  /** Installed units are keyed by their primary path (unique per unit). */
  const unitKey = (m: InstalledMod) => m.relPath;

  // ── Multi-client fan-out targets (统一多客户端管理的目标集) ─────────
  // SCOPE: only catalog INSTALL/UNINSTALL ops fan out. The installed-
  // scan unit ops (toggle / on-disk uninstall), purge-reinstall, safe
  // mode and stale-bin migration operate on ONE client's disk by nature
  // (they walk that client's res_mods tree and manifest) and stay
  // per-client — syncing them would mean reimplementing each as a batch
  // RPC for no user-facing gain.

  /** Fan-out targets while unified sync is on: every detected install,
   *  the ACTIVE client first, deduped by path. Fewer than two entries
   *  (single-client machines, or sync off) collapse to [] — callers
   *  then keep today's single-root behavior, so the fan-out only ever
   *  WIDENS an op, never changes it. */
  const syncTargets = computed<GameInstall[]>(() => {
    if (!modSyncState.value) return [];
    const ordered = [
      ...(config.activeInstall ? [config.activeInstall] : []),
      ...(config.installs ?? []),
    ];
    const out: GameInstall[] = [];
    for (const i of ordered) {
      if (i && !out.some((o) => sameGamePath(o.path, i.path))) out.push(i);
    }
    return out;
  });

  /** The ACTIVE client install (the left-sidebar selection) — exposed
   *  for the banner's "Managing {client} individually" label. */
  const activeInstall = computed(() => config.activeInstall);

  /** How many distinct game clients the machine has — the sync toggle's
   *  and the banner's visibility (a single-client machine has nothing
   *  to fan out to, so neither surface exists). */
  const clientCount = computed(() => {
    const seen: GameInstall[] = [];
    for (const i of [
      ...(config.activeInstall ? [config.activeInstall] : []),
      ...(config.installs ?? []),
    ]) {
      if (i && !seen.some((o) => sameGamePath(o.path, i.path))) seen.push(i);
    }
    return seen.length;
  });

  /** The "managing individually" banner's condition: more than one
   *  client detected, unified sync OFF. */
  const syncIndividual = computed(
    () => !modSyncState.value && clientCount.value > 1,
  );

  /** One target client's fan-out outcome — the per-client rollup behind
   *  the ONE summary toast (the pluginUpdates batch-pass pattern). */
  interface SyncClientOutcome {
    label: string;
    ok: boolean;
    error?: string;
  }

  /** One catalog op fanned out across every target, SEQUENTIALLY (the
   *  shared busy table is single-flight per mod id). Realm rule: an
   *  INSTALL skips target clients the entry does not apply to
   *  (server-exclusive mods); an UNINSTALL never filters — removal is
   *  realm-agnostic cleanup of whatever copy sits on that client. The
   *  per-mod progress UX keeps working (progress events key by mod id
   * across roots), and ONE summary toast lands at the end: all good →
   *  success with the client count, mixed → warning with the capped
   *  failure fold, nothing landed → error. */
  async function fanOutMod(
    entry: CatalogEntry,
    op: "install" | "uninstall",
    preset?: string,
  ): Promise<void> {
    const targets = syncTargets.value;
    const outcomes: SyncClientOutcome[] = [];
    const failures: string[] = [];
    for (const target of targets) {
      const label = syncLabelOf(target);
      if (op === "install" && !appliesToRealm(entry, realmOfInstall(target))) {
        // Server-exclusive on this client — skip by rule, say so quietly.
        toast.info(
          t("resources.sync.skippedByRule", {
            mod: localized(entry).name || entry.nameEn,
            client: label,
          }),
        );
        continue;
      }
      // A running target client can't take writes (the backend refuses
      // them root-scoped) — skip it up front with the reconcile's quiet
      // warning instead of a per-target failure line in the summary.
      // (The active root was already blocked wholesale by gameRunning()
      // before the fan-out started, so this only fires for other
      // clients.)
      if (clientRunning(target.path)) {
        toast.warning(t("resources.sync.skippedRunning", { names: label }));
        continue;
      }
      try {
        if (op === "install") {
          const r = await pluginUpdates.runMod(entry.id, target.path, preset);
          for (const v of r.mirroredBins ?? []) {
            toast.info(t("resources.mirroredBins", { version: v }));
          }
          for (const c of r.conflicts ?? []) toast.info(c);
        } else {
          // Uninstall only where a record actually pairs — a target that
          // never installed the entry has nothing to remove, and a raw
          // uninstall RPC there would only surface backend "not
          // installed" noise as a false per-client failure. A folded
          // family's record may sit under a legacy variant id on this
          // particular client — uninstall THAT record, per target root.
          const record = recordOfEntryOn(entry, target.path);
          if (!record) continue;
          await pluginUpdates.runModUninstall(record.id, target.path);
        }
        outcomes.push({ label, ok: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        outcomes.push({ label, ok: false, error: msg });
        failures.push(`${label}: ${msg}`);
      }
    }
    const attempted = outcomes.length;
    const okCount = outcomes.filter((o) => o.ok).length;
    // Every target skipped by rule already spoke through its own toast —
    // no empty summary on top.
    if (attempted === 0) return;
    if (okCount === attempted) {
      toast.success(t("resources.sync.done", { count: okCount }));
    } else if (okCount > 0) {
      toast.warning(
        t("resources.sync.partial", {
          ok: okCount,
          count: attempted,
          details: failureDetail(failures),
        }),
      );
    } else {
      toast.error(
        t("resources.sync.failed", {
          count: attempted,
          details: failureDetail(failures),
        }),
      );
    }
  }

  async function installMod(entry: CatalogEntry, preset?: string) {
    if (!gameRoot.value || busy.value.has(entry.id) || gameRunning() || safeModeBlocked()) {
      return;
    }
    if (!(await requestModOpDisclaimer())) return;
    // Captured before the RPC: installing over a foreign (Aslain) copy
    // is a REGISTRATION — the backend cuts the foreign installer's
    // manifest rows, the follow-up toast says ownership moved.
    const tookOverForeign = !!foreignCopyOf(entry);
    // Multi-client fan-out (unified sync on, several installs): every
    // target client realm-filtered, ONE summary toast. Single-client
    // machines and individual-management mode keep today's per-op toast.
    const fanOut = syncTargets.value.length > 1;
    if (fanOut) fanOutBusy.value.set(entry.id, "install");
    try {
      if (fanOut) {
        await fanOutMod(entry, "install", preset);
        if (tookOverForeign) {
          toast.info(
            t("resources.registeredOverForeign", {
              name: localized(entry).name || entry.nameEn,
            }),
          );
        }
      } else {
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
      }
      await Promise.all([scan(), loadRecords(), pluginUpdates.syncFreshness()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      fanOutBusy.value.delete(entry.id);
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
    // A folded style family's pane may sit on a ledger record written
    // under a legacy one-entry-per-variant id — uninstall THAT record,
    // not the merged catalog id it now pairs with.
    const targetId = recordOfEntry(entry)?.id ?? entry.id;
    // Uninstall fans out too (unified sync on) — removal is realm-
    // agnostic, so no per-target skip rule applies here.
    const fanOut = syncTargets.value.length > 1;
    if (fanOut) fanOutBusy.value.set(entry.id, "uninstall");
    try {
      if (fanOut) {
        await fanOutMod(entry, "uninstall");
      } else {
        const r = await pluginUpdates.runModUninstall(targetId, gameRoot.value);
        toast.success(
          t("resources.uninstalledDone", {
            name: r.name,
            removed: r.removedFiles,
            restored: r.restoredFiles > 0 ? t("resources.restoredPart", { count: r.restoredFiles }) : "",
          }),
        );
      }
      await Promise.all([scan(), loadRecords(), pluginUpdates.syncFreshness()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      fanOutBusy.value.delete(entry.id);
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
      if (rec && (rec.droppedRecords > 0 || rec.healedNames > 0)) {
        const refreshed = await api.modHubRecords().catch(() => []);
        if (!isCurrent()) return;
        records.value = refreshed;
        if (rec.droppedRecords > 0) {
          toast.info(t("resources.reconciled", { n: rec.droppedRecords }));
        }
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
      // The quarantine rename flips the in-game plugin's presence: re-probe
      // so the plugin surfaces report quarantined/absent instead of riding
      // the pre-toggle snapshot.
      await useIngamePluginStore().refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      safeModeBusy.value = false;
    }
  }

  async function doPurgeReinstall(mode: "wowsp-only" | "adopt-foreign") {
    purgeAsk.value = null;
    if (!gameRoot.value || purgeBusy.value || gameRunning()) return;
    // An unfinished purge marker means the previous reset never completed —
    // resolve THAT backup (resume it or mark it done) before another
    // rename strands a second half-state. The backend refuses too; this
    // pre-check is what gives the localized message.
    try {
      const backups = await api.modHubPurgeBackups(gameRoot.value);
      const unfinished = backups.find((b) => b.hasMarker);
      if (unfinished) {
        toast.error(t("resources.purgeBackups.blocked", { name: unfinished.dirName }));
        return;
      }
    } catch {
      // Listing failed — the backend's own gate still refuses authoritatively.
    }
    purgeBusy.value = true;
    try {
      const report = await api.modHubPurgeReinstall(gameRoot.value, mode);
      toast.success(
        t("resources.purgeReinstallDone", {
          removed: report.removedFiles,
          count: report.reinstalled.length,
          adopted: report.adopted.length,
        }),
      );
      if (report.skipped.length > 0) {
        toast.warning(
          t("resources.purgeReinstallSkipped", {
            count: report.skipped.length,
          }),
        );
      }
      await scan();
      await loadRecords();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      purgeBusy.value = false;
    }
  }

  // ── "Sync all clients" reconcile ───────────────────────────────────
  // One-click convergence: every OTHER detected client adopts the
  // ACTIVE client's WoWSP-ledger catalog mod set — missing applicable
  // mods get installed (realm-filtered per target), extras the active
  // set does not carry get uninstalled (realm-agnostic removal). The
  // active client itself is the reference and is never touched.

  /** Fold a ledger record onto its catalog entry: exact id, else the
   *  folded family a superseded legacy id belongs to (pluginUpdates'
   *  entryOfRecord rule). Null when the record predates the index. */
  function entryOfRecord(r: ModInstallRecord): CatalogEntry | null {
    return (
      catalog.value.find((m) => m.id === r.id) ??
      catalog.value.find((m) => m.supersedes?.[r.id] !== undefined) ??
      null
    );
  }

  /** The WoWSP-ledger catalog records of one root (source "mod-hub";
   *  legacy unstamped records count for every root, the pairing rule
   * pluginUpdates uses). */
  const catalogRecordsOn = (root: string) =>
    records.value.filter(
      (r) => r.source === "mod-hub" && (!r.gameRoot || sameGamePath(r.gameRoot, root)),
    );

  /** Build the reconcile plan off the in-memory catalog + a FRESH
   *  ledger read, then raise the confirm dialog. An empty catalog is a
   * hard stop: without entries every target record would read as
   * "extra" and the plan would offer to uninstall the world. */
  async function openSyncAll(): Promise<void> {
    if (syncAllBusy.value || clientCount.value < 2) return;
    const active = config.activeInstall;
    if (!active) return;
    if (catalog.value.length === 0) {
      toast.error(t("resources.sync.noCatalog"));
      return;
    }
    // A read FAILURE must not masquerade as an empty ledger (loadRecords
    // swallows failures into []): with no records every target record
    // would read as "extra" and the plan would offer to uninstall the
    // world — read directly so the failure can bail out here.
    try {
      records.value = await api.modHubRecords();
    } catch {
      toast.error(t("resources.sync.noLedger"));
      return;
    }
    // The active client's set: entry → backing record (preset source).
    const activeEntries = new Map<CatalogEntry, ModInstallRecord>();
    const activeEntryIds = new Set<string>();
    const activeRecordIds = new Set<string>();
    for (const r of catalogRecordsOn(active.path)) {
      activeRecordIds.add(r.id);
      const e = entryOfRecord(r);
      if (e) {
        activeEntryIds.add(e.id);
        if (!activeEntries.has(e)) activeEntries.set(e, r);
      }
    }
    const clients: SyncAllClientPlan[] = [];
    for (const install of config.installs ?? []) {
      if (sameGamePath(install.path, active.path)) continue;
      const label = syncLabelOf(install);
      const realm = realmOfInstall(install);
      const theirs = catalogRecordsOn(install.path);
      const theirEntryIds = new Set<string>();
      for (const r of theirs) {
        const e = entryOfRecord(r);
        if (e) theirEntryIds.add(e.id);
      }
      // Missing applicable mods (presence-level match: a folded
      // family's other scheme counts as present — the reconcile never
      // re-picks schemes). Preset carried over from the active record,
      // legacy folded ids mapped onto their scheme.
      const installs = [...activeEntries.entries()]
        .filter(([e]) => appliesToRealm(e, realm) && !theirEntryIds.has(e.id))
        .map(([e, r]) => ({
          entry: e,
          preset: r.preset ?? e.supersedes?.[r.id] ?? null,
        }));
      // Extra catalog mods the active set does not carry — by record id
      // (a record whose entry left the index uninstalls by id too).
      const uninstalls = theirs
        .filter((r) => {
          const e = entryOfRecord(r);
          return e ? !activeEntryIds.has(e.id) : !activeRecordIds.has(r.id);
        })
        .map((r) => ({ id: r.id, name: r.name }));
      clients.push({ install, label, installs, uninstalls });
    }
    if (clients.every((c) => c.installs.length === 0 && c.uninstalls.length === 0)) {
      toast.info(t("resources.sync.nothingToDo"));
      return;
    }
    syncAllAsk.value = {
      clients,
      totalInstalls: clients.reduce((n, c) => n + c.installs.length, 0),
      totalUninstalls: clients.reduce((n, c) => n + c.uninstalls.length, 0),
    };
  }

  /** Execute a confirmed plan: per client install-then-uninstall,
   *  sequentially (single-flight busy table), running clients skipped
   *  with a warning (Rust refuses writes into a live game tree), ONE
   *  end-of-run summary toast, then the full refresh pass. */
  async function doSyncAll(): Promise<void> {
    const plan = syncAllAsk.value;
    syncAllAsk.value = null;
    if (!plan || syncAllBusy.value) return;
    syncAllBusy.value = true;
    // Rows of every planned mod stay disabled for the whole run — the
    // shared busy table alone has gaps between per-mod RPCs. Markers are
    // added per id (not replacing the map) so a row fan-out concurrent
    // with this run keeps its own marker; only the planned ids are
    // dropped again in the finally below.
    for (const p of plan.clients) {
      for (const i of p.installs) fanOutBusy.value.set(i.entry.id, "install");
    }
    const failures: string[] = [];
    let okClients = 0;
    let attempted = 0;
    const skippedRunning: string[] = [];
    try {
      for (const p of plan.clients) {
        if (clientRunning(p.install.path)) {
          skippedRunning.push(p.label);
          continue;
        }
        attempted += 1;
        let ok = true;
        for (const item of p.installs) {
          // An op busy on another surface owns the item — that op's own
          // fan-out keeps the ledger honest; skip silently.
          if (pluginUpdates.itemBusy.has(item.entry.id)) continue;
          try {
            await pluginUpdates.runMod(
              item.entry.id,
              p.install.path,
              item.preset ?? undefined,
            );
          } catch (e) {
            ok = false;
            failures.push(
              `${p.label} · ${localized(item.entry).name || item.entry.nameEn}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        }
        for (const u of p.uninstalls) {
          try {
            await pluginUpdates.runModUninstall(u.id, p.install.path);
          } catch (e) {
            ok = false;
            failures.push(
              `${p.label} · ${u.name}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        if (ok) okClients += 1;
      }
    } finally {
      syncAllBusy.value = false;
      for (const p of plan.clients) {
        for (const i of p.installs) fanOutBusy.value.delete(i.entry.id);
      }
      if (attempted > 0) {
        if (failures.length === 0) {
          toast.success(t("resources.sync.done", { count: okClients }));
        } else if (okClients > 0) {
          toast.warning(
            t("resources.sync.partial", {
              ok: okClients,
              count: attempted,
              details: failureDetail(failures),
            }),
          );
        } else {
          toast.error(
            t("resources.sync.failed", {
              count: attempted,
              details: failureDetail(failures),
            }),
          );
        }
      }
      if (skippedRunning.length > 0) {
        toast.warning(
          t("resources.sync.skippedRunning", { names: skippedRunning.join(", ") }),
        );
      }
      await Promise.all([scan(), loadRecords(), pluginUpdates.syncFreshness()]);
    }
  }

  // Native folder picker (audit H-3): the picked path is the only
  // install source the backend accepts — a typed path never carries a
  // grant. Pick → fill the display field → run the same analyze flow.
  async function pickAndAnalyze() {
    if (analyzing.value) return;
    try {
      const picked = await api.modHubPickSource();
      if (!picked) return;
      sourcePath.value = picked;
    } catch (e) {
      planError.value = e instanceof Error ? e.message : String(e);
      return;
    }
    await analyze();
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
      const r = await api.modHubInstall(sourcePath.value.trim(), gameRoot.value);
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

  // ── Marketplace filtering: realm → big category → chips → query ──

  /** The ACTIVE client's realm (left-sidebar selection): the install's
   *  resolved realm, else its kind's home server, else null when the
   *  launcher says nothing about the region — a null realm never
   *  filters (an ambiguous client sees everything). */
  const activeRealm = computed(() => realmOfInstall(config.activeInstall));

  /** The online catalog filtered to entries applicable to the active
   *  client — the ONE source every list pipeline reads (rows, chip
   *  counts, search, big-category strips), composed with the delisted
   * filter at each consumer. Deep links tolerate inapplicable entries
   * (same as delisted): they open the pane, they just never list. */
  const applicableCatalog = computed(() =>
    catalog.value.filter((m) => appliesToRealm(m, activeRealm.value)),
  );

  const catalogInCat = computed(() =>
    listedEntries(applicableCatalog.value).filter(
      (m) => catBig(m.category) === bigCat.value,
    ),
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
    if (recordOfEntry(entry)) return null;
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
    if (recordOfEntry(paired)) return t("resources.pairedRelation.managed");
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
    // Entering an INSTALLED entry's pane lands the preset tabs on the
    // scheme that is actually installed — not the default first one
    // (which would read as a drifted config and arm save-&-reinstall).
    // A legacy record under a superseded id lands on its folded scheme.
    const rec = recordOfEntry(entry);
    selectedPreset.value = rec ? installedPresetOf(entry, rec) : "";
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
      ? listedEntries(applicableCatalog.value)
          .filter((m) => entryMatches(m, q))
          .slice(0, 12)
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
    recordsLoading,
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
    purgeAsk,
    purgeBusy,
    doPurgeReinstall,
    // ── multi-client sync ──
    /** The unified-sync preference (default on) + its toggle — the
     *  filter row's switch and the ⋯ menu entry both land here. */
    syncEnabled: modSyncState,
    toggleSync: modSync.toggleSync,
    syncIndividual,
    clientCount,
    activeInstall,
    syncAllAsk,
    syncAllBusy,
    openSyncAll,
    doSyncAll,
    toolsOpen,
    toolsAnchor,
    delistedHit,
    busy,
    gameRoot,
    pluginUpdates,
    // catalog / installed projections
    catalogInCat,
    applicableCatalog,
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
    recordOfEntry,
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
    pickAndAnalyze,
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
