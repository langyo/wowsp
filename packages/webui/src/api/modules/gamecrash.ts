/** Game-crash watchdog domain (commands/game_crash.rs): crash records
 *  harvested from the Windows event log / WER reports / crash dumps and
 *  broadcast as the "wowsp://game-crash" event, their per-record analysis
 *  pass, the redacted report bundle export, the per-install res_mods
 *  quarantine and the guarded client relaunch. Composed into the "api"
 *  object by client.ts. */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

import type { GameInstallKind } from "./game";

/** Mirrors commands::game_crash::GameCrashRecord — one detected game-client
 *  crash: the "wowsp://game-crash" payload and a game_crash_list row
 *  (newest first). */
export interface GameCrashRecord {
  id: string;
  /** Detection timestamp (RFC 3339, as the backend recorded it). */
  detectedAt: string;
  pid: number;
  /** Crashed executable name (e.g. "WorldOfWarships64.exe"). */
  imageName: string;
  /** Install the crashed process belonged to, when resolved. */
  gameRoot?: string | null;
  installKind?: GameInstallKind | null;
  /** Game build string when the install's version could be read. */
  gameBuild?: string | null;
  /** Which evidence source produced the record. */
  source: "event-log" | "wer-report" | "crash-dump" | "game-report";
  /** Windows exception code, hex string ("0xC0000005"), when known. */
  exceptionCode?: string | null;
  faultingModule?: string | null;
  werReportPath?: string | null;
  crashDumpPath?: string | null;
  /** One-line human summary the backend derived from the evidence. */
  summary?: string | null;
  /** Whether res_mods carried entries at detection time. */
  modsActive: boolean;
  status: "new" | "dismissed";
  /** Stable evidence identity (the backfill dedupe key); live detections
   *  carry none. */
  evidenceId?: string | null;
}

/** Mirrors commands::game_crash::CrashFinding — one diagnosis row the
 *  analysis pass derived from the evidence. */
export interface CrashFinding {
  /** Stable finding id — the i18n key tail under crash.findings.*. */
  code: string;
  severity: "info" | "warning" | "critical";
  detail?: string | null;
}

/** Mirrors commands::game_crash::LogExcerpt — one log file's tail plus the
 *  lines the analysis pass flagged (rendered highlighted). */
export interface LogExcerpt {
  name: string;
  path: string;
  sizeBytes: number;
  modified?: string | null;
  tail: string;
  highlights: string[];
}

/** Mirrors commands::game_crash::ModEntry — one top-level res_mods entry
 *  at analysis time. */
export interface ModEntry {
  name: string;
  isDir: boolean;
  modified?: string | null;
}

/** Mirrors commands::game_crash::SuspectMod — a res_mods entry the analysis
 *  suspects contributed to the crash, with its evidence trail. */
export interface SuspectMod {
  name: string;
  /** Why it is suspected: named in the game log, or changed recently. */
  evidence: "logMention" | "recentChange";
  /** The matching log lines, when the evidence is logMention. */
  logLines: string[];
}

/** Mirrors commands::game_crash::CrashAnalysis — the full analysis pass
 *  result for one record (game_crash_analyze reply). */
export interface CrashAnalysis {
  record: GameCrashRecord;
  findings: CrashFinding[];
  gameLogs: LogExcerpt[];
  appLogs: LogExcerpt[];
  modsInventory: ModEntry[];
  suspects: SuspectMod[];
  /** The install's live game build at analysis time, when readable —
   *  comparable against GameCrashRecord.gameBuild (crash-time). */
  currentBuild?: string | null;
  generatedAt: string;
}

/** Mirrors commands::game_crash::IgnoredSuspect — one dismissed warning. */
export interface IgnoredSuspect {
  name: string;
  /** RFC 3339 UTC of the dismissal. */
  ignoredAt: string;
}

/** Mirrors commands::game_crash::QuarantineEntry — one res_mods entry moved
 *  out of the load path (the per-install quarantine manifest). */
export interface QuarantineEntry {
  name: string;
  /** The crash record the quarantine was attributed to, when known. */
  crashId?: string | null;
  quarantinedAt: string;
}

/** Mirrors commands::game_crash::GameRestartInfo — the relaunch result
 *  (game_crash_restart reply). */
export interface GameRestartInfo {
  gameRoot: string;
  exePath: string;
  pid: number;
}

/** The watchdog's push event (commands/game_crash.rs GAME_CRASH_EVENT): one
 *  GameCrashRecord per detected crash. */
export const GAME_CRASH_EVENT = "wowsp://game-crash";

export const gameCrashApi = {
  /** Watchdog push: a freshly detected crash record. */
  listenGameCrash: (handler: (record: GameCrashRecord) => void) =>
    transport.listen?.<GameCrashRecord>(GAME_CRASH_EVENT, handler),
  /** Every retained crash record, newest first. */
  listGameCrashes: () => transport.invoke<GameCrashRecord[]>(RPC.game_crash_list),
  /** Mark one record dismissed (its prompt stops re-surfacing). */
  dismissGameCrash: (recordId: string) =>
    transport.invoke<null>(RPC.game_crash_dismiss, { recordId }),
  /** The analysis pass for one record (heavy IO backend-side). */
  analyzeGameCrash: (recordId: string) =>
    transport.invoke<CrashAnalysis>(RPC.game_crash_analyze, { recordId }),
  /** Export one record's redacted report bundle (zip) and reveal it;
   *  resolves the bundle path. */
  exportGameCrashReport: (recordId: string) =>
    transport.invoke<string>(RPC.game_crash_export, { recordId }),
  /** The install's current quarantine manifest. */
  listQuarantinedMods: (gameRoot: string) =>
    transport.invoke<QuarantineEntry[]>(RPC.game_crash_quarantined_mods, { gameRoot }),
  /** Move one top-level res_mods entry into quarantine (game-closed gated
   *  backend-side); resolves the updated manifest. */
  quarantineMod: (gameRoot: string, entryName: string, crashId?: string | null) =>
    transport.invoke<QuarantineEntry[]>(RPC.game_crash_quarantine_mod, {
      gameRoot,
      entryName,
      crashId: crashId ?? null,
    }),
  /** Bring one quarantined entry back into res_mods; resolves the updated
   *  manifest. */
  restoreMod: (gameRoot: string, entryName: string) =>
    transport.invoke<QuarantineEntry[]>(RPC.game_crash_restore_mod, {
      gameRoot,
      entryName,
    }),
  /** Launch the game client for the given (or last-crashed / active)
   *  install; the backend refuses while THAT client is running. */
  restartGame: (gameRoot?: string | null) =>
    transport.invoke<GameRestartInfo>(RPC.game_crash_restart, {
      gameRoot: gameRoot ?? null,
    }),
  /** The safeguard switch state (crash detection + recent-crash catch-up). */
  safeguardEnabled: () => transport.invoke<boolean>(RPC.game_crash_safeguard_enabled),
  /** Flip the safeguard; on the enabling edge the backend runs one
   *  catch-up pass. */
  setSafeguard: (enabled: boolean) =>
    transport.invoke<boolean>(RPC.game_crash_set_safeguard, { enabled }),
  /** Parse the recent crash records the history does not know yet and
   *  import them; resolves the newly imported records. */
  scanRecentCrashes: () =>
    transport.invoke<GameCrashRecord[]>(RPC.game_crash_scan_recent),
  /** The stored dismissed-warning list (restorable from the section). */
  listIgnoredSuspects: () =>
    transport.invoke<IgnoredSuspect[]>(RPC.game_crash_ignored_suspects),
  /** Dismiss one suspect warning by name. */
  ignoreSuspect: (name: string) =>
    transport.invoke<null>(RPC.game_crash_ignore_suspect, { name }),
  /** Bring one dismissed warning back. */
  restoreSuspect: (name: string) =>
    transport.invoke<null>(RPC.game_crash_restore_suspect, { name }),
  /** Permanently delete one pinned mod entry (file or directory). */
  deleteEntry: (gameRoot: string, entryName: string) =>
    transport.invoke<null>(RPC.game_crash_delete_entry, { gameRoot, entryName }),
};
