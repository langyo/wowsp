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
  type IgnoredSuspect,
} from "@/api";
import { t } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { useGameStatusStore } from "@/stores/gameStatus";
import { sameGamePath } from "@/utils/gamePath";

export const useCrashStore = defineStore("crash", () => {
  const toast = useToast();
  const gameStatus = useGameStatusStore();
  const config = useConfigStore();
  const settingsUi = useSettingsUiStore();

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
  /** The safeguard switch (crash detection + recent-crash catch-up) —
   *  mirrored from the backend; on until the user opts out. */
  const safeguard = ref(true);
  const safeguardBusy = ref(false);
  /** A manual recent-crash parse is running (the section's scan button). */
  const scanning = ref(false);
  /** The dismissed-warning list (the section renders it with restore
   *  actions; the analysis filters these names out). */
  const ignored = ref<IgnoredSuspect[]>([]);
  /** The id of the STICKY crash-prompt toast raised through the standard
   *  toast context (null while no prompt is up). */
  let promptToastId: number | null = null;
  /** The record the current prompt describes (dedupe for repeated
   *  refreshes — the same record must not re-toast on every refresh). */
  let promptRecordId: string | null = null;

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

  /** Raise the crash prompt as a STANDARD sticky toast (the shared toast
   *  context stacks it with every other toast — no separate surface that
   *  other toasts could cover). One inline action opens the analysis
   *  section, where every recovery move lives. */
  function raisePrompt(record: GameCrashRecord) {
    if (promptToastId !== null && promptRecordId === record.id) return;
    // One sentence, no process name or crash code: players do not read
    // those, and the analysis section carries the technical detail.
    const id = toast.show(t("crash.toast.title"),
      {
        type: "error",
        duration: 0,
        copyable: true,
        action: {
          label: t("crash.toast.open"),
          onClick: () => {
            promptToastId = null;
            settingsUi.show("crash");
          },
        },
      },
    );
    if (promptToastId !== null) toast.remove(promptToastId);
    promptToastId = id;
    promptRecordId = record.id;
  }

  /** Take the prompt down (record dismissed elsewhere, or the app reset). */
  function clearPrompt() {
    if (promptToastId !== null) {
      toast.remove(promptToastId);
      promptToastId = null;
    }
    promptRecordId = null;
  }

  /** Fold one record into the store: upsert history (the push may repeat a
   *  record on reconnect), pin it as the active prompt while undismissed,
   *  and clear the prompt the moment ITS record is dismissed elsewhere. */
  function ingest(record: GameCrashRecord) {
    // Replaces the array (no in-place mutation): watchers without deep
    // fire on the identity change — the mod-hub pins re-resolve the
    // moment a push lands.
    history.value = [record, ...history.value.filter((r) => r.id !== record.id)];
    if (record.status === "new") {
      activeRecord.value = record;
      raisePrompt(record);
    } else if (activeRecord.value?.id === record.id) {
      activeRecord.value = null;
      clearPrompt();
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
      // A pending crash must re-toast after an app restart too (the
      // prompt is the notification, not a one-shot event).
      if (activeRecord.value) raisePrompt(activeRecord.value);
      else clearPrompt();
    } catch {
      // No watchdog backend — the card simply stays down.
    } finally {
      historyLoading.value = false;
    }
  }

  /** Start the event subscription + the initial history load (idempotent;
   *  called on window mount, next to gameStatus/session). */
  /** Subscription epoch: a stop()→start() race must orphan the FIRST
   *  handshake (the started flag alone cannot — start() resets it before
   *  the first listener resolves, leaking a duplicate ingest forever). */
  let epoch = 0;

  function start() {
    if (started) return;
    started = true;
    const mine = ++epoch;
    void (async () => {
      try {
        const off =
          (await api.listenGameCrash?.((record) => {
            ingest(record);
          })) ?? null;
        // stop() (or a newer start()) raced the handshake — release now.
        if (mine !== epoch) {
          off?.();
          return;
        }
        unlisten = off;
      } catch {
        if (mine === epoch) unlisten = null;
      }
    })();
    void refreshHistory();
    void loadSafeguard();
  }

  /** Mirror the persisted safeguard switch; failures keep the armed
   *  default (browser dev, older shell). */
  async function loadSafeguard() {
    try {
      safeguard.value = await api.safeguardEnabled();
    } catch {
      // No backend answer — the optimistic default stands.
    }
  }

  /** Stop the subscription (window unmount); state stays for a remount. */
  function stop() {
    epoch += 1;
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
    if (activeRecord.value?.id === id) {
      activeRecord.value = null;
      clearPrompt();
    }
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
    const info = await restart(gameRoot);
    if (!info) {
      // The install now sits in safe mode with mods quarantined — the
      // restart refusal toast alone would hide that state change.
      toast.warning(t("crash.section.safeModeOn"));
    }
    return info;
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
  async function quarantine(
    entryName: string,
    crashId?: string,
    gameRoot?: string | null,
  ): Promise<QuarantineEntry[]> {
    // The acting surface decides the install (the record being worked on);
    // only its absence falls back to the active-record/active-install guess.
    const root = gameRoot ?? quarantineRoot();
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
  async function restore(
    entryName: string,
    gameRoot?: string | null,
  ): Promise<QuarantineEntry[]> {
    const root = gameRoot ?? quarantineRoot();
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

  /** Flip the safeguard switch. The backend runs its own catch-up pass
   *  on the enabling edge; afterwards the history is reloaded so any
   *  imported records surface. Throws on backend refusal (caller toasts). */
  async function setSafeguard(enabled: boolean) {
    if (safeguardBusy.value) return;
    safeguardBusy.value = true;
    try {
      safeguard.value = await api.setSafeguard(enabled);
      await refreshHistory();
    } finally {
      safeguardBusy.value = false;
    }
  }

  /** Parse the recent crash records (the manual scan button): whatever OS
   *  evidence the history has not recorded yet imports now. Answers the
   *  number of newly imported records for the toast. */
  async function scanRecent(): Promise<number> {
    if (scanning.value) return 0;
    scanning.value = true;
    try {
      const imported = await api.scanRecentCrashes();
      for (const record of imported) {
        ingest(record);
      }
      return imported.length;
    } finally {
      scanning.value = false;
    }
  }

  /** Reload the dismissed-warning list. */
  async function loadIgnored() {
    try {
      ignored.value = await api.listIgnoredSuspects();
    } catch {
      // No backend — the list stays as-is.
    }
  }

  /** Dismiss one suspect warning (persisted; the analysis filters it). */
  async function ignoreSuspect(name: string) {
    await api.ignoreSuspect(name);
    await loadIgnored();
  }

  /** Undo a dismissal — the warning comes back. */
  async function restoreSuspect(name: string) {
    await api.restoreSuspect(name);
    await loadIgnored();
  }

  /** Permanently delete one pinned mod entry. */
  async function deleteEntry(name: string, gameRoot: string | null | undefined) {
    if (!gameRoot) throw new Error("crash: no game root for deletion");
    await api.deleteEntry(gameRoot, name);
  }

  /** Drop the cached analysis and re-run it (after an ignore / delete the
   *  findings and suspects must reflect the new state). */
  async function refreshAnalysis(id: string) {
    analyses.delete(id);
    analysesVersion.value += 1;
    return analyze(id);
  }

  return {
    safeguard,
    safeguardBusy,
    scanning,
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
    ignored,
    loadIgnored,
    ignoreSuspect,
    restoreSuspect,
    deleteEntry,
    refreshAnalysis,
    clearPrompt,
    loadSafeguard,
    setSafeguard,
    scanRecent,
    loadQuarantined,
    quarantine,
    restore,
  };
});
