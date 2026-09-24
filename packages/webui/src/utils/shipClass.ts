/**
 * Ship ordering shared by the replay roster view and the live-battle panel.
 *
 * The in-game Tab panel orders each team's rows by
 *
 *     class rank (carrier < battleship < cruiser < destroyer < submarine),
 *     then TIER DESCENDING inside each class
 *
 * — verified against ground-truth Tab frames: battleship < cruiser <
 * destroyer, with carriers first and submarines last following the same
 * convention the replay roster already uses, and every class block of every
 * captured frame listed its higher tiers first (T8/T8/T7 battleships,
 * T5/T5 cruisers, ...). The live panel's PREDICTED order — used before any
 * Tab recognition has landed — mirrors that rule so the software's list
 * starts out matching the game instead of tempArenaInfo.json's join order.
 *
 * What is NOT derivable from the roster is the order WITHIN a
 * (class, tier) group — two T8 battleships can appear either way round, and
 * neither ship id nor nation explains the game's pick (checked against the
 * captured frames). That residue is what the Tab watcher's row recognition
 * resolves.
 */
import { shipOfflineEntry } from "@/features/holographic/modelLoader";

/** Best-effort ship class string for a ship id (offline DB only). */
export function shipTypeOf(shipId: number): string {
  return shipOfflineEntry(shipId)?.type ?? "";
}

/** Ship tier from the offline DB (null when the ship is unknown there). */
export function shipTierOf(shipId: number): number | null {
  return shipOfflineEntry(shipId)?.tier ?? null;
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
 *  HIGHER tiers first (see the module docs), and a ship the offline DB does
 *  not know sorts after every known tier. */
export function shipTierWeight(shipId: number): number {
  const tier = shipOfflineEntry(shipId)?.tier;
  return typeof tier === "number" ? tier : -1;
}
