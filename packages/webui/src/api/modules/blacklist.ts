/** Blacklist sync domain (黑名单同步): the OpenID login state, the synced
 *  in-game blacklist snapshot and its knobs. Mirrors
 *  wowsp_tauri_shared::blacklist one-to-one. Read-only by design — the
 *  public API has no write path and the game stays the source of truth. */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

/** Which API family the credentials belong to (ru = Lesta, others = WG). */
export type BlacklistPlatform = "wargaming" | "lesta";

/** Mirrors BlacklistAuthState — the token itself never crosses the IPC. */
export interface BlacklistAuthState {
  realm: string;
  platform: BlacklistPlatform | null;
  loggedIn: boolean;
  accountId: number | null;
  nickname: string | null;
  /** Unix seconds. */
  expiresAt: number | null;
}

/** Mirrors BlacklistEntry — nickname is null while unresolved. */
export interface BlacklistEntry {
  accountId: number;
  nickname?: string | null;
}

/** Mirrors BlacklistSnapshot — the wholesale-replacement mirror of one
 *  realm's in-game blacklist. */
export interface BlacklistSnapshot {
  realm: string;
  platform: BlacklistPlatform;
  accountId: number;
  nickname: string | null;
  /** Unix seconds of the last successful pull. */
  lastSyncedAt: number;
  entries: BlacklistEntry[];
  unresolved: number;
}

/** Mirrors BlacklistSyncReport — per-run feedback for the settings page. */
export interface BlacklistSyncReport {
  realm: string;
  ok: boolean;
  fetched: number;
  resolved: number;
  message?: string | null;
}

/** Mirrors BlacklistSyncConfig. */
export interface BlacklistSyncConfig {
  autoSync: boolean;
  /** Hours between automatic pulls (backend clamps to 1..=168). */
  intervalHours: number;
}

export const blacklistApi = {
  blacklistAuthState: (realm: string) =>
    transport.invoke<BlacklistAuthState>(RPC.blacklist_auth_state, { realm }),
  /** Opens the portal login page; resolves with the login URL for the
   *  manual copy/paste fallback. Poll blacklistAuthState for the outcome. */
  blacklistAuthStart: (realm: string) =>
    transport.invoke<string>(RPC.blacklist_auth_start, { realm }),
  blacklistAuthCancel: () => transport.invoke<void>(RPC.blacklist_auth_cancel),
  blacklistAuthForget: (realm: string) =>
    transport.invoke<void>(RPC.blacklist_auth_forget, { realm }),
  blacklistSyncNow: (realm: string) =>
    transport.invoke<BlacklistSyncReport>(RPC.blacklist_sync_now, { realm }),
  blacklistSnapshot: (realm: string) =>
    transport.invoke<BlacklistSnapshot | null>(RPC.blacklist_snapshot, { realm }),
  blacklistLoadConfig: () => transport.invoke<BlacklistSyncConfig>(RPC.blacklist_load_config),
  blacklistSaveConfig: (config: BlacklistSyncConfig) =>
    transport.invoke<BlacklistSyncConfig>(RPC.blacklist_save_config, { config }),
};
