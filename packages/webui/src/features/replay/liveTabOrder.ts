/**
 * Live-roster ordering that mirrors the in-game Tab panel.
 *
 * The game orders each team's Tab rows by ONE sort key recovered from the
 * decompiled client (see utils/shipClass's module docs): alive flag, class
 * rank, tier descending, nation rank, localized ship name, and the
 * '[TAG]nickname' display name — and re-sorts live as ships sink. The
 * order here is the same key over the roster, with the trusted sunk set
 * (sink-attrib events, utils/sunkTracker) splitting [alive] ++ [sunk]:
 * the exact layout the game shows, re-derived reactively when the WG
 * batch lands a clan tag or a sink event fires.
 *
 * CN and Lesta clients (realms 'cn' / 'ru') order rows by the localized
 * ship name (pinyin-collated) instead of the decompiled nation rank; only
 * CN never re-sorts — sunk rows dim in place. `shipNameOrder` switches the
 * row order on for both realms, `staticOrder` adds the CN-only
 * never-re-sorts behavior on top — under IT alone, the sunk set only
 * MARKS entries.
 */
import type { VehicleEntry } from "@/api";
import { gameTabRowCompare, type TabRowCompareOptions } from "@/utils/shipClass";

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
   *  and marks the sunk entries — the exact layout the game shows. */
  sunk?: Set<string> | null;
  /** CN/Lesta client row order (localized ship name, pinyin-collated —
   *  see utils/shipClass's module docs). */
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
 * @param rows that side's recognized Tab rows in on-screen order, when a
 *        trusted recognition pass exists for this battle (null otherwise).
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
