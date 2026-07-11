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

export const api = {
  getOsPreferences: () => transport.invoke<{ locale: string; colorScheme: string }>(RPC.get_os_preferences),
  detectGameInstall: () => transport.invoke<GameInstall[]>(RPC.detect_game_install),
  setGamePath: (path: string) => transport.invoke<GameInstall>(RPC.set_game_path, { path }),
  readReplayHeader: (path: string) => transport.invoke<ReplayMeta>(RPC.read_replay_header, { path }),
  listReplays: (dir?: string, limit?: number) =>
    transport.invoke<string[]>(RPC.list_replays, { dir, limit }),
  readTempArenaInfo: (dir?: string) =>
    transport.invoke<ArenaInfo | null>(RPC.read_temp_arena_info, { dir }),
  startArenaWatcher: (dir?: string) => transport.invoke<null>(RPC.start_arena_watcher, { dir }),
  stopArenaWatcher: () => transport.invoke<null>(RPC.stop_arena_watcher),
  captureGameWindow: () => transport.invoke<CaptureResult>(RPC.capture_game_window),
  setOverlayVisible: (visible: boolean) =>
    transport.invoke<null>(RPC.set_overlay_visible, { visible }),
};
