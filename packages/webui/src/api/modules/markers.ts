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
};
