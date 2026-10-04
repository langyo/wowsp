import type { CatalogEntry } from "@/api";

/** Whether a catalog entry is listed. A delisted entry (its discussion
 *  thread was closed — the withdrawal signal the indexer reads) stays in
 *  the index only so deep links can explain the state; lists, chips,
 *  counts and search never show it. */
export function isListed(entry: CatalogEntry): boolean {
  return !entry.delisted;
}

/** The listed subset of a catalog — what the sidebar renders. */
export function listedEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return entries.filter(isListed);
}
