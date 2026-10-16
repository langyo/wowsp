/** Game-install domain of the WoWSP API client: install detection and
 *  config, process/session state, playtime ledger and replay-folder pinning
 *  (composed into `api` by client.ts). */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

/** Mirrors `wowsp_tauri_shared::GameInstall`. */
export interface GameInstall {
  kind: "wargaming" | "steam" | "lesta" | "cn360" | "cnKongzhong" | "manual";
  path: string;
  realm?: string | null;
}

/** Installer kind discriminator (see GameInstall). */
export type GameInstallKind = GameInstall["kind"];

/** Mirrors `wowsp_tauri_shared::GameProcessInfo`. Richer than the legacy
 *  `is_game_running` boolean — carries the PID and the install (kind/realm)
 *  the running process belongs to, resolved by exe-path prefix match. */
export interface GameProcessInfo {
  running: boolean;
  pid?: number | null;
  kind?: GameInstall["kind"] | null;
  realm?: string | null;
  exePath?: string | null;
  matchedInstall?: GameInstall | null;
}

/** Mirrors `wowsp_tauri_shared::GameProcessReport` — the multi-instance
 *  view: every running game client as its own entry plus the pid of the
 *  preferred instance (the one the single-process surfaces follow). */
export interface GameProcessReport {
  processes: GameProcessInfo[];
  preferredPid: number | null;
}

/** One in-game probe telemetry frame (the `wowsp://ingame-telemetry(-watched)`
 *  events). `root` (watched stream only) names the install the frame was
 *  read from — the multi-instance tag consumers filter by. */
export interface TelemetryPayload {
  t: number;
  battle: string;
  players: Record<string, boolean>;
  sortKeys?: Record<string, string>;
  /** The roster's OWN record sequence (the probe's `roster_order`) —
   *  the tie base for EQUAL client sort keys (the Lesta rule); empty on
   *  a probe build that predates the field. */
  rosterOrder?: string[];
  /** The records' localized ship names — the CN name-order segment
   *  verbatim off the game's own roster data; empty when the client's
   *  records carry no such field. */
  shipNames?: Record<string, string>;
  self?: { name?: string; realm?: string };
  identity?: Record<string, { account_id?: number; realm?: string }>;
  root?: string;
}

/** Mirrors `wowsp_tauri_shared::PlaytimeSource` — where the playtime
 *  ledger's career total came from. */
export type PlaytimeSource = "local" | "steam";

/** Mirrors `wowsp_tauri_shared::PlaytimeDay` — one local calendar day's
 *  playtime (`YYYY-MM-DD`); days without playtime are simply absent. */
export interface PlaytimeDay {
  date: string;
  seconds: number;
}

/** Mirrors `wowsp_tauri_shared::PlaytimeLaunch` — the most recent (or
 *  currently running) game launch. */
export interface PlaytimeLaunch {
  start: number;
  durationSeconds: number;
  running: boolean;
}

/** Mirrors `wowsp_tauri_shared::PlaytimeOverview` — the 游玩时间 view's
 *  full payload: career totals (Steam-seeded when available), record
 *  statistics computed from the local sessions, and the local per-day
 *  series for the trend chart and the heatmap. The imported backlog is
 *  undated, so it never appears in `daily`. */
export interface PlaytimeOverview {
  source: PlaytimeSource;
  importedTotalSeconds: number;
  importedAt: number | null;
  localTotalSeconds: number;
  totalSeconds: number;
  launchCount: number;
  daysPlayed: number;
  firstTrackedDay: string | null;
  longestStreakDays: number;
  longestStreakStart: string | null;
  longestStreakEnd: string | null;
  longestSessionSeconds: number;
  longestSessionDate: string | null;
  longestDaySeconds: number;
  longestDayDate: string | null;
  lastLaunch: PlaytimeLaunch | null;
  daily: PlaytimeDay[];
}

/** Mirrors `wowsp_tauri_shared::PlaytimeBattle` — one replay-derived battle
 *  row (the 游玩时间 view's battles card + breakdown). `installPath` is the
 *  owning install's root (GameInstall.path) or the replay dir root when the
 *  folder belongs to no known install; descriptor fields are null when the
 *  replay could not be parsed (Lesta files keep only the filename). */
export interface PlaytimeBattle {
  installPath: string;
  kind: GameInstallKind | null;
  realm: string | null;
  /** Local time from the replay filename, "YYYYMMDD[_HHMMSS]"; null when
   *  unparseable. */
  dateTime: string | null;
  matchGroup: string | null;
  scenario: string | null;
  eventType: string | null;
  botCount: number;
  scriptedUnitCount: number;
  ownShipId: number | null;
  /** The recorder's NICKNAME — the descriptor's `playerName`, absent (null)
   *  when the header is unparseable or carries no roster. Renamed from
   *  `ownShipName`, which promised a ship but held exactly this nickname. */
  playerName: string | null;
  playerCount: number;
}

/** Mirrors `wowsp_tauri_shared::PlaytimeBattles` — every replay found under
 *  the known installs' replays folders, sorted by dateTime asc (nulls last).
 *  Rust caches the scan, so the 30 s poll can refetch cheaply. */
export interface PlaytimeBattles {
  battles: PlaytimeBattle[];
}

/** Mirrors `wowsp_tauri_shared::AccountProfile` — one remembered account as
 *  the webui's own accounts.json writes it (and the Rust session hub reads
 *  it back for playing-account matching). */
export interface AccountProfileRef {
  accountId: number;
  nickname: string;
  realm: string;
}

/** Mirrors `wowsp_tauri_shared::PlayingAccount` — the player OBSERVED
 *  playing on the running client (battle roster nickname, exact account id
 *  when the in-game plugin bridge supplied one). */
export interface PlayingAccount {
  realm: string;
  nickname: string;
  accountId: number | null;
  source: "arena" | "plugin";
}

/** Mirrors `wowsp_tauri_shared::SessionPlayer` — the resolved player the
 *  status surfaces display: the playing account when identified (registered
 *  or not), else the active selection. */
export interface SessionPlayer {
  accountId: number | null;
  nickname: string;
  realm: string;
  registered: boolean;
  playing: boolean;
}

/** Mirrors `wowsp_tauri_shared::SessionSnapshot` — the Rust session hub's
 *  full state (`wowsp://session-changed` payload / get_session_state reply).
 *  Both windows (main shell + tray panel) render from this one shape. */
export interface SessionSnapshot {
  process: GameProcessInfo;
  playing: PlayingAccount | null;
  active: AccountProfileRef | null;
  display: SessionPlayer | null;
}

export const gameApi = {
  /** Remembered game-install path — sanitized + persisted as TOML by the
   *  shell (see commands/game_config.rs). */
  getGameConfig: () =>
    transport.invoke<{ activePath: string | null; replayDirs: string[] }>(RPC.get_game_config),
  setGameConfig: (activePath: string | null) =>
    transport.invoke<{ activePath: string | null; replayDirs: string[] }>(RPC.set_game_config, {
      activePath,
    }),
  /** Pin an extra replay folder into the scan (游玩时间 view's replay
   *  sources). Throws when the folder overlaps what the scan already
   *  covers — the caller surfaces the message. */
  addReplayDir: (path: string) =>
    transport.invoke<{ activePath: string | null; replayDirs: string[] }>(RPC.add_replay_dir, {
      path,
    }),
  /** Unpin an extra replay folder; its already-counted battles stay. */
  removeReplayDir: (path: string) =>
    transport.invoke<{ activePath: string | null; replayDirs: string[] }>(RPC.remove_replay_dir, {
      path,
    }),
  /** Native folder picker for pinning an extra replay folder; null = the
   *  user cancelled the dialog. */
  pickReplayDir: () => transport.invoke<string | null>(RPC.pick_replay_dir),
  isGameRunning: () => transport.invoke<boolean>(RPC.is_game_running),
  getGameProcess: (installs: GameInstall[]) =>
    transport.invoke<GameProcessInfo>(RPC.get_game_process, { installs }),
  getGameProcesses: (installs: GameInstall[]) =>
    transport.invoke<GameProcessReport>(RPC.get_game_processes, { installs }),
  /** Playtime ledger overview (commands/playtime.rs) — career totals
   *  (Steam-seeded on first run when possible) plus the local per-day
   *  series the 游玩时间 view renders. */
  getPlaytimeOverview: () =>
    transport.invoke<PlaytimeOverview>(RPC.playtime_overview),
  /** Replay-derived battle rows for the 游玩时间 view's battles card and
   *  breakdown (commands/playtime.rs). The Rust side scans every known
   *  install's replays folder behind a cache, so this is cheap to poll. */
  playtimeBattles: () =>
    transport.invoke<PlaytimeBattles>(RPC.playtime_battles),
  /** Drop the battle ledger's disk cache and rescan from disk (the replay
   *  sources manager's rebuild action) — history of already-deleted
   *  replays leaves with the cache. */
  playtimeBattlesReset: () =>
    transport.invoke<PlaytimeBattles>(RPC.playtime_battles_reset),
  /** Rust session hub snapshot (commands/session.rs) — the running process
   *  plus the resolved "who is playing" identity. Live updates arrive via
   *  listenSessionChanged; this is the boot/fetch side. */
  getSessionState: () => transport.invoke<SessionSnapshot>(RPC.get_session_state),
  /** Mirror the active-account selection into the Rust session hub so every
   *  window (tray panel included) sees a settings switch immediately. */
  syncActiveAccount: (realm: string | null, accountId: number | null) =>
    transport.invoke<null>(RPC.sync_active_account, { realm, accountId }),
  /** The tray panel's menu buttons (show/hide/dismiss/quit — the tray menu's
   *  actions, desktop shell only). */
  trayPanelAction: (action: "show" | "hide" | "dismiss" | "quit") =>
    transport.invoke<null>(RPC.tray_panel_action, { action }),
  /** Session-hub push: the resolved snapshot whenever the process state,
   *  playing identity, or active selection changed. */
  listenSessionChanged: (handler: (snapshot: SessionSnapshot) => void) =>
    transport.listen?.<SessionSnapshot>("wowsp://session-changed", handler),
  detectGameInstall: () => transport.invoke<GameInstall[]>(RPC.detect_game_install),
  setGamePath: (path: string) => transport.invoke<GameInstall>(RPC.set_game_path, { path }),
  /** Native folder picker for the manual game-location entry. Null = the
   *  user cancelled the dialog. */
  pickGameFolder: () => transport.invoke<GameInstall | null>(RPC.pick_game_folder),
  /** Native multi-select dialog for .wowsreplay files anywhere on disk.
   *  Empty array = cancelled. */
  pickReplayFiles: () => transport.invoke<string[]>(RPC.pick_replay_files),
  /** res_mods ribbon-skin directory for a game install (None if unmodded). */
  ribbonSkinDir: (gamePath: string) =>
    transport.invoke<string | null>(RPC.ribbon_skin_dir, { gamePath }),
};
