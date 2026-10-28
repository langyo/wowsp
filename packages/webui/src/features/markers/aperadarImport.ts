/** ApeRadar (海猴雷达) watch-list → player-markers import: the PURE
 *  mapping pipeline the settings wizard renders — status→color mapping
 *  (Negtive/Cheater only; Positive and unknown spellings never import),
 *  category filter, cross-server dedupe by lowercased nickname, existing
 *  markers flags and the final MarkerImportItem[] build. No Vue / store /
 *  transport here, so the whole contract is unit-testable in isolation. */
import type {
  ApeRadarWatchList,
  MarkerColor,
  MarkerImportItem,
} from "@/api";

/** The statuses WoWSP imports, with their marker colors. Upstream's own
 *  spelling — typos included ("Negtive") — is part of the file format. */
const STATUS_COLORS: Record<string, MarkerColor> = {
  Negtive: "red",
  Cheater: "yellow",
};

/** The importable color for one raw status; null = never imported
 *  (Positive, unknown spellings, junk). */
export function statusToColor(status: string): MarkerColor | null {
  return STATUS_COLORS[status] ?? null;
}

/** The wizard's category toggles. Positive is absent by design: WoWSP has
 *  no positive mark, so its row renders disabled and never selects. */
export interface ApeRadarCategorySelection {
  negtive: boolean;
  cheater: boolean;
}

/** One preview row — what the wizard shows and what an import would write. */
export interface ApeRadarPreviewRow {
  /** Raw server tag from the file (e.g. "ASIA" / "CN"). */
  server: string;
  /** Raw nickname from the file (the backend upserts by nickname). */
  nickname: string;
  color: MarkerColor;
  /** Numeric account id when the file carries one; null otherwise. */
  accountId: number | null;
  /** The nickname already exists in the markers store (case-insensitive). */
  exists: boolean;
}

/** The wizard's preview: filtered, deduped rows plus the counters. */
export interface ApeRadarPreview {
  rows: ApeRadarPreviewRow[];
  counts: {
    /** Importable players after filter + dedupe (the header's {n}). */
    total: number;
    /** How many of them the import would UPDATE (already marked). */
    existing: number;
  };
}

/** The same normalization the markers store keys nicknames by. */
function normNickname(name: string): string {
  return name.trim().toLowerCase();
}

/** The backend wants a numeric account id; the file may carry a numeric
 *  string (or junk) — keep only what parses as a non-negative integer. */
function numericAccountId(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** Build the wizard's preview from a parsed watch list:
 *  - keep only statuses that map to a color AND whose category is on;
 *  - dedupe by lowercased nickname — the backend upserts by nickname, so
 *    a cross-server duplicate would just overwrite itself; the FIRST
 *    entry in data order (servers array, players within) wins and later
 *    duplicates are simply not shown;
 *  - flag nicknames that already exist in the markers store
 *    (case-insensitive — the same compare the upsert will use). */
export function buildApeRadarPreview(
  list: ApeRadarWatchList,
  selection: ApeRadarCategorySelection,
  existingNicknames: Iterable<string>,
): ApeRadarPreview {
  const existing = new Set(Array.from(existingNicknames, normNickname));
  const seen = new Set<string>();
  const rows: ApeRadarPreviewRow[] = [];
  let existingCount = 0;
  for (const server of list.servers) {
    for (const player of server.players) {
      const color = statusToColor(player.status);
      if (color == null) continue; // Positive / unknown — never imported
      if (color === "red" && !selection.negtive) continue;
      if (color === "yellow" && !selection.cheater) continue;
      const key = normNickname(player.name);
      if (!key) continue; // a blank name cannot be marked
      if (seen.has(key)) continue; // cross-server duplicate — first won
      seen.add(key);
      const exists = existing.has(key);
      if (exists) existingCount += 1;
      rows.push({
        server: server.server,
        nickname: player.name,
        color,
        accountId: numericAccountId(player.accountId),
        exists,
      });
    }
  }
  return { rows, counts: { total: rows.length, existing: existingCount } };
}

/** Map preview rows to the batch-import wire items (note stays null —
 *  the file carries no note; accountId passes through when numeric). */
export function rowsToImportItems(rows: ApeRadarPreviewRow[]): MarkerImportItem[] {
  return rows.map((row) => ({
    nickname: row.nickname,
    color: row.color,
    note: null,
    accountId: row.accountId,
  }));
}
