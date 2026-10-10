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
 * CN clients diverge (360 build 13243917 / 15.8.1, observed 2026-10-07 on
 * a real co-op Tab screenshot): within a (class, tier) group the rows
 * follow the LOCALIZED ship name in the client's own collation —
 * 海尔德兰(NLD) → 杰克逊港(CW) → 切斯特(USA) → 韦茅斯(UK), i.e. hǎi <
 * jié < qiè < wéi pinyin order — and the nation rank DOES NOT apply
 * (the decompiled order predicts 切斯特→韦茅斯→海尔德兰→杰克逊港 for that
 * same group, contradicted 4/4). The group also never re-sorts mid-battle
 * on that client: sunk rows dim IN PLACE (see overlay/inferredOrder's
 * static CN layout). {@link gameTabRowCompare} carries the
 * ship-name-order variant, gated per surface on the detected realm.
 *
 * The Lesta client renders its OWN sort-key order — settled by the
 * 2026-10-10 live capture (realm ru, the probe's bridged `sortKeys`
 * reproduced the rendered Tab row for row, equal keys keeping the
 * roster's own order). The earlier "shares the CN ship-name order"
 * reading of the 2026-10-09 capture (one 博加特里/Bogatyr row leading two
 * 圣路易斯/St. Louis rows) was a MISREAD: that order is Lesta's own
 * NATION.SORT_ORDER ranking russia FIRST (its keys read e.g.
 * "2970PRSC103" — nation 0 = russia, and an internal shortName code
 * where the WG key carries the localized name). Two consequences:
 * `realmUsesShipNameOrder` is CN-only now, and this module's offline
 * WG-family key stays an APPROXIMATION for ru (class + tier right; the
 * nation segment ranks russia 2nd, not 1st; the name segment compares
 * localized names, not the internal codes) — the plugin's sortKeys are
 * the game-truth there, and the exact-grade sort breaks equal keys by
 * the roster order, not the '[TAG]name' concatenation (see
 * liveTabOrder/inferredOrder's tieByRosterOrder).
 *
 * The ship-name order's segment reads the app locale like the rest of
 * the key (the pre-existing caveat above — the game's OWN locale is not
 * observable from here). A zh app locale reproduces the CN client's order
 * exactly; a non-zh app locale falls back to collating that locale's
 * names, which orders differently from the client's zh table — a narrow
 * degradation for a configuration whose game client is zh in practice
 * (the observed CN client was zh).
 *
 * Treat the whole matrix as UNSTABLE per-client knowledge: the rendered
 * order is what each vendor's HUD does, it diverges despite shared code
 * lineage (360-CN renders a ship-name order its OWN scripts do not
 * compute — the divergence sits in the view layer), and any client
 * update can move it. Recalibrate per realm per build against rendered
 * captures. The plugin-first fix SHIPPED (2026-10-09): the probe bridges
 * each player's client-side Tab sort key (`sortKeys` in telemetry — read
 * off the avatars' ship components) and the live panel sorts by it,
 * exact whenever the map covers the roster (WG family and Lesta — the
 * latter with equal keys keeping the roster order; a ship-name-order
 * client stands the override down); THIS module's inference remains the
 * fallback for battles without the keys
 * (docs/en/designs/ingame-stats-plugin.md, "Ordering rule").
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
 *  `locale` picks the ship-name segment's language (zh-CN fallback).
 *
 *  CN clients (360 build 13243917, observed 2026-10-07) order the
 *  within-(class, tier) group by the LOCALIZED ship name in the client's
 *  own collation instead — the decompiled nation rank does not apply there
 *  (see {@link gameTabRowCompare}
 *  for the ship-name-order variant; the
 *  plain-string concatenation cannot express the pinyin collation, so that
 *  variant must go through the comparator, not this key). */
export function gameTabRowKey(
  vehicle: TabSortVehicle,
  alive: boolean,
  locale: string,
  clanTagOf?: (v: TabSortVehicle) => string | null | undefined,
): string {
  const tier = shipTierWeight(vehicle.shipId);
  const nation = nationSortRank(vehicle.shipId);
  const tierSegment = tier < 0 ? "~" : String(100 - tier);
  const nationSegment =
    nation >= NATION_SORT_ORDER.length ? "~" : String(nation);
  const tag = clanTagOf?.(vehicle) ?? vehicle.clanTag ?? null;
  return (
    (alive ? "A" : "B") +
    String(shipClassRank(vehicle.shipId)) +
    tierSegment +
    nationSegment +
    shipNameOf(vehicle.shipId, locale) +
    tabDisplayName(vehicle.name, tag)
  );
}

/** Collator for the ship-name segment under the ship-name row order (the
 *  the CN client). The client orders same-(class, tier) ships by
 *  their localized name in a
 *  hanzi collation that matches PINYIN order (consistent with the GB2312
 *  code order the client's locale machinery produces — the exact mechanism
 *  is not observable from here; what IS observable is the rendered order).
 *  Plain UTF-16 comparison does NOT reproduce it: 切 U+5207 sorts before
 *  海 U+6D77 as code units, while the client renders 海尔德兰 ahead of
 *  切斯特. Lazy: built on first use, reused across renders. */
let pinyinCollator: Intl.Collator | null = null;
function nameCollator(): Intl.Collator {
  pinyinCollator ??= new Intl.Collator(["zh-Hans-CN-u-co-pinyin", "zh-Hans-CN", "zh"], {
    sensitivity: "variant",
  });
  return pinyinCollator;
}

/** Options for {@link gameTabRowCompare} — the shape every Tab-order sort
 *  call site already has in hand. NOTE the comparator never compares the
 *  alive prefix: every caller sorts ONE layout (the full key order) and
 *  applies any [alive] ++ [sunk] split itself — a future caller sorting a
 *  MIXED list through this alone would silently lose that split. */
export interface TabRowCompareOptions {
  locale: string;
  /** Clan tag per VEHICLE — from the WG batch answer (absent = clanless /
   *  not yet landed; the entry then compares as a bare nickname). */
  clanTagOf?: (v: TabSortVehicle) => string | null | undefined;
  /** CN client row order (localized ship name collated by pinyin,
   *  nation demoted to tiebreak — see the module docs; the Lesta client
   *  was moved off this permutation by the 2026-10-10 live capture).
   *  Absent/false keeps the decompiled nation-rank concatenation. */
  shipNameOrder?: boolean;
}

/** Compare two roster entries by the client's Tab row order. The nation
 *  order degenerates to the plain concatenated {@link gameTabRowKey}
 *  (byte-identical to comparing the key strings); the ship-name order
 *  (the CN client) compares the same segments in the observed
 *  permutation — class, tier, LOCALIZED SHIP NAME, then nation, then the
 *  '[TAG]nickname' display name — with BOTH text segments routed through
 *  the pinyin collator
 *  (the client compares its whole concatenated key in its own collation,
 *  which for hanzi is pinyin order — see {@link nameCollator}). Both
 *  entries of one comparison always share the same alive state (each sort
 *  orders ONE layout — the full key order), so the alive prefix never
 *  decides here and is not compared. A ship the offline DB does not know
 *  sorts after every known one inside its class group under either order
 *  (the '~'-segment sentinel, kept explicit here so the name-order branch
 *  inherits the same determinism guarantee). */
export function gameTabRowCompare(
  a: TabSortVehicle,
  b: TabSortVehicle,
  opts: TabRowCompareOptions,
): number {
  if (!opts.shipNameOrder) {
    const ka = gameTabRowKey(a, true, opts.locale, opts.clanTagOf);
    const kb = gameTabRowKey(b, true, opts.locale, opts.clanTagOf);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }
  const tierA = shipTierWeight(a.shipId);
  const tierB = shipTierWeight(b.shipId);
  const nationA = nationSortRank(a.shipId);
  const nationB = nationSortRank(b.shipId);
  // Segment order mirrors the legacy key's structure: class first, then the
  // unknown-DB tier sentinel INSIDE the class group (the legacy '~' tier
  // segment sorts after every real digit WITHIN a class — an unknown ship
  // never jumps a class boundary), then tier. The nation's own unknown
  // marker needs no separate arm: it only breaks name ties, and an unknown
  // nation's rank (the sentinel length) already sorts last there. The alive
  // prefix ('A'/'B') is identical for both entries of one comparison — the
  // caller sorts one layout at a time — so it never decides here.
  const classA = shipClassRank(a.shipId);
  const classB = shipClassRank(b.shipId);
  if (classA !== classB) return classA - classB;
  const tierKnownA = tierA >= 0;
  const tierKnownB = tierB >= 0;
  if (tierKnownA !== tierKnownB) return tierKnownA ? -1 : 1;
  if (tierA !== tierB) {
    // Descending tier, ascending compared — mirror the '100-tier' segment.
    return tierA < tierB ? 1 : -1;
  }
  // The client compares its whole concatenated key in ITS collation, so
  // every TEXT segment on the name-order path — the ship name AND the
  // '[TAG]nickname' display name — goes through the same collator here (a
  // hanzi nickname tie between division twins would otherwise order by
  // code unit and diverge: 用户_… U+7528 before 神楽坂柚咲 U+795E, while
  // pinyin puts shén first). Each segment falls THROUGH on a collator tie
  // so the later segments still decide deterministically.
  const nameA = shipNameOf(a.shipId, opts.locale);
  const nameB = shipNameOf(b.shipId, opts.locale);
  if (nameA !== nameB) {
    const c = nameCollator().compare(nameA, nameB);
    if (c !== 0) return c;
  }
  if (nationA !== nationB) return nationA - nationB;
  const displayA = tabDisplayName(a.name, opts.clanTagOf?.(a) ?? a.clanTag ?? null);
  const displayB = tabDisplayName(b.name, opts.clanTagOf?.(b) ?? b.clanTag ?? null);
  if (displayA !== displayB) {
    const c = nameCollator().compare(displayA, displayB);
    if (c !== 0) return c;
  }
  return 0;
}
