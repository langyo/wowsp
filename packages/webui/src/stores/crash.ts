/**
 * Game-crash watchdog mirror — the frontend state for the backend's crash
 * detection (commands/game_crash.rs, the wowsp://game-crash push).
 *
 * The Rust watchdog owns detection: it watches the Windows event log, WER
 * reports and crash dumps, records each game-client crash, and broadcasts
 * the record. This store mirrors that push into the toast card's subject
 * (activeRecord — the newest undismissed record) plus the full retained
 * history the settings' crash section lists, and fronts the per-record
 * actions (dismiss / analyze / export) and the guarded relaunch paths
 * (plain restart, or safe-mode-on-then-restart for a mod-suspected crash).
 *
 * Restarting into a RUNNING client would fight its own process (the
 * backend refuses root-scoped anyway), so restart/safeModeAndRestart
 * pre-check the gameStatus poll — the same rule the mod hub applies
 * before mutating res_mods (see views/resources/useModHub.ts).
 *
 * Browser dev has no watchdog: the initial list fails quietly and the
 * card stays down; the store is harmless wherever the backend is absent.
 */
import { useToast } from "@celestia-island/hikari";
import { defineStore } from "pinia";
import { ref } from "vue";

import {
  api,
  type CrashAnalysis,
  type GameCrashRecord,
  type GameRestartInfo,
  type QuarantineEntry,
} from "@/api";
import { t } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { sameGamePath } from "@/utils/gamePath";

export const useCrashStore = defineStore("crash", () => {
  const toast = useToast();
  const gameStatus = useGameStatusStore();
  const config = useConfigStore();

  /** The newest status === "new" record — the toast card's subject; null
   *  once everything is dismissed (the card renders nothing then). */
  const activeRecord = ref<GameCrashRecord | null>(null);
  /** The full retained history, newest first (the crash section's list). */
  const history = ref<GameCrashRecord[]>([]);
  /** The quarantine manifest of the install last loaded (on demand). */
  const quarantined = ref<QuarantineEntry[]>([]);

  // ── busy flags ────────────────────────────────────────────────────────
  const historyLoading = ref(false);
  const restarting = ref(false);
  /** The record an analysis/export pass is running for (per-row spinners). */
  const analyzingId = ref<string | null>(null);
  const exportingId = ref<string | null>(null);
  const quarantineLoading = ref(false);
  /** Entry names mid quarantine/restore — the manifest rows' busy set. */
  const quarantineBusy = ref(new Set<string>());

  /** Analysis results cache, per record id (analyze is heavy IO; one pass
   *  per record per session unless the section forces a refresh). A plain
   *  Map on purpose — the cached payloads are plain IPC data whose
   *  identity callers rely on; reactivity rides the version ref instead. */
  const analyses = new Map<string, CrashAnalysis>();
  /** Bumped on every cache fill so analysisFor-based computeds re-run —
   *  without it the section's pane would sit on its spinner forever. */
  const analysesVersion = ref(0);

  /** Cached analysis for one record, or undefined (the section renders
   *  its own empty/pass state then). */
  function analysisFor(id: string): CrashAnalysis | undefined {
    void analysesVersion.value;
    return analyses.get(id);
  }

  // ── lifecycle (the session-store race-safe idiom) ─────────────────────
  let started = false;
  let unlisten: (() => void) | null = null;

  /** Fold one record into the store: upsert history (the push may repeat a
   *  record on reconnect), pin it as the active prompt while undismissed,
   *  and clear the prompt the moment ITS record is dismissed elsewhere. */
  function ingest(record: GameCrashRecord) {
    const existing = history.value.findIndex((r) => r.id === record.id);
    if (existing >= 0) history.value.splice(existing, 1);
    history.value.unshift(record);
    if (record.status === "new") {
      activeRecord.value = record;
    } else if (activeRecord.value?.id === record.id) {
      activeRecord.value = null;
    }
  }

  /** Reload the retained list (boot / refresh button) and re-resolve the
   *  active prompt from it. Failures (browser dev, phone build, older
   *  shell) keep whatever state is already here. */
  async function refreshHistory() {
    historyLoading.value = true;
    try {
      const records = await api.listGameCrashes();
      history.value = records;
      activeRecord.value = records.find((r) => r.status === "new") ?? null;
    } catch {
      // No watchdog backend — the card simply stays down.
    } finally {
      historyLoading.value = false;
    }
  }

  /** Start the event subscription + the initial history load (idempotent;
   *  called on window mount, next to gameStatus/session). */
  function start() {
    if (started) return;
    started = true;
    void (async () => {
      try {
        const off =
          (await api.listenGameCrash?.((record) => {
            ingest(record);
          })) ?? null;
        // stop() raced the subscription handshake — release immediately.
        if (!started) {
          off?.();
          return;
        }
        unlisten = off;
      } catch {
        unlisten = null;
      }
    })();
    void refreshHistory();
  }

  /** Stop the subscription (window unmount); state stays for a remount. */
  function stop() {
    unlisten?.();
    unlisten = null;
    started = false;
  }

  // ── per-record actions ────────────────────────────────────────────────

  /** Dismiss one record backend-side and drop its prompt locally. Throws
   *  on backend refusal — the calling surface owns the error toast. */
  async function dismiss(id: string) {
    await api.dismissGameCrash(id);
    const record = history.value.find((r) => r.id === id);
    if (record) record.status = "dismissed";
    if (activeRecord.value?.id === id) activeRecord.value = null;
  }

  /** The analysis pass for one record, cached per id. Throws on failure —
   *  the crash section owns the error surface. */
  async function analyze(id: string): Promise<CrashAnalysis> {
    const cached = analyses.get(id);
    if (cached) return cached;
    analyzingId.value = id;
    try {
      const analysis = await api.analyzeGameCrash(id);
      analyses.set(id, analysis);
      analysesVersion.value += 1;
      return analysis;
    } finally {
      analyzingId.value = null;
    }
  }

  /** Export one record's redacted report bundle; resolves the zip path the
   *  backend revealed. Toast on error is the caller's concern. */
  async function exportReport(id: string): Promise<string> {
    exportingId.value = id;
    try {
      return await api.exportGameCrashReport(id);
    } finally {
      exportingId.value = null;
    }
  }

  // ── guarded relaunch paths ────────────────────────────────────────────

  /** True when a running client blocks the requested relaunch — mirrors
   *  the mod hub's gameRunning guard (useModHub.ts): the RUNNING client's
   *  own tree must not be touched, an unknown-folder client is refused
   *  conservatively, and an UNKNOWN target root (the backend's
   *  last-crashed resolution) plus anything running is refused too —
   *  launching blind could double-start a live install. */
  function gameBlocked(targetRoot: string | null | undefined): boolean {
    const runningRoots = gameStatus.processes
      .filter((p) => p.running)
      .map((p) => p.matchedInstall?.path ?? null);
    if (runningRoots.length === 0) return false;
    if (targetRoot == null || targetRoot === "") return true;
    return (
      runningRoots.some((r) => r == null) ||
      runningRoots.some((r) => r != null && sameGamePath(targetRoot, r))
    );
  }

  /** Relaunch the game client (the given install, else the backend's
   *  last-crashed / active resolution). Refuses with a toast while the
   *  game is running; resolves null on refusal or failure (the info's
   *  pid/exePath are the caller's success signal). */
  async function restart(gameRoot?: string | null): Promise<GameRestartInfo | null> {
    if (gameBlocked(gameRoot)) {
      toast.error(t("crash.errors.gameRunning"));
      return null;
    }
    if (restarting.value) return null;
    restarting.value = true;
    try {
      return await api.restartGame(gameRoot);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      restarting.value = false;
    }
  }

  /** The crash card's primary move for a mod-suspected crash: flip the
   *  install's mod hub safe mode ON, then relaunch. Refuses like restart
   *  while the game is running (safe mode writes res_mods); a missing
   *  gameRoot cannot flip anything, so it degrades to a plain restart —
   *  the caller hints at the fallback when it knows the root is absent. */
  async function safeModeAndRestart(gameRoot: string): Promise<GameRestartInfo | null> {
    if (gameBlocked(gameRoot)) {
      toast.error(t("crash.errors.gameRunning"));
      return null;
    }
    if (!gameRoot) return restart();
    if (restarting.value) return null;
    restarting.value = true;
    try {
      await api.modHubSetSafeMode(gameRoot, true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      restarting.value = false;
    }
    return restart(gameRoot);
  }

  // ── quarantine ────────────────────────────────────────────────────────

  /** The install the quarantine ops target: the active record's root when
   *  known, else the active install. Null = no context (callers guard). */
  function quarantineRoot(): string | null {
    return activeRecord.value?.gameRoot ?? config.activeInstall?.path ?? null;
  }

  /** Load the install's quarantine manifest (the section's quarantined
   *  list). Throws on failure — the section owns the error surface. */
  async function loadQuarantined(gameRoot: string) {
    quarantineLoading.value = true;
    try {
      quarantined.value = await api.listQuarantinedMods(gameRoot);
    } finally {
      quarantineLoading.value = false;
    }
  }

  /** Move one res_mods entry into quarantine (attributed to the given
   *  crash record when known) and pin the refreshed manifest. Single-
   *  flight per entry; throws on refusal — the section owns the toast. */
  async function quarantine(entryName: string, crashId?: string): Promise<QuarantineEntry[]> {
    const root = quarantineRoot();
    if (!root) throw new Error("crash: no game root for quarantine");
    if (quarantineBusy.value.has(entryName)) return quarantined.value;
    quarantineBusy.value.add(entryName);
    try {
      quarantined.value = await api.quarantineMod(root, entryName, crashId);
      return quarantined.value;
    } finally {
      quarantineBusy.value.delete(entryName);
    }
  }

  /** Bring one quarantined entry back into res_mods and pin the refreshed
   *  manifest. Same contract as quarantine. */
  async function restore(entryName: string): Promise<QuarantineEntry[]> {
    const root = quarantineRoot();
    if (!root) throw new Error("crash: no game root for restore");
    if (quarantineBusy.value.has(entryName)) return quarantined.value;
    quarantineBusy.value.add(entryName);
    try {
      quarantined.value = await api.restoreMod(root, entryName);
      return quarantined.value;
    } finally {
      quarantineBusy.value.delete(entryName);
    }
  }

  return {
    activeRecord,
    history,
    quarantined,
    historyLoading,
    restarting,
    analyzingId,
    exportingId,
    quarantineLoading,
    quarantineBusy,
    analysisFor,
    start,
    stop,
    refreshHistory,
    dismiss,
    analyze,
    exportReport,
    restart,
    safeModeAndRestart,
    quarantineRoot,
    loadQuarantined,
    quarantine,
    restore,
  };
});
