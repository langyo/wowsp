/**
 * Pure grouping helpers for the 游玩时间 view's battle breakdown: scope
 * filtering (all installs vs. the selected one) and four count/share
 * groupings (ship type / nation / tier / battle mode) over the
 * replay-derived PlaytimeBattle rows, plus the donut slice palettes
 * (breakdownColor) and the per-day battle counts the heatmap plots
 * (battlesDaily). Everything here is deterministic and
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
import { modeColorOfKey, modeKey } from "@/utils/modeColors";

/** The battle-derived content's scope: one install's root path (the scope
 *  menu offers every detected client) or [`SCOPE_ALL`] for every client at
 *  once. A path value rather than an index/key because the rows carry the
 *  owning install's root spelling, which path identity already compares. */
export type BattleScope = string;

/** "Every client" — the scope menu's first option and the view's default:
 *  the ledger now covers all detected clients, so "all" is a real state
 *  rather than "whatever the active install happens to be". */
export const SCOPE_ALL: BattleScope = "";

/** Which grouping a breakdown donut draws. Ship TYPE is deliberately
 *  absent from this union — its slices resolve through the app's
 *  canonical (user-tintable) ship-type-color store, so the view wires
 *  that group's colorOf itself. */
export type BreakdownGroup = "nation" | "tier" | "mode";

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

/** Filter rows to one client (the scope menu's picked install path). Path
 *  identity goes through sameGamePath (the Rust scan reports the install's
 *  root spelling, which may differ from the config store's casing or
 *  trailing separator); [`SCOPE_ALL`] passes every row through, including
 *  rows whose folder belongs to no detected install — they are visible
 *  under "all", never under a client they do not belong to. */
export function filterBattlesByScope(
  rows: PlaytimeBattle[],
  scope: BattleScope,
): PlaytimeBattle[] {
  if (!scope) return rows;
  return rows.filter((r) => sameGamePath(r.installPath, scope));
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

/** Neutral gray every unmapped breakdown key draws (the "unknown" bucket
 *  across all four groups — also the odd type/nation the DB may grow). */
export const BREAKDOWN_UNKNOWN_COLOR = "#C4BDC9";
const UNKNOWN_COLOR = BREAKDOWN_UNKNOWN_COLOR;

/** Sequential ramp of the theme's rose accent, light → deep across
 *  T1..T11 (higher tier reads deeper). Interpolated #F6CADA → #D6336C in
 *  ten even steps and written out literally so the donut and its tests
 *  stay deterministic. */
const TIER_COLORS: readonly string[] = [
  "#F6CADA",
  "#F3BBCF",
  "#F0ACC4",
  "#EC9DB9",
  "#E98EAE",
  "#E67FA3",
  "#E36F98",
  "#E0608D",
  "#DC5182",
  "#D94277",
  "#D6336C",
];

/** One distinct readable hue per canonical nation code (the exact set
 *  canonicalNation folds onto — see utils/nationFlags). Close families are
 *  stepped by lightness (uk/commonwealth, france/spain, usa/europe) so a
 *  single donut never shows two near-identical slices. */
const NATION_COLORS: Record<string, string> = {
  usa: "#4E79A7",
  japan: "#E15759",
  germany: "#9C755F",
  uk: "#59A14F",
  ussr: "#D37295",
  france: "#E6A817",
  italy: "#76B7B2",
  pan_asia: "#E8823D",
  pan_america: "#3FB6C9",
  netherlands: "#8A63D2",
  commonwealth: "#8CD17D",
  spain: "#F1CE63",
  europe: "#97BBF5",
};

/** Slice color for a breakdown entry, one palette per group: "mode"
 *  delegates to the canonical mode palette (utils/modeColors, the same
 *  colors the replay list's pills wear); "tier" indexes the rose ramp by "1".."11"; "nation" looks
 *  up the canonical code. Anything unmapped — the "unknown" bucket, a
 *  future nation the table hasn't met — draws the neutral gray. */
export function breakdownColor(group: BreakdownGroup, key: string): string {
  switch (group) {
    case "mode":
      return modeColorOfKey(key).color;
    case "tier": {
      const tier = Number(key);
      return Number.isInteger(tier) && tier >= 1 && tier <= TIER_COLORS.length
        ? TIER_COLORS[tier - 1]
        : UNKNOWN_COLOR;
    }
    case "nation":
      return NATION_COLORS[key] ?? UNKNOWN_COLOR;
  }
}

/** Distinct ownShipId count — the battles card's sub-line. Unparsed rows
 *  (null shipId) contribute nothing. */
export function distinctShipCount(rows: PlaytimeBattle[]): number {
  const ids = new Set<number>();
  for (const r of rows) if (r.ownShipId != null) ids.add(r.ownShipId);
  return ids.size;
}

/** Battles per local calendar day (from the replay filename timestamp) —
 *  the heatmap's points. Rows without a parsable dateTime (Lesta containers
 *  before the container support, corrupt names) cannot sit on a calendar
 *  and are excluded — the heatmap may undercount vs the battles card by
 *  exactly those rows. */
export function battlesDaily(rows: PlaytimeBattle[]): { date: string; value: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const date = battleDayKey(r.dateTime);
    if (!date) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** `YYYY-MM-DD` for a row's "YYYYMMDD[_HHMMSS]" filename stamp — null for
 *  rows without a parsable calendar day. The 8-char head must be digits in
 *  2000..2100 with a REAL calendar date: Date.UTC round-trips the parts so
 *  20260230 (Feb 30 rolls over) is rejected, not misdated. The key itself
 *  is rebuilt from the parsed parts — the filename stamp IS local time, and
 *  playtimeAgg's dayKey formats a Date's LOCAL fields, which would shift a
 *  UTC-constructed probe a day off behind UTC. Same zero-padded shape as
 *  dayKey, so buildHeatGrid accepts both sources' keys untouched. */
function battleDayKey(dateTime: string | null): string | null {
  if (!dateTime || dateTime.length < 8) return null;
  const head = dateTime.slice(0, 8);
  if (!/^\d{8}$/.test(head)) return null;
  const y = Number(head.slice(0, 4));
  const m = Number(head.slice(4, 6));
  const d = Number(head.slice(6, 8));
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
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
