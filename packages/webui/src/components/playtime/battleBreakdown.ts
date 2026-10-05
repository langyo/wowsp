/**
 * Pure grouping helpers for the 游玩时间 view's battle breakdown: scope
 * filtering (all installs vs. the selected one) and four count/share
 * groupings (ship type / nation / tier / battle mode) over the
 * replay-derived PlaytimeBattle rows. Everything here is deterministic and
 * side-effect-free — the view owns localization and rendering, the tests
 * pin the buckets (same contract as playtimeAgg).
 *
 * Ship identity (type/nation/tier) comes from the offline ship DB
 * (`src/data/ship_names.json`). This module deliberately does NOT import
 * the holographic model loader — that drags three.js into whichever chunk
 * imports it — so the ship DB is read directly here, the same one-bundled-
 * copy pattern as utils/shipClass.ts. Rows whose ship (or a field of it)
 * cannot be resolved land in the "unknown" bucket.
 */
import type { PlaytimeBattle, PlaytimeOverview } from "@/api";
import shipNamesDbRaw from "../../data/ship_names.json";
import { sameGamePath } from "@/utils/gamePath";
import { canonicalNation } from "@/utils/nationFlags";
import { modeKey } from "@/utils/modeColors";

/** Which installs the battle-derived content counts. */
export type BattleScope = "all" | "selected";

/** One labelled count row of a breakdown group. */
export interface BreakdownEntry {
  key: string;
  count: number;
  /** count / total (0 when the group is empty). */
  share: number;
}

interface ShipDbEntry {
  tier?: number | null;
  type?: string | null;
  nation?: string | null;
}

const SHIP_DB = shipNamesDbRaw as Record<string, ShipDbEntry>;

/** The offline DB entry behind a battle's ownShipId (null when the ship is
 *  unknown or the row is an unparsed replay with no ship at all). */
function shipEntryOf(b: PlaytimeBattle): ShipDbEntry | null {
  if (b.ownShipId == null) return null;
  return SHIP_DB[String(b.ownShipId)] ?? null;
}

/** Filter rows to the active install when scope === "selected". Path
 *  identity goes through sameGamePath (the Rust scan reports the install's
 *  root spelling, which may differ from the config store's casing or
 *  trailing separator); an empty/absent active path falls back to ALL rows
 *  — "selected" without a selection would otherwise blank the section. */
export function filterBattlesByScope(
  rows: PlaytimeBattle[],
  scope: BattleScope,
  activeInstallPath: string | null | undefined,
): PlaytimeBattle[] {
  if (scope !== "selected" || !activeInstallPath) return rows;
  return rows.filter((r) => sameGamePath(r.installPath, activeInstallPath));
}

/** Count rows per key → share-scaled entries sorted by count desc (ties:
 *  key asc). */
function finalize(counts: Map<string, number>): BreakdownEntry[] {
  const total = Array.from(counts.values()).reduce((a, v) => a + v, 0);
  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      count,
      share: total > 0 ? count / total : 0,
    }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The game's five ship-type strings the offline DB carries for playable
 *  classes (no key is a prefix of another, so the startsWith match below
 *  never mis-buckets). Auxiliary event ships and anything else fall to
 *  "unknown". */
const TYPE_KEYS = ["AirCarrier", "Battleship", "Destroyer", "Submarine", "Cruiser"];

function typeKeyOf(b: PlaytimeBattle): string {
  const type = shipEntryOf(b)?.type ?? "";
  const hit = TYPE_KEYS.find((k) => type.startsWith(k));
  return hit ?? "unknown";
}

/** Group by ship type (English game type string resolved through the
 *  offline DB). */
export function breakdownByType(rows: PlaytimeBattle[]): BreakdownEntry[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = typeKeyOf(r);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return finalize(counts);
}

/** Group by nation. The offline DB's game-file spellings
 *  ("united_kingdom"/"russia") are canonicalized to the app-wide codes
 *  ("uk"/"ussr") so both never split into two rows; non-nations ("events")
 *  and unknown ships land in "unknown". */
export function breakdownByNation(rows: PlaytimeBattle[]): BreakdownEntry[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const nation = canonicalNation(shipEntryOf(r)?.nation ?? "");
    const key = nation || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return finalize(counts);
}

/** Group by tier — key "1".."11"; ships without a resolvable 1..11 tier
 *  (event ships, unknown ships) land in "unknown". */
export function breakdownByTier(rows: PlaytimeBattle[]): BreakdownEntry[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const tier = shipEntryOf(r)?.tier;
    const key = typeof tier === "number" && tier >= 1 && tier <= 11 ? String(tier) : "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = Array.from(counts.values()).reduce((a, v) => a + v, 0);
  const entries = [...counts.entries()].map(([key, count]) => ({
    key,
    count,
    share: total > 0 ? count / total : 0,
  }));
  // Tier reads low → high (the tech-tree direction); "unknown" sorts last
  // whatever counts say.
  return entries.sort((a, b) => {
    const ta = tierRank(a.key);
    const tb = tierRank(b.key);
    return ta - tb || a.key.localeCompare(b.key);
  });
}

/** Numeric sort rank of a tier key; Infinity pushes "unknown" last. */
function tierRank(key: string): number {
  return key === "unknown" ? Infinity : Number(key);
}

/** Group by battle mode — the canonical mode classifier shared with the
 *  replay list (utils/modeColors modeKey) fed with the descriptor's layered
 *  identity fields. Rows with no mode fingerprint at all land in
 *  "unknown". */
export function breakdownByMode(rows: PlaytimeBattle[]): BreakdownEntry[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = modeKey(r.matchGroup, r.scenario, r.eventType, r.botCount, r.scriptedUnitCount) || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return finalize(counts);
}

/** Distinct ownShipId count — the battles card's sub-line. Unparsed rows
 *  (null shipId) contribute nothing. */
export function distinctShipCount(rows: PlaytimeBattle[]): number {
  const ids = new Set<number>();
  for (const r of rows) if (r.ownShipId != null) ids.add(r.ownShipId);
  return ids.size;
}

/** When the battle rows could have changed on disk: fresh replay files only
 *  land while a client is running or within a poll of it exiting, so the
 *  store refetches the (potentially large) battles payload only when this
 *  key moves — "running" while a launch is open, otherwise the launch
 *  identity. An idle ledger keeps its last fetch forever. */
export function battlesActivityKey(
  o: Pick<PlaytimeOverview, "launchCount" | "lastLaunch"> | null,
): string {
  if (!o) return "none";
  if (o.lastLaunch?.running) return "running";
  return `${o.launchCount}:${o.lastLaunch?.start ?? 0}`;
}
