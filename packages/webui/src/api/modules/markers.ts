/** Player-markers domain (玩家标记): the LOCAL, user-built list of marked
 *  players with one of three colors. Mirrors wowsp_tauri_shared::markers.
 *  Strictly local data — no login, no sync, no upload. */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

/** The three marker colors and their meanings. */
export type MarkerColor = "red" | "yellow" | "purple";

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
};
