/**
 * Ship ordering shared by the replay roster view, the live-battle panel and
 * the in-game overlay's inferred mode.
 *
 * The in-game Tab panel orders each team's rows by ONE concatenated sort
 * key, recovered by decompiling the client's own UI code (build 13187581;
 * module paths below are the game install's obfuscated script names, not
 * files of this repo — `scripts/m3dfd97e3/md12a1bb3.pyc` →
 * `AvatarSystem.__sortKeyAlive`):
 *
 *     ('A' if alive else 'B')
 *     + str(classRank)              # SORT_ORDER: carrier < battleship <
 *                                   #   cruiser < destroyer < submarine < aux
 *     + str(100 - tier)             # tier DESCENDING (T11→89 … T1→99)
 *     + str(nationRank)             # NATION.SORT_ORDER (see below)
 *     + localized ship short name   # GameParams shortName
 *     + display name                # Junk.createClanName: '[TAG]nickname'
 *
 * compared as PLAIN STRING CONCATENATION, ascending (Sorting default). The
 * class/tier prefix reproduces the previously verified block structure
 * ([alive by class+tier] ++ [sunk by class+tier]); the nation → ship name →
 * '[tag]nickname' tail resolves what earlier ground-truth checks believed
 * was an unknowable within-group residue — those checks had compared plain
 * nicknames, but the game sorts by the CLAN-TAG-PREFIXED display name, and
 * nation ranks ahead of it for different ships of the same class+tier.
 *
 * Verified against a replay + matching Tab screenshot (3v3, one class+tier
 * on both sides): ally rows Germany→Italy→PanAsia and enemy rows
 * Japan→USA→Germany, exactly the nation order below.
 *
 * Fidelity caveats, both narrow: the ship-name segment uses this DB's
 * localized name where the client uses GameParams `shortName` (identical
 * for the common short names; only two DIFFERENT same-nation same-tier
 * ships on one side depend on it), and the locale used is the app's, not
 * the game client's. The dominant tie case — a division in the SAME ship —
 * compares equal ship names and is decided by the locale-free '[tag]name'.
 *
 * This module deliberately does NOT import the model loader: the overlay
 * page is a bare-DOM static entry that must stay light, so the ship DB is
 * read directly here (the same JSON module the loader consumes — one
 * bundled copy).
 */
import shipNamesDbRaw from "@/data/ship_names.json";

interface ShipNameEntry {
  tier?: number | null;
  type?: string | null;
  nation?: string | null;
  names?: Record<string, string> | null;
}

const SHIP_DB = shipNamesDbRaw as Record<string, ShipNameEntry>;

function entryOf(shipId: number): ShipNameEntry | null {
  return SHIP_DB[String(shipId)] ?? null;
}

/** Best-effort ship class string for a ship id (offline DB only). */
export function shipTypeOf(shipId: number): string {
  return entryOf(shipId)?.type ?? "";
}

/** Ship tier from the offline DB (null when the ship is unknown there). */
export function shipTierOf(shipId: number): number | null {
  return entryOf(shipId)?.tier ?? null;
}

/** Best-effort localized ship name for a ship id (offline DB only, per the
 *  caller's locale, zh-CN fallback) — the sort key's ship-name segment. */
export function shipNameOf(shipId: number, locale: string): string {
  const e = entryOf(shipId);
  if (!e?.names) return "";
  return e.names[locale] ?? e.names["zh-CN"] ?? "";
}

/** Sort weight for a ship class: carrier > battleship > cruiser >
 *  destroyer > submarine, then everything else (event auxiliaries). */
export function shipClassRank(shipId: number): number {
  const t = shipTypeOf(shipId).toLowerCase();
  if (t.includes("aircarrier") || t.includes("aircar")) return 0;
  if (t.includes("battleship")) return 1;
  if (t.includes("cruiser")) return 2;
  if (t.includes("destroyer")) return 3;
  if (t.includes("submarine")) return 4;
  return 5;
}

/** Sort weight for a ship's tier inside its class group: the game lists
 *  HIGHER tiers first (see the module docs); -1 marks a ship the offline
 *  DB does not know (the key then pushes it after every known tier). */
export function shipTierWeight(shipId: number): number {
  const tier = entryOf(shipId)?.tier;
  return typeof tier === "number" ? tier : -1;
}

/** The client's `NATION.SORT_ORDER` (`shared_constants/m2022a5a9.pyc` of
 *  the game install — paths here refer to decompiled CLIENT code, not
 *  files in this repo), as nation codes of the offline DB. Indexes 10+
 *  are two-digit strings, so the concatenated key lexicographically
 *  reorders them ahead of single digits ('10' < '9') — the client's own
 *  concatenation does the same, and faithfulness beats tidiness here. */
const NATION_SORT_ORDER: readonly string[] = [
  "japan",
  "usa",
  "russia",
  "germany",
  "united_kingdom",
  "france",
  "italy",
  "pan_asia",
  "europe",
  "netherlands",
  "commonwealth",
  "pan_america",
  "spain",
  "events",
  "common",
];

/** Sort weight for a ship's nation inside its (class, tier) group, per the
 *  client's NATION.SORT_ORDER (see the module docs). The unknown marker
 *  sorts after every known one — see gameTabRowKey's sentinel note. */
export function nationSortRank(shipId: number): number {
  const nation = entryOf(shipId)?.nation ?? "";
  const idx = NATION_SORT_ORDER.indexOf(nation);
  return idx >= 0 ? idx : NATION_SORT_ORDER.length;
}

/** The client's `Junk.createClanName`: '[TAG]nickname' with a clan tag,
 *  the bare nickname without one. This is the exact string the game's Tab
 *  sort compares, and what the in-game table renders. */
export function tabDisplayName(name: string, clanTag?: string | null): string {
  return clanTag ? `[${clanTag}]${name}` : name;
}

/** The roster entry shape the full Tab sort key needs. */
export interface TabSortVehicle {
  shipId: number;
  name: string;
  /** Clan tag from the WG batch answer (absent = clanless / not yet
   *  landed — the key then uses the bare nickname and re-derives when the
   *  tag arrives). */
  clanTag?: string | null;
}

/** The game's full Tab row key, as one string — replicate the client's
 *  concatenation EXACTLY (see the module docs): comparing these strings
 *  reproduces the on-screen row order of a team block, alive-first and
 *  sunk-last included. Unknown DB ships get '~' segments that sort after
 *  every real digit (the game itself never has unknowns, so the sentinel
 *  is ours alone — it only keeps such rows deterministic and last).
 *  `locale` picks the ship-name segment's language (zh-CN fallback). */
export function gameTabRowKey(
  vehicle: TabSortVehicle,
  alive: boolean,
  locale: string,
  clanTagOf?: (name: string) => string | null | undefined,
): string {
  const tier = shipTierWeight(vehicle.shipId);
  const nation = nationSortRank(vehicle.shipId);
  const tierSegment = tier < 0 ? "~" : String(100 - tier);
  const nationSegment =
    nation >= NATION_SORT_ORDER.length ? "~" : String(nation);
  const tag = clanTagOf?.(vehicle.name) ?? vehicle.clanTag ?? null;
  return (
    (alive ? "A" : "B") +
    String(shipClassRank(vehicle.shipId)) +
    tierSegment +
    nationSegment +
    shipNameOf(vehicle.shipId, locale) +
    tabDisplayName(vehicle.name, tag)
  );
}
