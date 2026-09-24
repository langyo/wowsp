/**
 * Live-roster ordering that mirrors the in-game Tab panel.
 *
 * The game orders each team's Tab rows as
 *
 *     [alive ships] ++ [sunk ships], each block by
 *     class rank (carrier < battleship < cruiser < destroyer < submarine),
 *     then TIER DESCENDING inside the class
 *
 * and re-sorts live as ships sink — the block structure is verified against
 * ground-truth Tab dumps (a sunk ship drops below every alive ship even when
 * it shares its ship type with them, and stays with its group's class order
 * inside the sunk block), and the tier-descending key is verified against
 * captured frames of real battles (every class block of every captured frame
 * listed its higher tiers first). tempArenaInfo.json is written once at
 * battle start and never reflects any of that, so two sources build the
 * order here:
 *
 *  - the `wowsp://tab-order` event (`TabRowPlayer[]` per side, matched by
 *    the battle's `dateTime`) — the EXACT on-screen row order plus per-row
 *    alive flags, read off the frame by the Tab watcher's recognition
 *    pass. Whenever it exists it wins;
 *  - otherwise a PREDICTED order: stable sort by class rank, then tier
 *    descending, then ship id so same-ship players (the classic division)
 *    stay adjacent, everyone treated as alive. This matches the game's
 *    initial layout for every battle whose Tab table nobody has held yet,
 *    and stays a sane approximation afterwards.
 *
 * The within-(class, tier) tiebreak of the game's own sort is not derivable
 * from the arena file (checked against the captured frames: neither ship id
 * nor nation explains it); only the recognized row order is exact there —
 * rows that did not match a roster name keep their slot, and roster entries
 * no row claims are appended after the recognized ones in predicted order.
 */
import type { TabRowPlayer, VehicleEntry } from "@/api";
import { shipClassRank, shipTierWeight, tabOrderCompare } from "@/utils/shipClass";

/** One roster entry with its display state after Tab-ordering. */
export interface TabOrderedVehicle {
  vehicle: VehicleEntry;
  /** True when the Tab recognition read this player's row as dim gray —
   *  the ship is sunk (in-game the row is grayed out the same way). */
  sunk: boolean;
}

/**
 * Order one side's roster for display.
 *
 * @param list the side's roster entries (allies: relation ≤ 1 / enemies:
 *        relation > 1), in arena-file order.
 * @param rows that side's recognized Tab rows in on-screen order, when a
 *        trusted recognition pass exists for this battle (null otherwise).
 * @param rankOf ship-class rank injector (tests); defaults to the offline
 *        ship DB's class ranking.
 * @param tierWeightOf ship-tier weight injector (tests); defaults to the
 *        offline ship DB's tier weighting (higher tiers sort first).
 */
export function orderForTab(
  list: VehicleEntry[],
  rows?: TabRowPlayer[] | null,
  rankOf: (shipId: number) => number = shipClassRank,
  tierWeightOf: (shipId: number) => number = shipTierWeight,
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
  // recognition ran at all): predicted order — the verified game rule
  // (class rank, tier descending, ship id) with the arena order as the
  // final stable tie-break.
  const rest = list
    .filter((v) => !claimed.has(v.name))
    .map((v, i) => ({ v, i }))
    .sort(
      (a, b) =>
        tabOrderCompare(rankOf, tierWeightOf)(a.v, b.v) || a.i - b.i,
    )
    .map(({ v }) => v);
  for (const v of rest) ordered.push({ vehicle: v, sunk: false });
  return ordered;
}
