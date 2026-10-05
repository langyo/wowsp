/**
 * Plugin freshness + one-click batch update — the model behind the
 * client-version selector's "插件可更新" marker and the ModUpdateToast
 * progress card.
 *
 * Freshness per game install is the union of two existing signals:
 * catalog mods whose ledger record version no longer matches the
 * catalog entry (versions are attributes, not labels — the UI never
 * shows them; a mismatch just means "update it"), plus the bundled
 * in-game probe plugin whose installed files no longer hash-match the
 * embedded payload (its version string is pinned, so bytes are the only
 * signal). Both update paths already exist Rust-side (mod_catalog_
 * install rewinds+reinstalls, ingame_plugin_install overwrites in
 * place); this store aggregates the signals and orchestrates them
 * sequentially, folding each install's wowsp://mod-catalog-progress
 * event into one overall percent for the toast card.
 */
import { useToast } from "@celestia-island/hikari";
import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type CatalogEntry, type ModInstallRecord } from "@/api";
import { t } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { sameGamePath } from "@/utils/gamePath";

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

export const usePluginUpdatesStore = defineStore("pluginUpdates", () => {
  const toast = useToast();
  const config = useConfigStore();

  /** Per-install snapshot; missing path = not assessed (quiet). */
  const perInstall = ref<Record<string, PluginUpdateInfo>>({});

  /** --- batch update run state (drives ModUpdateToast) ---------------- */
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

  /** Count for the ACTIVE install — what the sidebar marker shows. */
  const activeCount = computed(() => {
    const info = infoFor(config.activeInstall?.path);
    if (!info) return 0;
    return info.mods.length + (info.probeOutdated ? 1 : 0);
  });

  /**
   * Re-assess every known install. Catalog and records are shared per
   * call; the probe status is a per-install two-file hash. Catalog
   * offline (or any failure) leaves the previous snapshot in place —
   * freshness is advisory, never worth an error surface.
   */
  async function refresh(): Promise<void> {
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
   * One-click update for one install: the probe plugin first (local,
   * fast), then every outdated catalog mod sequentially — the disk side
   * serializes Rust-side anyway, and a single front-end queue keeps the
   * overall percent meaningful. Failures are collected and reported at
   * the end; the run always ends with a freshness re-assessment.
   */
  async function updateAll(gameRoot: string): Promise<void> {
    if (running.value) return;
    const info = infoFor(gameRoot);
    if (!info || (info.mods.length === 0 && !info.probeOutdated)) return;

    const tasks: { id: string | null; name: string; run: () => Promise<unknown> }[] = [];
    if (info.probeOutdated) {
      tasks.push({
        id: null,
        name: t("resources.pluginProbeName"),
        run: () => api.ingamePluginInstall(gameRoot),
      });
    }
    for (const m of info.mods) {
      tasks.push({
        id: m.id,
        name: m.name,
        run: () => api.modCatalogInstall(m.id, gameRoot, m.preset ?? undefined),
      });
    }

    running.value = true;
    total.value = tasks.length;
    done.value = 0;
    failures.value = [];
    let currentId: string | null = null;
    // The per-item catalog progress events fold into the overall percent.
    // Registered INSIDE the try (the updater-store precedent): a failed
    // listen just degrades the card to indeterminate — it must never
    // strand the pass with running=true.
    let unlisten: (() => void) | undefined;
    try {
      try {
        unlisten = await api.listenCatalogProgress?.((p) => {
          if (!running.value || p.id !== currentId) return;
          if (p.phase === "downloading") {
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
      void refresh();
    }
  }

  return {
    perInstall,
    running,
    total,
    done,
    currentName,
    phase,
    percent,
    overallPercent,
    failures,
    activeCount,
    infoFor,
    refresh,
    updateAll,
  };
});
