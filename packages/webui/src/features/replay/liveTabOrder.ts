/**
 * Live-roster ordering that mirrors the in-game Tab panel.
 *
 * The game orders each team's Tab rows by ONE sort key recovered from the
 * decompiled client (see utils/shipClass's module docs): alive flag, class
 * rank, tier descending, nation rank, localized ship name, and the
 * '[TAG]nickname' display name — and re-sorts live as ships sink. The
 * order here is the same key over the roster, with the trusted sunk set
 * (sink-attrib events, utils/sunkTracker) splitting [alive] ++ [sunk]:
 * the exact layout the verified WG-family clients show, re-derived
 * reactively when the WG batch lands a clan tag or a sink event fires.
 *
 * The CN client (realm 'cn') orders rows by the localized ship name
 * (pinyin-collated) instead of the decompiled nation rank, and never
 * re-sorts — sunk rows dim in place. `shipNameOrder` switches that row
 * order on, `staticOrder` adds the CN-only never-re-sorts behavior on
 * top — under IT alone, the sunk set only MARKS entries. (The Lesta
 * client used to be grouped here; the 2026-10-10 live capture showed it
 * renders its own sort-key order instead.)
 *
 * `sortKeyOf` supersedes the offline permutations per battle: the plugin
 * telemetry can carry the game's OWN per-player sort keys (read off the
 * avatars' ship components), and when the map covers the whole list the
 * sort switches to the client's exact comparison — key + '[TAG]nickname'
 * ascending, the concatenation __sortKeyAlive compares — EXCEPT on a
 * ship-name-order client (CN: the override stands down, its HUD renders
 * an order the keys cannot express), and with Lesta's equal keys keeping
 * the roster order (`tieByRosterOrder`).
 */
import type { VehicleEntry } from "@/api";
import { gameTabRowCompare, tabDisplayName, type TabRowCompareOptions } from "@/utils/shipClass";

/** One roster entry with its display state after Tab-ordering. */
export interface TabOrderedVehicle {
  vehicle: VehicleEntry;
  /** True when the trusted sunk set names this player — the ship is sunk
   *  (in-game the row is grayed out the same way). */
  sunk: boolean;
}

/** Extra inputs for the predicted order's full sort key. */
export interface PredictedOrderOptions {
  /** Locale for the key's ship-name segment (zh-CN fallback inside the
   *  key builder). */
  locale?: string;
  /** Clan tag per vehicle — from the panel's stats map; the predicted
   *  order re-derives reactively when the WG batch lands tags. */
  clanTagOf?: (v: VehicleEntry) => string | null | undefined;
  /** Trusted sunk names (utils/sunkTracker, fed by the sink-attrib
   *  events): the predicted order splits [alive by key] ++ [sunk by key]
   *  and marks the sunk entries — the exact layout those clients show. */
  sunk?: Set<string> | null;
  /** Game-true TAB sort keys per vehicle (telemetry `sortKeys`, read off
   *  the avatars' ship components — ShipSystem's own class+tier+nation+
   *  shortName string). When EVERY entry of the list yields a non-empty
   *  key, the sort switches to the CLIENT's own comparison and the
   *  offline per-realm inference is not consulted at all — EXCEPT under
   *  `shipNameOrder`, where the client's HUD re-sorts rows by the
   *  localized ship name and the keys cannot express the rendered order
   *  (the 2026-10-10 Lesta lesson, applied to the one realm that still
   *  re-sorts). Any entry missing a key disables the override wholesale
   *  (game-true and inferred rows must never interleave; the caller
   *  grades coverage separately for the pill). */
  sortKeyOf?: (v: VehicleEntry) => string | undefined;
  /** Lesta clients break EQUAL keys by the roster's own order, not the
   *  '[TAG]nickname' concatenation the WG decompile appends (live
   *  2026-10-10, realm ru: two same-key Turenne rows — a human and a
   *  ':bot:' — rendered in roster-record order; the plain compare puts
   *  the colon first and swaps them). `true` compares the keys alone and
   *  lets equal keys keep the incoming list order (a stable key sort,
   *  the arena order as the tie-break). */
  tieByRosterOrder?: boolean;
  /** CN client row order (localized ship name, pinyin-collated — see
   *  utils/shipClass's module docs). */
  shipNameOrder?: boolean;
  /** CN clients never re-sort the table mid-battle — sunk rows dim in
   *  place at their battle-start positions. `true` keeps every entry at
   *  its full-key-order position and only MARKS the sunk ones (the WG
   *  [alive] ++ [sunk] split would place rows where the CN table never
   *  moves them). */
  staticOrder?: boolean;
}

/**
 * Order one side's roster for display.
 *
 * @param list the side's roster entries (allies: relation ≤ 1 / enemies:
 *        relation > 1), in arena-file order.
 * @param options the predicted order's key inputs (locale, clan tags).
 */
export function orderForTab(
  list: VehicleEntry[],
  options: PredictedOrderOptions = {},
): TabOrderedVehicle[] {
  const ordered: TabOrderedVehicle[] = [];
  // Predicted order — the client's full Tab key (alive, class, tier,
  // nation, ship name, '[tag]name') with the arena order as the final
  // stable tie-break; the trusted sunk set splits [alive] ++ [sunk].
  const sunk = options.sunk ?? null;
  // Game-true sort keys: only a FULLY covered list switches the sort to
  // the client's own comparison — key + '[tag]name' ascending (the exact
  // string __sortKeyAlive builds; plain code-unit compare matches the
  // client's Python str ordering), or the keys alone when the realm
  // breaks equal keys by the roster order (Lesta; see tieByRosterOrder).
  // A ship-name-order client (CN) never renders the key order at all —
  // its HUD re-sorts by the localized name — so there the override
  // stands down entirely and the calibrated name-order inference keeps
  // the rows. Anything less than full coverage keeps the offline
  // inference for the WHOLE list — no interleaving.
  const keyOf = options.sortKeyOf;
  const clientKeys =
    keyOf && list.length > 0
      ? list.map((v) => keyOf(v))
      : null;
  const useClientKeys =
    clientKeys != null &&
    !options.shipNameOrder &&
    clientKeys.every((k) => typeof k === "string" && k.length > 0);
  const clientKeyOf = useClientKeys
    ? (v: VehicleEntry) => {
        // useClientKeys verified every key is a non-empty string.
        const key = keyOf!(v) as string;
        return options.tieByRosterOrder
          ? key
          : key + tabDisplayName(v.name, options.clanTagOf?.(v) ?? null);
      }
    : null;
  const compareOptions: TabRowCompareOptions = {
    locale: options.locale ?? "en-US",
    // The comparator only ever calls this with the list's own entries, so
    // the wider TabSortVehicle parameter is always the VehicleEntry the
    // caller's closure expects.
    clanTagOf: options.clanTagOf
      ? (v) => options.clanTagOf?.(v as VehicleEntry) ?? null
      : undefined,
    shipNameOrder: options.shipNameOrder,
  };
  const rest = list
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      if (clientKeyOf) {
        const ka = clientKeyOf(a.v);
        const kb = clientKeyOf(b.v);
        return ka < kb ? -1 : ka > kb ? 1 : a.i - b.i;
      }
      // The comparator sorts one layout at a time (the alive prefix never
      // decides within it), so the per-vehicle sunk state rides AFTER the
      // sort: entries keep their key-order position and the sunk split —
      // where the client re-sorts (WG) — is applied by the [alive] ++
      // [sunk] partition below; under staticOrder the partition is skipped
      // and the sunk state only marks the row.
      const c = gameTabRowCompare(a.v, b.v, compareOptions);
      return c !== 0 ? c : a.i - b.i;
    })
    .map(({ v }) => v);
  if (options.staticOrder) {
    for (const v of rest) ordered.push({ vehicle: v, sunk: sunk?.has(v.name) ?? false });
    return ordered;
  }
  const alive = rest.filter((v) => !(sunk?.has(v.name) ?? false));
  const dead = rest.filter((v) => sunk?.has(v.name) ?? false);
  for (const v of [...alive, ...dead]) {
    ordered.push({ vehicle: v, sunk: sunk?.has(v.name) ?? false });
  }
  return ordered;
}
