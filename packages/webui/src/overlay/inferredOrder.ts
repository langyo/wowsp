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
 * — compared ascending. At battle start that is the table's EXACT order:
 * every row maps to one player (the former "tie group" residue is decided
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
 * scenario units (`IDS_*` nicknames — tutorial / escort-op fleets) render
 * under LOCALIZED names in-game (e.g. `IDS_AL_01` → zh `：舍尔：`), so their
 * key order may differ from the client's; their chips all read "bot"
 * (utils/aiNames), leaving at most a human's chip one row off among them
 * in those battles.
 */
import { gameTabRowKey } from "@/utils/shipClass";

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
  /** TRUSTED sunk sets per side (utils/sunkTracker): when a side's set is
   *  present AND matches the alive vector's sunk count, that side renders
   *  the EXACT layout — [alive by key] ++ [sunk by key], every row named —
   *  instead of candidate ranges. null/absent sides keep the ranges. */
  sunk?: { ally?: Set<string> | null; enemy?: Set<string> | null } | null;
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
 * {@link RowAttribution}. The relation side split holds in operations
 * (行动) too: their rosters carry real enemy semantics (allied escort
 * waves ≤ 1, enemy warships > 1 — verified against operation captures).
 */
export function inferredRowMapping(
  vehicles: InferredVehicle[],
  alive: boolean[] | null,
  options: InferredOrderOptions = {},
): RowAttribution[] {
  const locale = options.locale ?? "en-US";
  const out: RowAttribution[] = [];
  let offset = 0;
  const sides: Array<[InferredVehicle[], "ally" | "enemy"]> = [
    [vehicles.filter((v) => v.relation <= 1), "ally"],
    [vehicles.filter((v) => v.relation > 1), "enemy"],
  ];
  for (const [list, sideKey] of sides) {
    const full = list
      .map((v, i) => ({
        v,
        i,
        key: gameTabRowKey(v, true, locale, options.clanTagOf),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i))
      .map(({ v }) => v.name);
    const n = full.length;
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
 * Same block structure as {@link inferredRowMapping}: allies first, enemies
 * after (the relation split, operations included).
 */
export function pluginRowMapping(
  vehicles: InferredVehicle[],
  sunk: { ally?: Set<string> | null; enemy?: Set<string> | null },
  options: InferredOrderOptions = {},
): RowAttribution[] {
  const locale = options.locale ?? "en-US";
  const out: RowAttribution[] = [];
  const sides: Array<[InferredVehicle[], "ally" | "enemy"]> = [
    [vehicles.filter((v) => v.relation <= 1), "ally"],
    [vehicles.filter((v) => v.relation > 1), "enemy"],
  ];
  for (const [list, sideKey] of sides) {
    const full = list
      .map((v) => ({
        v,
        key: gameTabRowKey(v, true, locale, options.clanTagOf),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ v }) => v.name);
    const sunkSet = sideKey === "ally" ? sunk.ally : sunk.enemy;
    if (sunkSet == null) {
      // No trusted set for this side (stale stream): the full key order —
      // battle-start layout, nobody sunk yet.
      for (const name of full) out.push(name);
      continue;
    }
    for (const name of full) if (!sunkSet.has(name)) out.push(name);
    for (const name of full) if (sunkSet.has(name)) out.push(name);
  }
  return out;
}
