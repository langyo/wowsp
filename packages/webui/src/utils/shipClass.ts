/**
 * Ship-class ordering shared by the replay roster view and the live-battle
 * panel.
 *
 * The in-game Tab panel orders each team's rows by ship class (verified
 * against ground-truth Tab dumps: battleship < cruiser < destroyer, with
 * carriers first and submarines last following the same convention the
 * replay roster already uses). The live panel's PREDICTED order — used
 * before any Tab recognition has landed and without alive-state knowledge —
 * mirrors that grouping so the software's list starts out matching the game
 * instead of tempArenaInfo.json's join order.
 */
import { shipOfflineEntry } from "@/features/holographic/modelLoader";

/** Best-effort ship class string for a ship id (offline DB only). */
export function shipTypeOf(shipId: number): string {
  return shipOfflineEntry(shipId)?.type ?? "";
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
