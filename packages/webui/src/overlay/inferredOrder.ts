/**
 * Rule-derived row→name mapping for the in-game overlay ("inferred" roster
 * mode — the default).
 *
 * The Rust watcher supplies the row GRID and the per-row alive flags (pure
 * luma — no text recognition); this module turns the arena roster into the
 * names for those rows by replicating the client's own Tab sort key,
 * recovered from the decompiled UI code (see utils/shipClass's module
 * docs): one concatenated string per player —
 *
 *     alive('A'/'B') + classRank + (100-tier) + nationRank
 *     + localized ship name + '[TAG]nickname'
 *
 * — compared ascending. At battle start that is the table's exact order
 * ON THE VERIFIED WG-FAMILY CLIENTS (the per-client permutations — CN and
 * Lesta render a different order — are the caller's `shipNameOrder` flag;
 * see utils/shipClass's module docs for the unstable matrix): every row
 * maps to one player (the former "tie group" residue is decided
 * by nation → ship name → clan-tag-prefixed display name, all derivable
 * from the offline ship DB plus the WG batch's clan tags). Verified
 * against a replay + matching Tab screenshot; see shipClass.ts.
 *
 * Mid-battle, once ships sink, the table re-sorts ([alive] ++ [sunk], each
 * block in the same key order) and the luma vector alone only reports HOW
 * MANY rows read alive — not WHICH players they are. Two answers build on
 * that: (1) the sink fast-path's strip-fingerprint solver NAMES the
 * victims (`wowsp://sink-attrib` — utils/sunkTracker keeps a per-side
 * TRUSTED sunk set), and a side whose set matches the observed sunk count
 * renders the exact [alive by key] ++ [sunk by key] layout, every row
 * pinned; (2) a side without a trusted set falls back to provable
 * CANDIDATE RANGES: a player at full-order position r can only land on
 * alive-row k when k ≤ r ≤ k + sunkCount (and on sunk-row j when
 * j ≤ r ≤ j + aliveCount), so each row's candidates form a contiguous
 * range of the full order, rendered as one slash-joined winrate chip
 * (overlay main.ts). All-sunk collapses back to the exact full order,
 * same as battle start. Rows past the roster stay `null`.
 *
 * Fidelity limits, both narrow: a ship missing from the offline DB keeps
 * a deterministic after-everything key (may misplace relative to the
 * client), and the ship-name segment follows the APP's locale rather than
 * the game client's — only two different same-nation same-tier ships on
 * one side depend on that segment at all; the common tie (a division in
 * the same ship) is decided by the locale-free '[tag]name'. Scripted
 * scenario units (`IDS_*` nicknames) render under LOCALIZED names in-game
 * (e.g. the tutorial fill `IDS_AL_01` → zh `：舍尔：`), so their key order
 * may differ from the client's — but only the tutorial-family battles
 * (low_lvl_operation / first_battle / IDS_OP_15_*, where the game fields
 * them as real team rows) feed them here at all: real operations (行动)
 * render the human team only, and the caller drops their scripted units
 * up front (utils/rosterSides's splitLiveRosterSides — the sides this
 * module receives are exactly the rows the game draws).
 *
 * CN clients (realm 'cn' — the 360 build) break both of the assumptions
 * above, so the callers pass `shipNameOrder` + `staticLayout` (see the
 * options): rows order by the LOCALIZED SHIP NAME in the client's own
 * pinyin collation (never the decompiled nation rank — observed 9/9 on a
 * real Tab capture, and 4/4 AGAINST nation order inside one cruiser
 * group), and the table never re-sorts — sunk rows dim IN PLACE at their
 * battle-start positions (a 5-dead ally block was still interleaved with
 * alive rows), so the alive vector and the trusted sunk sets must not
 * drive positions there: the [alive] ++ [sunk] split and the candidate
 * ranges would pin provably wrong names (they shipped a human's row onto
 * a bot's name under the wrong order). The callers keep using the per-row
 * alive flags for the sunk chip styling.
 *
 * The Lesta client (realm 'ru') shares the row ORDER (observed 2026-10-09:
 * one Bogatyr row led two St. Louis rows in a tier-III cruiser group,
 * against the usa < russia nation rank) but NOT the static layout — no
 * Lesta capture has diverged from the WG [alive] ++ [sunk] regroup, so
 * the callers pass `shipNameOrder` alone there and the full blockwise
 * machinery below stays live for it.
 */
import type { RosterSides } from "@/utils/rosterSides";
import {
  gameTabRowCompare,
  tabDisplayName,
  type TabRowCompareOptions,
} from "@/utils/shipClass";

/** The roster entry shape the mapping needs (the wire's `VehicleEntry`). */
export interface InferredVehicle {
  name: string;
  relation: number;
  shipId: number;
}

/** Extra inputs for the full sort key. */
export interface InferredOrderOptions {
  /** Locale for the key's ship-name segment (default en-US, like the
   *  overlay page's URL-param default). */
  locale?: string;
  /** Clan tag lookup for the key's display-name segment ('[TAG]name');
   *  absent entries compare as bare nicknames and re-derive when the WG
   *  batch lands the tag (the caller re-renders on stats arrival). */
  clanTagOf?: (name: string) => string | null | undefined;
  /** CN/Lesta client row order (localized ship name, pinyin-collated —
   *  see utils/shipClass's module docs). Absent keeps the decompiled
   *  nation-rank order verified on WG clients. */
  shipNameOrder?: boolean;
  /** CN clients never re-sort the table mid-battle: sunk rows dim IN
   *  PLACE at their battle-start positions (observed 2026-10-07 — a 5-dead
   *  ally block still interleaved alive rows). `true` maps every row of a
   *  side to the full key order verbatim and ignores the alive vector and
   *  the trusted sunk sets for POSITIONING entirely — the callers keep
   *  using the per-row alive flags for the sunk chip styling. */
  staticLayout?: boolean;
  /** TRUSTED sunk sets per side (utils/sunkTracker): when a side's set is
   *  present AND matches the alive vector's sunk count, that side renders
   *  the EXACT layout — [alive by key] ++ [sunk by key], every row named —
   *  instead of candidate ranges. null/absent sides keep the ranges.
   *  Ignored under `staticLayout` (see above). */
  sunk?: { ally?: Set<string> | null; enemy?: Set<string> | null } | null;
  /** Game-true TAB sort keys per name (telemetry `sortKeys`, read off the
   *  avatars' ship components — the client's own ShipSystem key string).
   *  When EVERY entry of a side's list yields a non-empty key, the sort
   *  switches to the CLIENT's own comparison — key + '[TAG]nickname'
   *  ascending, exactly __sortKeyAlive's concatenated string — on every
   *  realm, and the offline per-realm inference is not consulted at all.
   *  Any entry missing a key disables the override wholesale (game-true
   *  and inferred rows must never interleave). */
  sortKeyOf?: (name: string) => string | undefined;
}

/** One side's believed full-key order — the rows as the game drew them at
 *  battle start. Sorting goes through {@link gameTabRowCompare} so the
 *  ship-name permutation (CN/Lesta clients; pinyin collation — plain
 *  string comparison cannot express it) and the decompiled nation order
 *  share one code path — unless the game's own sort keys cover the list,
 *  in which case the client's exact key + display-name comparison takes
 *  over entirely. */
function sideFullOrder<T extends InferredVehicle>(
  list: T[],
  options: InferredOrderOptions,
): string[] {
  const locale = options.locale ?? "en-US";
  const compareOptions: TabRowCompareOptions = {
    locale,
    // The module's clanTagOf contract is name-keyed (the overlay page's
    // stats cache is name-keyed); the comparator looks up per vehicle.
    clanTagOf: options.clanTagOf ? (v) => options.clanTagOf?.(v.name) : undefined,
    shipNameOrder: options.shipNameOrder,
  };
  // Game-true sort keys: only a FULLY covered list switches the sort to
  // the client's own comparison (plain code-unit compare matches the
  // client's Python str ordering); anything less keeps the offline
  // inference for the WHOLE side — no interleaving.
  const keyOf = options.sortKeyOf;
  const clientKeys =
    keyOf && list.length > 0
      ? list.map((v) => keyOf(v.name))
      : null;
  const useClientKeys =
    clientKeys != null && clientKeys.every((k) => typeof k === "string" && k.length > 0);
  const clientKeyOf = useClientKeys
    ? (v: T) => {
        const key = keyOf!(v.name);
        return key + tabDisplayName(v.name, options.clanTagOf?.(v.name) ?? null);
      }
    : null;
  return list
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      if (clientKeyOf) {
        const ka = clientKeyOf(a.v);
        const kb = clientKeyOf(b.v);
        return ka < kb ? -1 : ka > kb ? 1 : a.i - b.i;
      }
      const c = gameTabRowCompare(a.v, b.v, compareOptions);
      return c !== 0 ? c : a.i - b.i;
    })
    .map(({ v }) => v.name);
}

/** One row's attribution:
 *  - a `string` pins the row to that player (battle start, all-sunk, and
 *    every range of width 1 mid-battle);
 *  - a `string[]` is the provable CANDIDATE RANGE of a row once sinks
 *    made the alive subset unknowable (contiguous in full-key order);
 *  - `null` is honest silence — a row beyond the roster. */
export type RowAttribution = string | string[] | null;

/**
 * Map the roster onto the detected rows: allies block first, enemies after.
 * `alive` is the anchor's per-row alive vector aligned with the CURRENT
 * row grid (the game re-sorts sunk rows below alive ones, so the vector is
 * blockwise [true…true, false…false]; null/absent = unknown → battle
 * start). Entry `k` of the result is row `k`'s attribution — see
 * {@link RowAttribution}.
 *
 * The sides arrive PRE-SPLIT from the caller (utils/rosterSides's
 * `splitLiveRosterSides` — exactly the rows the game's own table draws),
 * so the block layout below is the caller's layout verbatim: allies
 * entries first, enemies after, no second relation split to drift out of
 * sync with the chip blocks.
 *
 * `staticLayout` (CN clients) collapses ALL of that to the battle-start
 * full order per side — the client keeps row positions for the whole
 * battle, so the re-sort/candidate-range machinery below must not run
 * (its blockwise alive-vector assumptions are false there, and a degraded
 * range would pin a WRONG name with battle-start confidence — the
 * misattribution this module shipped to fix).
 */
export function inferredRowMapping(
  sides: RosterSides<InferredVehicle>,
  alive: boolean[] | null,
  options: InferredOrderOptions = {},
): RowAttribution[] {
  const out: RowAttribution[] = [];
  let offset = 0;
  const sidePairs: Array<[InferredVehicle[], "ally" | "enemy"]> = [
    [sides.allies, "ally"],
    [sides.enemies, "enemy"],
  ];
  for (const [list, sideKey] of sidePairs) {
    const full = sideFullOrder(list, options);
    const n = full.length;
    if (options.staticLayout) {
      for (const name of full) out.push(name);
      offset += n;
      continue;
    }
    // Alive count from the CURRENT-layout flags: the last true row's
    // position + 1 (blockwise by construction; a null vector = nobody
    // sunk, and an all-false side reads 0 → the exact full order again).
    const sideFlags = alive == null ? null : alive.slice(offset, offset + n);
    const aliveCount = sideFlags == null ? n : sideFlags.lastIndexOf(true) + 1;
    const sunkCount = n - aliveCount;
    // TRUSTED sunk set (sink attribution solved the transition): the exact
    // layout is the full order split by membership — [alive by key] ++
    // [sunk by key], the same permutation the game just applied. Only a
    // set that agrees with the observed sunk count may drive it; anything
    // else keeps the provable ranges below (the caller degrades the side).
    const sunkSet = sideKey === "ally" ? options.sunk?.ally : options.sunk?.enemy;
    if (sunkSet && sunkSet.size === sunkCount) {
      for (const name of full) if (!sunkSet.has(name)) out.push(name);
      for (const name of full) if (sunkSet.has(name)) out.push(name);
      offset += n;
      continue;
    }
    // Alive row k holds the player at full-order position r with
    // k ≤ r ≤ k + sunkCount; sunk row j mirrors it with j ≤ r ≤ j + aliveCount.
    for (let k = 0; k < aliveCount; k++) {
      out.push(rangeNames(full, k, k + sunkCount));
    }
    for (let j = 0; j < sunkCount; j++) {
      out.push(rangeNames(full, j, j + aliveCount));
    }
    offset += n;
  }
  return out;
}

/** The full-order slice [lo, hi] as one row's attribution — a singleton
 *  when the range collapses, the candidate list otherwise. */
function rangeNames(full: string[], lo: number, hi: number): RowAttribution {
  const l = Math.max(0, Math.min(lo, full.length - 1));
  const h = Math.max(l, Math.min(hi, full.length - 1));
  return l === h ? full[l] : full.slice(l, h + 1);
}

/**
 * Plugin-authoritative row mapping: the in-game plugin's alive telemetry is
 * the truth, so the split by sunk-set membership is UNCONDITIONAL — no
 * alive-vector agreement check, no candidate ranges. Every row gets exactly
 * one name (a sink the detector missed leaves that row chipless in the
 * caller's 1:1 positional zip instead of misattributing a player onto it).
 *
 * Same block structure as {@link inferredRowMapping}: the caller's PRE-SPLIT
 * sides (utils/rosterSides's `splitLiveRosterSides`), allies first, enemies
 * after. `staticLayout` (CN clients — the table never re-sorts there) keeps
 * the full key order verbatim; the plugin's sets then drive only the SUNK
 * STYLING in the caller, never the positions.
 */
export function pluginRowMapping(
  sides: RosterSides<InferredVehicle>,
  sunk: { ally?: Set<string> | null; enemy?: Set<string> | null },
  options: InferredOrderOptions = {},
): RowAttribution[] {
  const out: RowAttribution[] = [];
  const sidePairs: Array<[InferredVehicle[], "ally" | "enemy"]> = [
    [sides.allies, "ally"],
    [sides.enemies, "enemy"],
  ];
  for (const [list, sideKey] of sidePairs) {
    const full = sideFullOrder(list, options);
    const sunkSet = sideKey === "ally" ? sunk.ally : sunk.enemy;
    if (options.staticLayout || sunkSet == null) {
      // Static CN layout, or no trusted set for this side (stale stream):
      // the full key order — battle-start layout.
      for (const name of full) out.push(name);
      continue;
    }
    for (const name of full) if (!sunkSet.has(name)) out.push(name);
    for (const name of full) if (sunkSet.has(name)) out.push(name);
  }
  return out;
}
