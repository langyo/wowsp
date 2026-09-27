/**
 * Live-roster ordering that mirrors the in-game Tab panel.
 *
 * The game orders each team's Tab rows by ONE sort key recovered from the
 * decompiled client (see utils/shipClass's module docs): alive flag, class
 * rank, tier descending, nation rank, localized ship name, and the
 * '[TAG]nickname' display name — and re-sorts live as ships sink. Two
 * sources build the order here:
 *
 *  - the `wowsp://tab-order` event (`TabRowPlayer[]` per side, matched by
 *    the battle's `dateTime`) — the EXACT on-screen row order plus per-row
 *    alive flags, read off the frame by the Tab watcher's recognition
 *    pass. Whenever it exists it wins;
 *  - otherwise a PREDICTED order: the same full key, everyone treated as
 *    alive (the battle-start layout — exact, modulo the clan-tag segment
 *    arriving with the WG batch, which re-sorts the moment it lands).
 *    Rows that did not match a roster name keep their slot, and roster
 *    entries no row claims are appended after the recognized ones in
 *    predicted order.
 */
import type { TabRowPlayer, VehicleEntry } from "@/api";
import { gameTabRowKey } from "@/utils/shipClass";

/** One roster entry with its display state after Tab-ordering. */
export interface TabOrderedVehicle {
  vehicle: VehicleEntry;
  /** True when the Tab recognition read this player's row as dim gray —
   *  the ship is sunk (in-game the row is grayed out the same way). */
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
  rows?: TabRowPlayer[] | null,
  options: PredictedOrderOptions = {},
): TabOrderedVehicle[] {
  const claimed = new Set<string>();
  const ordered: TabOrderedVehicle[] = [];
  if (rows && rows.length > 0) {
    const byName = new Map(list.map((v) => [v.name, v]));
    for (const row of rows) {
      const v = row.name != null ? byName.get(row.name) : undefined;
      if (!v || claimed.has(v.name)) continue;
      claimed.add(v.name);
      ordered.push({ vehicle: v, sunk: !row.alive });
    }
  }
  // Roster entries no row claimed (recognition missed them, or no
  // recognition ran at all): predicted order — the client's full Tab key
  // (alive, class, tier, nation, ship name, '[tag]name') with the arena
  // order as the final stable tie-break.
  const sunk = options.sunk ?? null;
  const rest = list
    .filter((v) => !claimed.has(v.name))
    .map((v, i) => ({
      v,
      i,
      key: gameTabRowKey(
        v,
        !(sunk?.has(v.name) ?? false),
        options.locale ?? "en-US",
        options.clanTagOf ? () => options.clanTagOf?.(v) ?? null : undefined,
      ),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i))
    .map(({ v }) => v);
  for (const v of rest) ordered.push({ vehicle: v, sunk: sunk?.has(v.name) ?? false });
  return ordered;
}
