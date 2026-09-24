/**
 * Ship ordering shared by the replay roster view, the live-battle panel and
 * the in-game overlay's inferred mode.
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
 * T5/T5 cruisers, ...). The live panel's PREDICTED order and the overlay's
 * inferred row→name mapping both mirror that rule so their lists start out
 * matching the game instead of tempArenaInfo.json's join order.
 *
 * What is NOT derivable from the roster is the order WITHIN a
 * (class, tier) group — two T8 battleships can appear either way round, and
 * neither ship id nor nation explains the game's pick (checked against the
 * captured frames). That residue is what the Tab watcher's row recognition
 * (OCR mode) resolves; the inferred mode leaves it to the ship-id
 * tiebreak below, which keeps same-ship players (the classic division)
 * adjacent.
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
  const tier = entryOf(shipId)?.tier;
  return typeof tier === "number" ? tier : -1;
}

/** Minimal shape the Tab-order comparator needs. */
export interface ShipOrderKey {
  shipId: number;
}

/** The game's within-block order for two roster entries (verified rule,
 *  minus the unknowable (class, tier) tiebreak): class rank, then tier
 *  descending, then ship id so same-ship players stay adjacent. Both the
 *  live panel's predicted order and the overlay's inferred mapping sort
 *  with this, with their own stable index as the final tie-break. */
export function tabOrderCompare(
  rankOf: (shipId: number) => number,
  tierWeightOf: (shipId: number) => number,
): (a: ShipOrderKey, b: ShipOrderKey) => number {
  return (a, b) =>
    rankOf(a.shipId) - rankOf(b.shipId) ||
    tierWeightOf(b.shipId) - tierWeightOf(a.shipId) ||
    a.shipId - b.shipId;
}
