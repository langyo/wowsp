/** Player-markers domain (玩家标记): the LOCAL, user-built list of marked
 *  players with one of three colors. Mirrors wowsp_tauri_shared::markers.
 *  Strictly local data — no login, no sync, no upload. */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

/** The three marker colors and their meanings. */
export type MarkerColor = "red" | "yellow" | "purple";

/** Where a wire marker row came from — local judgment or an automatic
 *  cloud-ban match merged into markers_list (absent = local). */
export type MarkerSource = "local" | "cloud";

/** Mirrors MarkerEntry. */
export interface MarkerEntry {
  /** The roster nickname, unicode case-insensitive key. */
  nickname: string;
  color: MarkerColor;
  /** Optional free-form note (why this player is marked). */
  note?: string | null;
  /** Resolved account id when known — sharpens the match (rename-proof). */
  accountId?: number | null;
  /** Unix seconds when the marker was added. */
  createdAt?: number;
  /** "cloud" on merged rows only — never persisted in markers.json. */
  source?: MarkerSource | null;
}

/** Mirrors ApeRadarWatchPlayer — one parsed 海猴雷达 watch-list entry. */
export interface ApeRadarWatchPlayer {
  accountId?: number | null;
  name: string;
  /** Raw status name: "Negtive" | "Cheater" | "Positive" (else unknown). */
  status: string;
}

/** Mirrors ApeRadarWatchServer — one server block (RU/EU/NA/ASIA/CN). */
export interface ApeRadarWatchServer {
  server: string;
  players: ApeRadarWatchPlayer[];
}

/** Mirrors ApeRadarWatchList — a parsed WatchList.json. */
export interface ApeRadarWatchList {
  path: string;
  servers: ApeRadarWatchServer[];
}

/** Mirrors MarkerImportItem — one batch-import row (markers_add semantics). */
export interface MarkerImportItem {
  nickname: string;
  color: MarkerColor;
  note?: string | null;
  accountId?: number | null;
}

/** Mirrors MarkerImportResult — the refreshed list + wizard counters. */
export interface MarkerImportResult {
  list: MarkerEntry[];
  added: number;
  updated: number;
  skipped: number;
}

/** Mirrors CloudBanRecord — one yuyuko voList item (ban detail). */
export interface CloudBanRecord {
  banName?: string | null;
  userName?: string | null;
  banTime?: string | null;
  recordTime?: string | null;
  namesake: number;
}

/** Mirrors CloudBanMatch — one matched player (settings tooltip + dismiss). */
export interface CloudBanMatch {
  accountId: number;
  nickname: string;
  matched: boolean;
  dismissed: boolean;
  records: CloudBanRecord[];
  fetchedAt: number;
}

/** Mirrors CloudBanPlayer — one roster row passed to cloudBanCheck. */
export interface CloudBanPlayer {
  accountId: number;
  nickname: string;
}

/** Mirrors CloudBanCheckResult. */
export interface CloudBanCheckResult {
  skipped: boolean;
  queried: number;
  changed: boolean;
}

/** Mirrors CloudBanConfig. */
export interface CloudBanConfig {
  enabled: boolean;
}

export const markersApi = {
  /** The local marker list (settings page + battle-marker surfaces). */
  markersList: () => transport.invoke<MarkerEntry[]>(RPC.markers_list),
  /** Add or update (same nickname upserts). Returns the full list. */
  markersAdd: (
    nickname: string,
    color: MarkerColor,
    note?: string | null,
    accountId?: number | null,
  ) =>
    transport.invoke<MarkerEntry[]>(RPC.markers_add, {
      nickname,
      color,
      note: note ?? null,
      accountId: accountId ?? null,
    }),
  /** Remove one marker by nickname. Returns the remaining list. */
  markersRemove: (nickname: string) =>
    transport.invoke<MarkerEntry[]>(RPC.markers_remove, { nickname }),
  /** Batch import (the ApeRadar migration wizard): markers_add's upsert
   * semantics per item, ONE atomic write + ONE change event for the
   * batch. Returns the refreshed list plus add/update/skip counters. */
  markersImport: (entries: MarkerImportItem[]) =>
    transport.invoke<MarkerImportResult>(RPC.markers_import, { entries }),
  /** Look for 海猴雷达's WatchList.json at its default location
   * (%LOCALAPPDATA%\ApeRadar\). Null = not found (the wizard then offers
   * the manual picker). */
  aperadarScan: () =>
    transport.invoke<ApeRadarWatchList | null>(RPC.aperadar_watchlist_scan),
  /** Parse an explicitly picked WatchList.json. */
  aperadarRead: (path: string) =>
    transport.invoke<ApeRadarWatchList>(RPC.aperadar_watchlist_read, { path }),
  /** Native single-select dialog for a WatchList.json; null = cancelled. */
  aperadarPick: () =>
    transport.invoke<string | null>(RPC.aperadar_watchlist_pick),
  /** Background check of one CN battle roster against the cloud ban
   *  list. Failures are silent — the stale cache keeps serving. */
  cloudBanCheck: (players: CloudBanPlayer[], realm: string) =>
    transport.invoke<CloudBanCheckResult>(RPC.cloud_ban_check, {
      players,
      realm,
    }),
  /** Every matched player (dismissed ones included and flagged). */
  cloudBanList: () => transport.invoke<CloudBanMatch[]>(RPC.cloud_ban_list),
  /** Dismiss (or restore) one cloud match — the local false-positive
   *  judgment; the cloud list itself is untouched. */
  cloudBanDismiss: (accountId: number, dismissed: boolean) =>
    transport.invoke<null>(RPC.cloud_ban_dismiss, { accountId, dismissed }),
  cloudBanGetConfig: () =>
    transport.invoke<CloudBanConfig>(RPC.cloud_ban_get_config),
  cloudBanSetConfig: (enabled: boolean) =>
    transport.invoke<CloudBanConfig>(RPC.cloud_ban_set_config, { enabled }),
  /** markers-changed broadcast (local edits + cloud refreshes + the
   *  toggle) — the same event the bare-DOM overlays re-fetch on. */
  listenMarkersChanged: (handler: () => void) =>
    transport.listen?.("wowsp://markers-changed", handler),
};
