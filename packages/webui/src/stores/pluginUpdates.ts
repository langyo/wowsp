/**
 * Plugin freshness + the ONE update orchestration every surface shares —
 * the client-version selector's "插件可更新" marker and hover hint, the
 * shared download card, the live page's plugin card (install /
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
 * "mod-package") into ONE overall percent — and pushes that percent onto the
 * shared download context (stores/downloads, `mod-package` as an
 * owner-sourced pass), so the batch renders on the same top-right card every
 * other download uses instead of a bespoke one.
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
import { t, tError } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { DOWNLOAD_CARD_GRACE_MS, useDownloadsStore } from "@/stores/downloads";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useIngamePluginStore } from "@/stores/ingamePlugin";
import { normalizeGamePath, sameGamePath } from "@/utils/gamePath";
import { installFolderName, installLabel } from "@/utils/installLabel";
import { guardRefusalKey } from "@/utils/refusalKey";

/** One outdated catalog mod awaiting its update run. */
export interface OutdatedMod {
  id: string;
  name: string;
  /** Install-time scheme to carry over the reinstall. */
  preset?: string | null;
  /** Catalog version the record is paired against — the version-scope of
   *  the capability-skip memo (a catalog update re-offers the pack). */
  catalogVersion?: string;
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

/** Mount grace of the SHARED pass card (DownloadToast, DOWNLOAD_CARD_GRACE_MS
 *  in stores/downloads). Re-exported because the batch's fast-pass outcome
 *  branches on it: a full success inside the grace gets the light success
 *  toast instead of the card's leave snapshot as its only visible trace. */
export const MOD_PASS_CARD_GRACE_MS = DOWNLOAD_CARD_GRACE_MS;

/** How many failed items a multi-client summary spells out before folding
 *  the rest into a "+N" tail. The toast body clamps to three lines, so the
 *  detail must stay short; the sticky all-failed error is copyable, and its
 *  fold still names the count of the items left out (the pass's
 *  `failures` ref keeps the complete list). */
export const SUMMARY_FAILURE_LIMIT = 3;

/** Capped per-item failure fold for the multi-client summary toasts: the
 *  first `limit` "{name}: {error}" items joined with "; ", plus a "; +N"
 *  tail when the list is longer. The single-client message keeps the full
 *  list — this cap only serves the multi-client rollup, which used to drop
 *  the concrete errors entirely and name the failed clients alone. */
export function failureDetail(
  failures: readonly string[],
  limit = SUMMARY_FAILURE_LIMIT,
): string {
  if (failures.length <= limit) return failures.join("; ");
  return `${failures.slice(0, limit).join("; ")}; +${failures.length - limit}`;
}

/** Lifecycle op an item is mid-way through. */
export type PluginItemOp = "install" | "update" | "uninstall";

/** localStorage key of the capability-skip memo (the store's
 *  `incompatibleSkips`). Shape: `{ [normalizedInstallPath\u0000modId]:
 *  { version, reason } }` — the in-memory memo serialized verbatim, so a
 *  corrupt or foreign payload degrades to an empty memo, never to a wrong
 *  park. */
const INCOMPATIBLE_SKIPS_KEY = "wowsp-plugin-updates-incompatible-skips";

/** One memo row as persisted. */
interface IncompatibleSkipMemo {
  version: string;
  reason: string;
}

/** Read the persisted memo. Any surprise (storage unavailable, corrupt
 *  JSON, wrong row shape) degrades to an empty memo — the next rule skip
 *  re-fills it, so nothing user-visible depends on the read succeeding. */
function loadIncompatibleSkips(): Map<string, IncompatibleSkipMemo> {
  const memo = new Map<string, IncompatibleSkipMemo>();
  try {
    const raw = localStorage.getItem(INCOMPATIBLE_SKIPS_KEY);
    if (!raw) return memo;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return memo;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const row = value as Partial<IncompatibleSkipMemo>;
      if (typeof row.version !== "string" || typeof row.reason !== "string") continue;
      memo.set(key, { version: row.version, reason: row.reason });
    }
  } catch {
    // storage unavailable (privacy mode) or a corrupt payload — start
    // empty; the memo re-fills on the next skip
  }
  return memo;
}

export const usePluginUpdatesStore = defineStore("pluginUpdates", () => {
  const toast = useToast();
  const config = useConfigStore();

  /** Per-install snapshot; missing path = not assessed (quiet). */
  const perInstall = ref<Record<string, PluginUpdateInfo>>({});

  /** Memo of capability-gate skips: "this client cannot run that pack"
   *  (the package needs font assets the client does not ship). Keyed by
   *  install path + mod id and version-scoped, so the pending badge and
   *  every later batch stop offering an update that can only re-skip — and
   *  a catalog update (new pack version) re-offers it once more. An
   *  explicit attempt through [`runMod`] retries immediately. The memo is
   *  PERSISTENT (localStorage): a session-only memo re-offered the same
   *  hopeless update on every app start and only cleared after the user
   *  clicked through the identical skip toast once more — the badge kept
   *  counting an update that could never land (user report 2026-11-20).
   *  Dead rows (the pack moved on, the record left) are pruned by every
   *  assessment, so the persisted payload never grows stale. */
  const incompatibleSkips = ref(loadIncompatibleSkips());

  /** Write the memo through to localStorage. A failure (storage
   *  unavailable, quota) keeps the in-memory memo — the park then lives
   *  for this session only, exactly the pre-persistence behavior, and is
   *  never worth an error surface. */
  function persistIncompatibleSkips(): void {
    try {
      localStorage.setItem(
        INCOMPATIBLE_SKIPS_KEY,
        JSON.stringify(Object.fromEntries(incompatibleSkips.value)),
      );
    } catch {
      // session-only memo on failure
    }
  }

  /** Drop memo rows that no longer park anything: a row matters only while
   *  the SAME pack version is still pending on that install — a catalog
   *  update re-offers the pack by design, and an uninstalled record has
   *  nothing left to hide. Runs on every assessment, so the persisted
   *  payload never accumulates dead rows across restarts. */
  function pruneIncompatibleSkips(next: Record<string, PluginUpdateInfo>): void {
    const live = new Set<string>();
    for (const [path, info] of Object.entries(next)) {
      for (const m of info.mods) {
        const key = incompatibleSkipKey(path, m.id);
        const hit = incompatibleSkips.value.get(key);
        if (hit && hit.version === (m.catalogVersion ?? "")) live.add(key);
      }
    }
    if (live.size === incompatibleSkips.value.size) return;
    for (const key of [...incompatibleSkips.value.keys()]) {
      if (!live.has(key)) incompatibleSkips.value.delete(key);
    }
    persistIncompatibleSkips();
  }

  /** Park one capability-gate skip: the memo row hides the pack from the
   *  badge and from later batches until the pack version moves (or an
   *  explicit [`runMod`] attempt clears it). The one-click batch AND the
   *  mod hub's fan-out install both route their rule skips through here,
   *  so every skip path parks consistently — a fan-out attempt first
   *  CLEARS the memo row ([`runMod`]), and without this the badge would
   *  rise again right after the user watched it skip. */
  function parkIncompatibleSkip(
    path: string,
    id: string,
    catalogVersion: string | undefined,
    reason: string,
  ): void {
    incompatibleSkips.value.set(incompatibleSkipKey(path, id), {
      version: catalogVersion ?? "",
      reason,
    });
    persistIncompatibleSkips();
  }

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

  /** ── batch update run state (drives the shared download card) ───────── */
  const downloads = useDownloadsStore();
  const running = ref(false);
  const total = ref(0);
  const done = ref(0);
  const currentName = ref("");
  /** `download | install | null(null = indeterminate)`. */
  const phase = ref<"download" | "install" | null>(null);
  /** Current item's percent 0-100, null while unknown (indeterminate). */
  const percent = ref<number | null>(null);
  /** Current item's smoothed transfer rate (bytes/sec), null while there is
   *  no live sample — the shared card's always-visible meta renders it
   *  through formatSpeed exactly like every other context. mod_catalog sends
   *  speedBps 0 on its own phase transitions, so 0 must read as "no
   *  sample" or the text would stick to the last rate. */
  const speedBps = ref<number | null>(null);
  /** Failed items of the last run ("{name}: {error}"). */
  const failures = ref<string[]>([]);

  /** Overall run percent for the shared card: (done + current item's
   *  fraction) / total; null whenever the current item's own percent is
   *  unknown — the card shows the indeterminate slide then. */
  const overallPercent = computed<number | null>(() => {
    if (!running.value || total.value === 0) return null;
    if (percent.value == null) return null;
    return Math.min(100, ((done.value + percent.value / 100) / total.value) * 100);
  });

  /** Push the batch's current numbers onto the shared pass. The context's
   *  `mod-package` row is owner-sourced: it never folds raw per-file ticks
   *  (several artifacts sit behind this one percent), so this is the only
   *  writer of its numbers. */
  function publishPass(): void {
    if (!running.value) return;
    downloads.report("mod-package", {
      phase: phase.value ?? "download",
      step: t("resources.pluginUpdateStep", {
        name: currentName.value,
        done: done.value + 1,
        total: total.value,
      }),
      percent: overallPercent.value,
      speedBps: speedBps.value ?? 0,
    });
  }

  /** Memo key: install path + mod id (the store's two-level identity).
   *  The path goes through the FULL install-path normalization (not just a
   *  lowercase) so a "/" vs "\\" spelling change between launches cannot
   *  orphan a parked row — the memo now outlives the session, and the key
   *  must outlive the exact spelling it was parked under. */
  function incompatibleSkipKey(path: string, id: string): string {
    return `${normalizeGamePath(path)}\u0000${id}`;
  }

  function clearIncompatibleSkip(gameRoot: string, id: string): void {
    let removed = false;
    for (const key of [...incompatibleSkips.value.keys()]) {
      const [path, modId] = key.split("\u0000");
      if (modId === id && sameGamePath(path, gameRoot)) {
        incompatibleSkips.value.delete(key);
        removed = true;
      }
    }
    if (removed) persistIncompatibleSkips();
  }

  /** Whether this pending mod was parked by a capability skip for the SAME
   *  catalog version (a newer pack re-offers it). */
  function incompatibleSkippedFor(path: string, mod: OutdatedMod): boolean {
    const hit = incompatibleSkips.value.get(incompatibleSkipKey(path, mod.id));
    return hit != null && hit.version === (mod.catalogVersion ?? "");
  }

  function infoFor(gameRoot: string | null | undefined): PluginUpdateInfo | null {
    if (!gameRoot) return null;
    for (const [path, info] of Object.entries(perInstall.value)) {
      if (sameGamePath(path, gameRoot)) {
        // A parked capability skip is not an update opportunity on ANY
        // surface (sidebar hint, settings row badge): keep the badge math
        // consistent with pendingInstalls.
        return { ...info, mods: info.mods.filter((m) => !incompatibleSkippedFor(path, m)) };
      }
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
      .map(([path, info]) => ({
        path,
        install: metaFor(path),
        info: {
          ...info,
          // A parked capability skip is not an update opportunity: keeping it
          // would leave a badge that can never clear and re-attempt the same
          // hopeless install on every click.
          mods: info.mods.filter((m) => !incompatibleSkippedFor(path, m)),
        },
      }))
      .filter(({ info }) => info.mods.length > 0 || info.probeOutdated)
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
    // Folded style families: a ledger record may sit under a legacy
    // one-entry-per-variant id (`battle.panel.ttaro`…) — pair it with
    // the folded entry through `supersedes` (old id → preset id), the
    // same rule the mod hub's own rows use, so update badges and the
    // batch pass keep covering pre-fold installs. The resolved entry's
    // id is what the update installs, with the mapped scheme carried
    // over so an update stays on the installed style.
    const entryOfRecord = (r: ModInstallRecord): CatalogEntry | undefined => {
      const direct = byId.get(r.id);
      if (direct) return direct;
      return catalog.mods.find((m) => m.supersedes?.[r.id] !== undefined);
    };
    const next: Record<string, PluginUpdateInfo> = {};
    await Promise.all(
      paths.map(async (path) => {
        // Legacy records carry no gameRoot and count for every install,
        // the same pairing rule the mod hub's own rows use.
        const mods: OutdatedMod[] = [];
        for (const r of records) {
          if (!(!r.gameRoot || sameGamePath(r.gameRoot, path))) continue;
          const entry = entryOfRecord(r);
          if (!entry || entry.version === r.version) continue;
          // Two legacy variant records of one family resolve to the same
          // entry — one update step per entry, first record wins.
          if (mods.some((m) => m.id === entry.id)) continue;
          mods.push({
            id: entry.id,
            name: r.name,
            preset: r.preset ?? entry.supersedes?.[r.id] ?? null,
            catalogVersion: entry.version,
          });
        }
        let probeOutdated = false;
        try {
          probeOutdated = !!(await api.ingamePluginStatus(path)).outdated;
        } catch {
          // probe not installed / unreadable — nothing to update
        }
        next[path] = { mods, probeOutdated };
      }),
    );
    pruneIncompatibleSkips(next);
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

  /** Whether any running client belongs to `gameRoot` — the mod hub's
   *  multi-instance rule without its toast (a running process whose folder
   *  is unknown blocks conservatively; a client on a DIFFERENT install does
   *  not). */
  function targetClientRunning(root: string): boolean {
    const roots = useGameStatusStore().processes
      .filter((p) => p.running)
      .map((p) => p.matchedInstall?.path ?? null);
    if (roots.length === 0) return false;
    return roots.some((r) => r == null || sameGamePath(root, r));
  }

  /**
   * One probe-plugin lifecycle op — the single entry every surface uses
   * (the live idle card, the onboarding wizard, the boot prompt modal,
   * and the batch pass's probe step). Returns null on success, else the
   * error string/key for the caller's toast; "common.game.offline" also
   * covers a probe already busy elsewhere (same contract as before).
   *
   * The backend's guard refusals (safe mode, running client) are English
   * anyhow sentences; both are pre-checked here so the same key-or-raw
   * contract every caller's toast already uses resolves them through
   * tError to the localized line instead of showing the sentence raw. A
   * stale game-status snapshot can still let the real guard through, so
   * the catch maps the two known sentences too (guardRefusalKey).
   */
  async function runProbe(gameRoot: string, op: PluginItemOp): Promise<string | null> {
    if (!gameRoot || probeBusy.value) return "common.game.offline";
    const safeMode = await api.modHubSafeMode(gameRoot).catch(() => false);
    if (safeMode) return "resources.safeModeBlock";
    if (targetClientRunning(gameRoot)) return "resources.gameRunningBlock";
    // The pre-checks above await, so the early busy test is no longer
    // atomic: two near-simultaneous calls can both pass it and race into
    // withItem, whose single-flight throw would reject the loser — callers
    // only understand the key contract. Re-check synchronously with no
    // await in between, so the loser returns the documented key instead.
    if (probeBusy.value) return "common.game.offline";
    return withItem(PROBE_ITEM, op, async () => {
      try {
        if (op === "uninstall") await api.ingamePluginUninstall(gameRoot);
        else await api.ingamePluginInstall(gameRoot);
        return null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return guardRefusalKey(msg) ?? msg;
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
    skipIncompatible?: boolean,
    skipPackageIncompatible?: boolean,
  ): Promise<InstallReport> {
    // An explicit attempt (the user picked this client/row) retries a pack
    // the capability memo parked — persistently, so the row leaves storage
    // here, not just for this session.
    clearIncompatibleSkip(gameRoot, id);
    return withItem(id, op, () =>
      api.modCatalogInstall(
        id,
        gameRoot,
        preset ?? undefined,
        skipIncompatible,
        skipPackageIncompatible,
      ),
    );
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
   * Fold one successful batch item into the LOCAL snapshot at once — the
   * badge, hint and pin react on the next tick instead of after the
   * freshness re-assessment's network round-trip (its catalog digest
   * check alone can stall for seconds), which still runs and confirms.
   * The ledger/probe writes behind a resolved task are already durable
   * Rust-side, so "fresh" is the truth here, not a guess. `path` is the
   * exact perInstall key the task group came from; `id` null = the probe.
   */
  function markItemFresh(path: string, id: string | null): void {
    const info = perInstall.value[path];
    if (!info) return;
    if (id === null) {
      info.probeOutdated = false;
    } else {
      info.mods = info.mods.filter((m) => m.id !== id);
    }
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
   * honest), and so is a NON-ACTIVE client the pack needs font assets from
   * that it does not ship (the backend's package-capability gate: quiet
   * note, never a failure, the item is parked persistently so the badge
   * stops re-offering it across restarts too — the active install keeps
   * the hard refusal because the user chose it). Every successful item folds into the local snapshot at once
   * (markItemFresh — the badge ticks down while the pass runs, clearing
   * the moment the last item lands) and still fans out a freshness sync
   * that confirms against catalog/ledger. The end-of-pass toast speaks
   * per client when several were attempted: all updated → success with
   * the client count, a mixed run → warning naming the failed clients PLUS
   * a capped fold of the failed items (failureDetail), none updated →
   * sticky error carrying the same detail; a single client keeps the
   * per-item failure detail it always had.
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

    const tasks: {
      id: string | null;
      path: string;
      name: string;
      /** True when the item actually LANDED; false when it was silently
       *  skipped (a concurrent op owns it, or the batch's package-capability
       *  gate skipped it) — a skip is neither a success nor a failure. */
      run: () => Promise<boolean>;
    }[] = [];
    let skipped = 0;
    const skippedClients: string[] = [];
    /** Attempted groups only (running-game skips never enter) — the
     *  per-client rollup behind the end-of-pass summary toast. */
    const clientLabels = new Map<string, string>();
    /** Clients (perInstall keys) with at least one failed task. */
    const failedPaths = new Set<string>();
    /** Items a NON-ACTIVE client's package-capability gate skipped. The
     *  batch names them together at the end: a rule skip, never a failure,
     *  and the memo keeps them out of the badge until the pack or client
     *  changes. */
    const incompatibleSkipped: { mod: string; client: string }[] = [];
    // Capability gate: only the ACTIVE install keeps the hard refusal — the
    // user chose THAT client, so the integrity gate's "refusing to install"
    // answer is theirs to see. Every other target was chosen by the batch,
    // and a pack whose glue loads font assets the client does not ship (a
    // foreign-lineage client's own font family set) is reported as a quiet
    // rule skip there instead. The VERSION range is NOT a gate here: these
    // are per-client own-ledger updates, and a lagging WG client (e.g. CN on
    // 15.9 while the catalog targets 15.10) must keep updating normally.
    // With NO active install there is no chosen client to privilege: every
    // target keeps the hard refusal.
    const activePath = config.activeInstall?.path ?? "";
    const activeTarget = (path: string) => !activePath || sameGamePath(path, activePath);
    /** Clients with at least one LANDED item — the honest "updated" set:
     *  capability-skipped items are neither failures nor successes. */
    const landedPaths = new Set<string>();
    for (const g of groups) {
      const label = installLabel(g.install?.kind, g.install?.realm) || installFolderName(g.path);
      if (runningPaths.some((path) => sameGamePath(g.path, path))) {
        skipped += g.info.mods.length + (g.info.probeOutdated ? 1 : 0);
        if (!skippedClients.includes(label)) skippedClients.push(label);
        continue;
      }
      clientLabels.set(g.path, label);
      const suffix = multi ? ` · ${label}` : "";
      if (g.info.probeOutdated && !probeBusy.value) {
        tasks.push({
          id: null,
          path: g.path,
          name: t("resources.pluginProbeName") + suffix,
          run: async () => {
            // Another surface (live page, onboarding) may have grabbed
            // the probe between task build and its queue turn — that op
            // updates it and fans out its own sync, so skip silently
            // instead of recording its refusal as a false failure.
            if (probeBusy.value) return false;
            const err = await runProbe(g.path, "update");
            // runProbe's own refusals are KEYS (safe mode, running client);
            // the batch failure summary must render the localized line, not
            // the raw key path. Raw backend sentences pass through unchanged.
            if (err) throw new Error(tError(err));
            return true;
          },
        });
      }
      for (const m of g.info.mods) {
        if (itemBusy.value.has(m.id)) continue;
        tasks.push({
          id: m.id,
          path: g.path,
          name: m.name + suffix,
          run: async () => {
            // A mod-hub install may have grabbed this id between task
            // build and its turn in the queue — that op updates it and
            // fans out its own sync, so skip silently instead of
            // reporting a false failure for a mod that is, in fact,
            // freshly updated.
            if (itemBusy.value.has(m.id)) return false;
            // Capability gate: this client was chosen by the batch, not by
            // the user. A package whose glue loads font assets the client
            // does not ship answers report.skipped (the download/extract is
            // already done, but nothing is written — the gate runs before the
            // rewind). Rule skip, never a failure; the memo parks it so the
            // badge stops re-offering it (persistently — across restarts).
            const report = await runMod(
              m.id,
              g.path,
              m.preset ?? undefined,
              "update",
              undefined,
              !activeTarget(g.path),
            );
            if (report.skipped) {
              parkIncompatibleSkip(g.path, m.id, m.catalogVersion, report.skipped);
              incompatibleSkipped.push({ mod: m.name, client: label });
              return false;
            }
            return true;
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

    /** The total-failure verdict: sticky (duration 0 = no auto-dismiss,
     *  copyable) so an unreadable flash can't read as "the click did
     *  nothing". Retire any live error slot FIRST: hikari's push() only
     *  takes the duration when it CREATES the slot, so a sticky show into
     *  an existing 30 s slot would ride the old timer and take the whole
     *  verdict down with it (the common sequence is exactly a prior
     *  per-surface toast.error, e.g. the plugin card's refusal). */
    function showStickyError(text: string): void {
      const prior = toast.toasts.find((s) => s.type === "error");
      if (prior) toast.remove(prior.id);
      toast.show(text, { type: "error", duration: 0, copyable: true });
    }

    if (tasks.length === 0) {
      reportSkipped();
      // The remaining silent shape: nothing skipped-by-running-game, yet
      // no task either — every pending item is mid-op on another surface
      // (busy table). Without this the click is a total no-op (user
      // report 2026-10-17): no backend command, no log line, no toast.
      if (skipped === 0) {
        toast.info(t("resources.pluginUpdateBusyElsewhere"));
      }
      void syncFreshness();
      return;
    }

    running.value = true;
    const startedAt = Date.now();
    total.value = tasks.length;
    done.value = 0;
    failures.value = [];
    // Raise the SHARED pass (the same top-right card every other download
    // uses) and push the batch's numbers onto it as they move.
    downloads.begin("mod-package");
    publishPass();
    let currentId: string | null = null;
    // The per-item unified download-progress ticks (kind "mod-package")
    // fold into the overall percent. Registered INSIDE the try (the
    // updater-store precedent): a failed listen just degrades the card to
    // indeterminate — it must never strand the pass with running=true.
    let unlisten: (() => void) | undefined;
    try {
      try {
        // Raw per-item ticks come through the download CONTEXT's single
        // transport listener (this store never binds one of its own).
        unlisten = downloads.onTick("mod-package", (p) => {
          if (!running.value || p.id !== currentId) return;
          if (p.phase === "download") {
            phase.value = "download";
            percent.value =
              p.total > 0
                ? Math.min(100, Math.round((p.received / p.total) * 100))
                : null;
            // bytes/sec EWMA from the unified bus; 0 = no sample yet.
            speedBps.value = p.speedBps > 0 ? p.speedBps : null;
          } else if (p.phase === "installing") {
            phase.value = "install";
            percent.value = 100;
            // The streaming half is over — the meta shows the install verb.
            speedBps.value = null;
          }
          publishPass();
        });
      } catch {
        // A failed subscribe only degrades the card to indeterminate — the
        // pass itself must still run.
      }
      for (const task of tasks) {
        currentId = task.id;
        currentName.value = task.name;
        phase.value = null; // probe phase / pre-first-event — indeterminate
        percent.value = null;
        speedBps.value = null; // never carry the previous item's rate
        publishPass();
        try {
          const landed = await task.run();
          if (landed) {
            // The write landed — drop it from the badge now; the post-item
            // freshness sync only confirms. A skip (concurrent op or package
            // capability) deliberately keeps the item pending.
            landedPaths.add(task.path);
            markItemFresh(task.path, task.id);
          }
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          // Catalog-mod items have no frontend guard pre-check, so a
          // backend guard sentence reaches this catch raw — localize the
          // two known ones before folding the item into the summary.
          // Probe items already speak the key contract (runProbe), so this
          // is idempotent for them; unknown errors stay verbatim.
          const key = guardRefusalKey(detail);
          failures.value.push(`${task.name}: ${key ? t(key) : detail}`);
          failedPaths.add(task.path);
        }
        done.value += 1;
        publishPass();
      }
    } finally {
      unlisten?.();
      currentId = null;
      running.value = false;
      // Settle the shared pass BEFORE the outcome toasts below so the card
      // folds out with the pass's real numbers while they arrive.
      // The pass settles NEUTRAL: the batch's verdict (sticky refusal, partial
      // warning, success toast) is this store's to speak, and a card stuck on
      // "failed" would compete with the copyable error it just raised.
      downloads.settle("mod-package", null);
      phase.value = null;
      percent.value = null;
      speedBps.value = null;
      currentName.value = "";
      // A client counts as updated only when EVERY one of its tasks
      // landed; a single failure marks the whole client for the summary.
      // A client that contributed NO task (its every item was already
      // busy on another surface at build) stays out of the rollup — the
      // outcome is that op's story to tell, not this pass's to claim.
      const attempted = [...clientLabels.entries()].filter(
        ([path]) =>
          tasks.some((task) => task.path === path)
          && (landedPaths.has(path) || failedPaths.has(path)),
      );
      const multiClients = attempted.length > 1;
      const failedClients = attempted
        .filter(([path]) => failedPaths.has(path))
        .map(([, label]) => label);
      // "Updated" = the client landed at least one item and nothing failed.
      // A client every item of which the capability gate skipped was neither
      // updated nor refused — its quiet note below is the whole story, and it
      // stays out of BOTH rollup sides.
      const okClients = attempted.filter(
        ([path]) => landedPaths.has(path) && !failedPaths.has(path),
      ).length;
      if (failures.value.length > 0) {
        // Multi-client summaries carry the concrete failed items too — the
        // client names alone left the user unable to tell WHY a plugin
        // stayed stale (the backend bug's silent failures hid behind this
        // gap). Capped: the detail is folded into the copyable sticky error
        // and the auto-dismissing warning alike.
        const detail = failureDetail(failures.value);
        if (multiClients && okClients === 0) {
          // Every client was refused — typically the guard-refusal shape
          // (safe mode, permissions) that dies in well under a second
          // with the progress card never mounting, so this toast is then
          // the ONLY surface the rejection reaches. Sticky (duration 0 =
          // no auto-dismiss, copyable) per the single-client rationale
          // below.
          showStickyError(
            t("resources.pluginUpdateAllFailedClientsDetail", {
              // Skipped clients were not refused — name only the failures.
              count: failedClients.length,
              details: detail,
            }),
          );
        } else if (multiClients) {
          // Mixed machine: some work DID land — a warning (auto-dismiss)
          // reporting the success count plus the failed clients' names.
          toast.warning(
            t("resources.pluginUpdatePartialClientsDetail", {
              ok: okClients,
              names: failedClients.join("/"),
              details: detail,
            }),
          );
        } else {
          const text = t("resources.pluginUpdateFailed", {
            count: failures.value.length,
            names: failures.value.join(", "),
          });
          if (failures.value.length === tasks.length) {
            // Every single item was refused (guard-class outcome: a
            // running client, safe mode) — the pass died in well under a
            // second and the progress card never mounts, so this toast is
            // the ONLY surface the rejection ever reaches. Make it sticky
            // (duration 0 = no auto-dismiss, copyable) instead of the 30 s
            // default: an unreadable flash read as "the click did
            // nothing" (user report 2026-10-18).
            showStickyError(text);
          } else {
            toast.error(text);
          }
        }
      } else if (
        landedPaths.size > 0
        && Date.now() - startedAt < MOD_PASS_CARD_GRACE_MS
      ) {
        // A pass that finished INSIDE the card's mount grace leaves no
        // visible trace at all (the card never mounted; success normally
        // speaks through the card's leave snapshot). The fast full-success
        // shape — a probe-only local write — is common, so it gets the
        // light success toast; anything slower keeps the card feedback.
        // Multi-client passes name the client count, not a bare "done".
        toast.success(
          multiClients
            ? t("resources.pluginUpdateDoneClients", { count: okClients })
            : t("resources.pluginUpdateDone"),
        );
      }
      if (incompatibleSkipped.length > 0) {
        // A quiet RULE skip, not a failure: name how many updates stayed
        // pending and on which clients, and why (those clients do not ship
        // the font assets the pack loads). Aggregated because one batch can
        // skip several items at once.
        toast.info(
          t("resources.pluginUpdateSkippedIncompatible", {
            count: incompatibleSkipped.length,
            clients: [...new Set(incompatibleSkipped.map((s) => s.client))].join(", "),
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
    speedBps,
    overallPercent,
    failures,
    pendingInstalls,
    totalCount,
    infoFor,
    itemOp,
    parkIncompatibleSkip,
    refresh,
    syncFreshness,
    runProbe,
    runMod,
    runModUninstall,
    updateAll,
  };
});
