/**
 * Plugin freshness + the ONE update orchestration every surface shares —
 * the client-version selector's "插件可更新" marker and hover hint, the
 * ModUpdateToast progress card, the live page's plugin card (install /
 * update / uninstall) and the mod hub's per-mod rows all read THIS store.
 *
 * Freshness per game install is the union of two existing signals:
 * catalog mods whose ledger record version no longer matches the
 * catalog entry (versions are attributes, not labels — the UI never
 * shows them; a mismatch just means "update it"), plus the bundled
 * in-game probe plugin whose installed files no longer hash-match the
 * embedded payload (its version string is pinned, so bytes are the only
 * signal). Both update paths already exist Rust-side (mod_catalog_
 * install rewinds+reinstalls, ingame_plugin_install overwrites in
 * place); this store aggregates the signals and orchestrates every
 * mutation — single-item or the sequential all-installs batch — folding
 * each install's unified wowsp://download-progress ticks (kind
 * "mod-package") into one overall percent for the toast card.
 *
 * The shared part that makes the surfaces agree: one per-item busy table
 * (probe + mod ids) so an op started anywhere disables its item
 * everywhere else, single-flight per item against double installs, and
 * a post-op freshness fan-out (snapshot + live probe status) so a batch
 * pass updates the sidebar badge while the live card updates the badge
 * too — no surface is left believing a plugin is stale after any other
 * surface just refreshed it.
 */
import { useToast } from "@celestia-island/hikari";
import { defineStore } from "pinia";
import { computed, ref } from "vue";

import {
  api,
  type CatalogEntry,
  type GameInstall,
  type InstallReport,
  type ModInstallRecord,
  type UninstallReport,
} from "@/api";
import { t } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useIngamePluginStore } from "@/stores/ingamePlugin";
import { sameGamePath } from "@/utils/gamePath";
import { installFolderName, installLabel } from "@/utils/installLabel";

/** One outdated catalog mod awaiting its update run. */
export interface OutdatedMod {
  id: string;
  name: string;
  /** Install-time scheme to carry over the reinstall. */
  preset?: string | null;
}

/** Freshness snapshot for one game install (keyed by install path). */
export interface PluginUpdateInfo {
  mods: OutdatedMod[];
  probeOutdated: boolean;
}

/** One install's pending items plus the metadata needed to label it in
 *  the hint card and the batch pass (`install` is null when an assessed
 *  path no longer resolves to a detected install — the folder name
 *  stands in for the label then). */
export interface PendingInstall {
  path: string;
  install: GameInstall | null;
  info: PluginUpdateInfo;
}

/** The shared busy table's key for the built-in probe plugin. Namespaced
 *  so a remote catalog mod id can never collide into the probe's slot. */
export const PROBE_ITEM = "probe:builtin";

/** Lifecycle op an item is mid-way through. */
export type PluginItemOp = "install" | "update" | "uninstall";

export const usePluginUpdatesStore = defineStore("pluginUpdates", () => {
  const toast = useToast();
  const config = useConfigStore();

  /** Per-install snapshot; missing path = not assessed (quiet). */
  const perInstall = ref<Record<string, PluginUpdateInfo>>({});

  /** ── shared per-item busy table ────────────────────────────────────
   *  Probe (PROBE_ITEM) + catalog mod ids → the op in flight. Every
   *  mutating surface registers here, so a batch pass started from the
   *  sidebar hint disables the mod hub's row and the live page's plugin
   *  card, and an op started on those surfaces shows up here too. */
  const itemBusy = ref(new Map<string, PluginItemOp>());

  /** The probe's busy op, or null when idle — the live surfaces' cards
   *  derive their spinner from this, batch pass included. */
  const probeBusy = computed<PluginItemOp | null>(
    () => itemBusy.value.get(PROBE_ITEM) ?? null,
  );

  function itemOp(id: string): PluginItemOp | undefined {
    return itemBusy.value.get(id);
  }

  /** Register → run → unregister + the freshness fan-out. The fan-out
   *  runs on failure too: a failed install may have written partial
   *  files, so both signals re-assess from disk/catalog either way. */
  async function withItem<T>(key: string, op: PluginItemOp, run: () => Promise<T>): Promise<T> {
    if (itemBusy.value.has(key)) throw new Error(`plugin item busy: ${key}`);
    itemBusy.value.set(key, op);
    try {
      return await run();
    } finally {
      itemBusy.value.delete(key);
      void syncFreshness();
    }
  }

  /** ── batch update run state (drives ModUpdateToast) ---------------- */
  const running = ref(false);
  const total = ref(0);
  const done = ref(0);
  const currentName = ref("");
  /** `download | install | null(null = indeterminate)`. */
  const phase = ref<"download" | "install" | null>(null);
  /** Current item's percent 0-100, null while unknown (indeterminate). */
  const percent = ref<number | null>(null);
  /** Failed items of the last run ("{name}: {error}"). */
  const failures = ref<string[]>([]);

  /** Overall run percent for the toast card: (done + current item's
   *  fraction) / total; null whenever the current item's own percent is
   *  unknown — the card shows the indeterminate slide then. */
  const overallPercent = computed<number | null>(() => {
    if (!running.value || total.value === 0) return null;
    if (percent.value == null) return null;
    return Math.min(100, ((done.value + percent.value / 100) / total.value) * 100);
  });

  function infoFor(gameRoot: string | null | undefined): PluginUpdateInfo | null {
    if (!gameRoot) return null;
    for (const [path, info] of Object.entries(perInstall.value)) {
      if (sameGamePath(path, gameRoot)) return info;
    }
    return null;
  }

  /** Installs with at least one outdated item, ACTIVE install first and
   *  then settings order — the order the hint card groups them by and
   *  the batch pass updates them in. Paths match through sameGamePath
   *  (perInstall keys and config paths may differ in casing). */
  const pendingInstalls = computed<PendingInstall[]>(() => {
    const activePath = config.activeInstall?.path;
    const metaFor = (path: string): GameInstall | null => {
      if (activePath && sameGamePath(path, activePath)) return config.activeInstall;
      return config.installs.find((i) => sameGamePath(i.path, path)) ?? null;
    };
    const rankOf = (path: string): number => {
      if (activePath && sameGamePath(path, activePath)) return 0;
      let rank = 1;
      for (const i of config.installs) {
        if (sameGamePath(i.path, path)) return rank;
        rank += 1;
      }
      return Number.MAX_SAFE_INTEGER;
    };
    return Object.entries(perInstall.value)
      .filter(([, info]) => info.mods.length > 0 || info.probeOutdated)
      .map(([path, info]) => ({ path, install: metaFor(path), info }))
      .sort((a, b) => rankOf(a.path) - rankOf(b.path));
  });

  /** Total outdated items across EVERY install — the sidebar hint's badge.
   *  The one-click pass covers them all, so the marker counts them all. */
  const totalCount = computed(() =>
    pendingInstalls.value.reduce(
      (n, g) => n + g.info.mods.length + (g.info.probeOutdated ? 1 : 0),
      0,
    ),
  );

  // Assessments coalesce: a batch pass pokes one per item completion and
  // single ops poke their own — concurrent callers join the run in flight.
  // A joiner whose interest landed after that run's catalog read (its own
  // op's write is not covered by the joined snapshot) sets the dirty
  // flag, and exactly one trailing re-assessment follows the joined run,
  // so no op ever ends without an assessment started after it.
  let assessing: Promise<void> | null = null;
  let assessStale = false;

  /**
   * Re-assess every known install. Catalog and records are shared per
   * call; the probe status is a per-install two-file hash. Catalog
   * offline (or any failure) leaves the previous snapshot in place —
   * freshness is advisory, never worth an error surface.
   */
  async function refresh(): Promise<void> {
    if (assessing) {
      assessStale = true;
      return assessing;
    }
    assessing = doAssess().finally(() => {
      assessing = null;
      if (assessStale) {
        assessStale = false;
        void refresh();
      }
    });
    return assessing;
  }

  async function doAssess(): Promise<void> {
    const paths: string[] = [];
    for (const p of [config.activeInstall?.path, ...config.installs.map((i) => i.path)]) {
      if (p && !paths.some((q) => sameGamePath(q, p))) paths.push(p);
    }
    if (paths.length === 0) {
      perInstall.value = {};
      return;
    }
    let catalog: { mods: CatalogEntry[] };
    let records: ModInstallRecord[];
    try {
      [catalog, records] = await Promise.all([api.modCatalogRefresh(false), api.modHubRecords()]);
    } catch {
      return; // offline / cache unreadable — keep the last snapshot
    }
    const byId = new Map(catalog.mods.map((m) => [m.id, m]));
    const next: Record<string, PluginUpdateInfo> = {};
    await Promise.all(
      paths.map(async (path) => {
        // Legacy records carry no gameRoot and count for every install,
        // the same pairing rule the mod hub's own rows use.
        const mods: OutdatedMod[] = records
          .filter(
            (r) =>
              (!r.gameRoot || sameGamePath(r.gameRoot, path)) &&
              byId.get(r.id)?.version !== undefined &&
              byId.get(r.id)!.version !== r.version,
          )
          .map((r) => ({ id: r.id, name: r.name, preset: r.preset }));
        let probeOutdated = false;
        try {
          probeOutdated = !!(await api.ingamePluginStatus(path)).outdated;
        } catch {
          // probe not installed / unreadable — nothing to update
        }
        next[path] = { mods, probeOutdated };
      }),
    );
    perInstall.value = next;
  }

  /**
   * The post-mutation fan-out: re-assess freshness (sidebar badge, hint,
   * settings counts) AND re-probe the live surfaces' plugin status, so an
   * update started on any one surface is reflected on all the others
   * immediately — never only after the next poll or remount.
   */
  async function syncFreshness(): Promise<void> {
    await Promise.allSettled([refresh(), useIngamePluginStore().refresh()]);
  }

  /**
   * One probe-plugin lifecycle op — the single entry every surface uses
   * (the live idle card, the onboarding wizard, the boot prompt modal,
   * and the batch pass's probe step). Returns null on success, else the
   * error string/key for the caller's toast; "common.game.offline" also
   * covers a probe already busy elsewhere (same contract as before).
   */
  async function runProbe(gameRoot: string, op: PluginItemOp): Promise<string | null> {
    if (!gameRoot || probeBusy.value) return "common.game.offline";
    return withItem(PROBE_ITEM, op, async () => {
      try {
        if (op === "uninstall") await api.ingamePluginUninstall(gameRoot);
        else await api.ingamePluginInstall(gameRoot);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
  }

  /**
   * One catalog-mod install (fresh or update-over) — the single entry
   * for the mod hub's rows and the batch pass's mod steps. `op` only
   * flavors the shared busy table ("update" during a batch pass, so the
   * mod hub's rows spin for it too). Throws on failure (the mod hub
   * renders the message itself); single-flight per mod id via the
   * shared table.
   */
  function runMod(
    id: string,
    gameRoot: string,
    preset?: string | null,
    op: "install" | "update" = "install",
  ): Promise<InstallReport> {
    return withItem(id, op, () => api.modCatalogInstall(id, gameRoot, preset ?? undefined));
  }

  /**
   * One catalog-mod uninstall — mirrors runMod so the mod hub's remove
   * button shares the same busy table + freshness fan-out (the record
   * leaving the ledger un-stales the item everywhere).
   */
  function runModUninstall(id: string, gameRoot: string): Promise<UninstallReport> {
    return withItem(id, "uninstall", () => api.modCatalogUninstall(id, gameRoot));
  }

  /**
   * One-click update across EVERY pending install: per install the probe
   * plugin first (local, fast), then its outdated catalog mods — installs
   * run sequentially too, and a single front-end queue keeps the overall
   * percent meaningful. Task names carry the client label ("mod-a ·
   * Steam · ASIA") whenever more than one install is pending, so the
   * progress card and the failure toast read unambiguously on
   * multi-client machines. The install whose client is RUNNING is
   * skipped up front — Rust refuses writes into a live game tree, so
   * attempting it would only surface a raw backend refusal — and gets a
   * dedicated warning toast instead. Items already busy on another
   * surface are skipped (that op's own fan-out keeps the snapshot
   * honest). Failures are collected and reported at the end; every
   * item's completion fans out a freshness sync, so the badge ticks
   * down while the pass runs.
   */
  async function updateAll(): Promise<void> {
    if (running.value) return;
    const groups = pendingInstalls.value;
    if (groups.length === 0) return;

    const multi = groups.length > 1;
    // Multi-instance: EVERY running client's tree is write-locked by its
    // own process (the backend refuses res_mods work per running root), so
    // all of them skip — not just the watched one.
    const { processes } = useGameStatusStore();
    const runningPaths = processes
      .filter((p) => p.running)
      .map((p) => p.matchedInstall?.path ?? null)
      .filter((p): p is string => p != null);

    const tasks: { id: string | null; name: string; run: () => Promise<unknown> }[] = [];
    let skipped = 0;
    const skippedClients: string[] = [];
    for (const g of groups) {
      const label = installLabel(g.install?.kind, g.install?.realm) || installFolderName(g.path);
      if (runningPaths.some((path) => sameGamePath(g.path, path))) {
        skipped += g.info.mods.length + (g.info.probeOutdated ? 1 : 0);
        if (!skippedClients.includes(label)) skippedClients.push(label);
        continue;
      }
      const suffix = multi ? ` · ${label}` : "";
      if (g.info.probeOutdated && !probeBusy.value) {
        tasks.push({
          id: null,
          name: t("resources.pluginProbeName") + suffix,
          run: async () => {
            // Another surface (live page, onboarding) may have grabbed
            // the probe between task build and its queue turn — that op
            // updates it and fans out its own sync, so skip silently
            // instead of recording its refusal as a false failure.
            if (probeBusy.value) return;
            const err = await runProbe(g.path, "update");
            if (err) throw new Error(err);
          },
        });
      }
      for (const m of g.info.mods) {
        if (itemBusy.value.has(m.id)) continue;
        tasks.push({
          id: m.id,
          name: m.name + suffix,
          run: async () => {
            // A mod-hub install may have grabbed this id between task
            // build and its turn in the queue — that op updates it and
            // fans out its own sync, so skip silently instead of
            // reporting a false failure for a mod that is, in fact,
            // freshly updated.
            if (itemBusy.value.has(m.id)) return;
            await runMod(m.id, g.path, m.preset ?? undefined, "update");
          },
        });
      }
    }

    function reportSkipped(): void {
      if (skipped > 0) {
        toast.warning(
          t("resources.pluginUpdateSkipped", {
            count: skipped,
            names: skippedClients.join(", "),
          }),
        );
      }
    }

    if (tasks.length === 0) {
      reportSkipped();
      void syncFreshness();
      return;
    }

    running.value = true;
    total.value = tasks.length;
    done.value = 0;
    failures.value = [];
    let currentId: string | null = null;
    // The per-item unified download-progress ticks (kind "mod-package")
    // fold into the overall percent. Registered INSIDE the try (the
    // updater-store precedent): a failed listen just degrades the card to
    // indeterminate — it must never strand the pass with running=true.
    let unlisten: (() => void) | undefined;
    try {
      try {
        unlisten = api.listenDownloadProgress?.((p) => {
          if (!running.value || p.kind !== "mod-package" || p.id !== currentId) return;
          if (p.phase === "download") {
            phase.value = "download";
            percent.value =
              p.total > 0
                ? Math.min(100, Math.round((p.received / p.total) * 100))
                : null;
          } else if (p.phase === "installing") {
            phase.value = "install";
            percent.value = 100;
          }
        });
      } catch {
        // A failed listen only degrades the card to indeterminate — the
        // pass itself must still run.
      }
      for (const task of tasks) {
        currentId = task.id;
        currentName.value = task.name;
        phase.value = null; // probe phase / pre-first-event — indeterminate
        percent.value = null;
        try {
          await task.run();
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          failures.value.push(`${task.name}: ${detail}`);
        }
        done.value += 1;
      }
    } finally {
      unlisten?.();
      currentId = null;
      running.value = false;
      phase.value = null;
      percent.value = null;
      currentName.value = "";
      if (failures.value.length > 0) {
        toast.error(
          t("resources.pluginUpdateFailed", {
            count: failures.value.length,
            names: failures.value.join(", "),
          }),
        );
      }
      reportSkipped();
      void syncFreshness();
    }
  }

  return {
    perInstall,
    itemBusy,
    probeBusy,
    running,
    total,
    done,
    currentName,
    phase,
    percent,
    overallPercent,
    failures,
    pendingInstalls,
    totalCount,
    infoFor,
    itemOp,
    refresh,
    syncFreshness,
    runProbe,
    runMod,
    runModUninstall,
    updateAll,
  };
});
