/**
 * WoWSP API client. Thin wrappers over the transport singleton that map each
 * Tauri command to a typed call, so feature code imports `api.detectGameInstall()`
 * instead of touching `transport.invoke(RPC...)` directly.
 */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

/** Mirrors `wowsp_tauri_shared::GameInstall`. */
export interface GameInstall {
  kind: "wargaming" | "steam" | "lesta" | "cn360" | "manual";
  path: string;
  realm?: string | null;
}

/** Mirrors `wowsp_tauri_shared::VehicleEntry`. */
export interface VehicleEntry {
  id: number;
  name: string;
  /** 0/1 = ally (self + division); 2+ = enemy. Numeric in the client JSON. */
  relation: number;
  /** Client ship id (numeric, JSON number). */
  shipId: number;
  /** Pre-resolved ship display name, if known. */
  shipName?: string | null;
}

/** Mirrors `wowsp_tauri_shared::ReplayMeta`. */
export interface ReplayMeta {
  path: string;
  matchGroup?: string | null;
  /** Parsed from the replay filename (YYYYMMDD). */
  dateTime?: string | null;
  /** Internal numeric map id. */
  mapId?: number | null;
  /** Client display name, e.g. "15_NE_north". */
  mapName?: string | null;
  vehicles: VehicleEntry[];
  raw: unknown;
}

/** Mirrors `wowsp_tauri_shared::ArenaInfo`. */
export interface ArenaInfo {
  matchGroup?: string | null;
  dateTime?: string | null;
  vehicles: VehicleEntry[];
  raw: unknown;
}

/** Mirrors `wowsp_tauri_shared::CaptureResult`. */
export interface CaptureResult {
  imageBase64: string;
  rosterRect?: { x: number; y: number; width: number; height: number } | null;
}

/** One position sample (mirrors `wowsp_tauri_shared::PositionSample`). WoWS
 * maps are planar: x = east, z = north, y ≈ 0 (sea level). */
export interface PositionSample {
  time: number;
  entityId: number;
  vehicleId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Entity creation metadata (mirrors `wowsp_tauri_shared::EntityKind`). The
 * fixed header of an EntityCreate (0x05) packet; the trailing state blob needs
 * the entity DB and is skipped. `entityType` 2 = vehicle (ships). */
export interface EntityKind {
  entityType: number;
  vehicleId: number;
  initialX: number;
  initialY: number;
  initialZ: number;
}

/** A per-entity trajectory (mirrors `wowsp_tauri_shared::EntityTrajectory`). */
export interface EntityTrajectory {
  entityId: number;
  kind?: EntityKind | null;
  samples: PositionSample[];
}

/** Player stats from the WG public API (mirrors `wowsp_tauri_shared::PlayerStats`). */
export interface PlayerStats {
  accountId: number;
  name: string;
  realm: string;
  battles?: number | null;
  winrate?: number | null;
  hidden: boolean;
  clanTag?: string | null;
  // ── Deep stats (PvP) ────────────────────────────────────────────────
  avgDamage?: number | null;
  avgXp?: number | null;
  kdRatio?: number | null;
  survivalRate?: number | null;
  hitRate?: number | null;
  pr?: number | null;
  shipsPlayed?: number | null;
  // ── Service record (player level/badge) ─────────────────────────────
  levelingTier?: number | null;
  levelingPoints?: number | null;
  // ── Per-division winrates ───────────────────────────────────────────
  soloWr?: number | null;
  div2Wr?: number | null;
  div3Wr?: number | null;
}

/** Mirrors `wowsp_tauri_shared::GameVersionInfo`. */
export interface GameVersionInfo {
  gameVersion: string;
  shipsTotal: number;
  timestamp: number;
}

/** Mirrors `wowsp_tauri_shared::ShipInfo`. */
export interface ShipImages {
  small: string;
  medium: string;
  large: string;
  contour: string;
}

export interface ShipInfo {
  shipId: number;
  name: string;
  tier: number;
  type: string;
  nation: string;
  isPremium: boolean;
  isSpecial: boolean;
  description: string;
  gameVersion: string;
  defaultProfile: unknown;
  images: ShipImages;
}

/** Mirrors `wowsp_tauri_shared::PlayerShipStats`. */
export interface PlayerShipStats {
  shipId: number;
  name: string;
  battles: number;
  wins: number;
  damageCaused: number;
  frags: number;
  survivedBattles: number;
  winrate: number;
  avgDamage: number;
  lastBattleTime: number;
}

/** Mirrors `wowsp_tauri_shared::StatsSnapshot`. */
export interface StatsSnapshot {
  timestamp: number;
  gameVersion: string;
  battles: number;
  wins: number;
  winrate: number;
  avgDamage: number;
  pr?: number | null;
}

/** Mirrors `wowsp_tauri_shared::TrendBucket`. */
export interface TrendBucket {
  version: string;
  startTime: number;
  endTime: number;
  snapshotCount: number;
  battleDelta: number;
  winrateAvg: number;
  winrateMin: number;
  winrateMax: number;
  avgDamage: number;
  prAvg?: number | null;
}

/** Mirrors `wowsp_tauri_shared::PatchNote`. */
export interface PatchNote {
  version: string;
  date: string;
  shipIds: number[];
  summary: string;
  changes: string[];
}

/** Mirrors `wowsp_tauri_shared::TrendResult`. */
export interface TrendResult {
  accountId: number;
  realm: string;
  buckets: TrendBucket[];
  patches: PatchNote[];
}

/** Mirrors `wowsp_tauri_shared::CommunityTrend`. */
export interface CommunityTrend {
  available: boolean;
  shipId: number;
  buckets: TrendBucket[];
}

export const api = {
  getOsPreferences: () => transport.invoke<{ locale: string; colorScheme: string }>(RPC.get_os_preferences),
  appdataRead: (file: string) => transport.invoke<string | null>(RPC.appdata_read, { file }),
  appdataWrite: (file: string, content: string) => transport.invoke<null>(RPC.appdata_write, { file, content }),
  appdataDelete: (file: string) => transport.invoke<null>(RPC.appdata_delete, { file }),
  isGameRunning: () => transport.invoke<boolean>(RPC.is_game_running),
  detectGameInstall: () => transport.invoke<GameInstall[]>(RPC.detect_game_install),
  setGamePath: (path: string) => transport.invoke<GameInstall>(RPC.set_game_path, { path }),
  readReplayHeader: (path: string) => transport.invoke<ReplayMeta>(RPC.read_replay_header, { path }),
  readReplayPositions: (path: string) =>
    transport.invoke<EntityTrajectory[]>(RPC.read_replay_positions, { path }),
  listReplays: (dir?: string, limit?: number) =>
    transport.invoke<string[]>(RPC.list_replays, { dir, limit }),
  readTempArenaInfo: (dir?: string) =>
    transport.invoke<ArenaInfo | null>(RPC.read_temp_arena_info, { dir }),
  startArenaWatcher: (dir?: string) => transport.invoke<null>(RPC.start_arena_watcher, { dir }),
  stopArenaWatcher: () => transport.invoke<null>(RPC.stop_arena_watcher),
  listenArenaInfo: (handler: (info: ArenaInfo) => void) =>
    transport.listen?.<ArenaInfo>("wowsp://arena-info", handler),
  captureGameWindow: () => transport.invoke<CaptureResult>(RPC.capture_game_window),
  setOverlayVisible: (visible: boolean) =>
    transport.invoke<null>(RPC.set_overlay_visible, { visible }),
  createOverlayWindow: () => transport.invoke<null>(RPC.create_overlay_window),
  destroyOverlayWindow: () => transport.invoke<null>(RPC.destroy_overlay_window),
  lookupPlayerStats: (name: string, realm: string) =>
    transport.invoke<PlayerStats>(RPC.lookup_player_stats, { name, realm }),
  getGameVersion: () => transport.invoke<GameVersionInfo>(RPC.get_game_version),
  getShipEncyclopedia: (realm: string, forceRefresh: boolean, language?: string) =>
    transport.invoke<ShipInfo[]>(RPC.get_ship_encyclopedia, { realm, forceRefresh, language }),
  lookupPlayerShipStats: (accountId: number, realm: string) =>
    transport.invoke<PlayerShipStats[]>(RPC.lookup_player_ship_stats, { accountId, realm }),
  snapshotPlayerStats: (
    accountId: number,
    realm: string,
    battles: number | null,
    wins: number | null,
    winrate: number | null,
    avgDamage: number | null,
    pr: number | null,
  ) =>
    transport.invoke<StatsSnapshot>(RPC.snapshot_player_stats, {
      accountId,
      realm,
      battles,
      wins,
      winrate,
      avgDamage,
      pr,
    }),
  getShipGameparams: (shipId: number, gameRoot: string) =>
    transport.invoke<unknown>(RPC.get_ship_gameparams, { shipId, gameRoot }),
  getPlayerTrend: (accountId: number, realm: string) =>
    transport.invoke<TrendResult>(RPC.get_player_trend, { accountId, realm }),
  getPatches: () => transport.invoke<PatchNote[]>(RPC.get_patches),
  getCommunityShipTrend: (shipId: number) =>
    transport.invoke<CommunityTrend>(RPC.get_community_ship_trend, { shipId }),
  captureMainWindow: (path: string) =>
    transport.invoke<string>(RPC.capture_main_window, { path }),
  installOverlayMod: (gameRoot: string) =>
    transport.invoke<string>(RPC.install_overlay_mod, { gameRoot }),
  uninstallOverlayMod: (gameRoot: string) =>
    transport.invoke<null>(RPC.uninstall_overlay_mod, { gameRoot }),
  isOverlayModInstalled: (gameRoot: string) =>
    transport.invoke<boolean>(RPC.is_overlay_mod_installed, { gameRoot }),
};
