/**
 * Lazy loaders for the game's OWN battle-HUD ship icons
 * (`/gui/battle_hud/markers/ship/icon_{variant}_{class}.png`), extracted by
 * scripts/model_convert/extract_ship_icons.py and re-encoded to WebP. Used
 * by the hologram labels
 * (BattleIcon component) and the minimap canvas (drawImage).
 */
import allyBattleship from "../../res/images/ships/icon_ally_battleship.webp";
import allyCruiser from "../../res/images/ships/icon_ally_cruiser.webp";
import allyDestroyer from "../../res/images/ships/icon_ally_destroyer.webp";
import allyAircarrier from "../../res/images/ships/icon_ally_aircarrier.webp";
import allySubmarine from "../../res/images/ships/icon_ally_submarine.webp";
import allyAuxiliary from "../../res/images/ships/icon_ally_auxiliary.webp";
import enemyBattleship from "../../res/images/ships/icon_enemy_battleship.webp";
import enemyCruiser from "../../res/images/ships/icon_enemy_cruiser.webp";
import enemyDestroyer from "../../res/images/ships/icon_enemy_destroyer.webp";
import enemyAircarrier from "../../res/images/ships/icon_enemy_aircarrier.webp";
import enemySubmarine from "../../res/images/ships/icon_enemy_submarine.webp";
import enemyAuxiliary from "../../res/images/ships/icon_enemy_auxiliary.webp";
import sunkBattleship from "../../res/images/ships/icon_sunk_battleship.webp";
import sunkCruiser from "../../res/images/ships/icon_sunk_cruiser.webp";
import sunkDestroyer from "../../res/images/ships/icon_sunk_destroyer.webp";
import sunkAircarrier from "../../res/images/ships/icon_sunk_aircarrier.webp";
import sunkSubmarine from "../../res/images/ships/icon_sunk_submarine.webp";
import sunkEnemyBattleship from "../../res/images/ships/icon_sunk_enemy_battleship.webp";
import sunkEnemyCruiser from "../../res/images/ships/icon_sunk_enemy_cruiser.webp";
import sunkEnemyDestroyer from "../../res/images/ships/icon_sunk_enemy_destroyer.webp";
import sunkEnemyAircarrier from "../../res/images/ships/icon_sunk_enemy_aircarrier.webp";
import sunkEnemySubmarine from "../../res/images/ships/icon_sunk_enemy_submarine.webp";
import whiteBattleship from "../../res/images/ships/icon_white_battleship.webp";
import whiteCruiser from "../../res/images/ships/icon_white_cruiser.webp";
import whiteDestroyer from "../../res/images/ships/icon_white_destroyer.webp";
import whiteAircarrier from "../../res/images/ships/icon_white_aircarrier.webp";
import whiteSubmarine from "../../res/images/ships/icon_white_submarine.webp";
import plainBattleship from "../../res/images/ships/icon_battleship.webp";
import plainCruiser from "../../res/images/ships/icon_cruiser.webp";
import plainDestroyer from "../../res/images/ships/icon_destroyer.webp";
import plainAircarrier from "../../res/images/ships/icon_aircarrier.webp";
import plainSubmarine from "../../res/images/ships/icon_submarine.webp";

const SHIP_ICONS: Record<string, Record<string, string>> = {
  ally: {
    battleship: allyBattleship,
    cruiser: allyCruiser,
    destroyer: allyDestroyer,
    aircarrier: allyAircarrier,
    submarine: allySubmarine,
    auxiliary: allyAuxiliary,
  },
  enemy: {
    battleship: enemyBattleship,
    cruiser: enemyCruiser,
    destroyer: enemyDestroyer,
    aircarrier: enemyAircarrier,
    submarine: enemySubmarine,
    auxiliary: enemyAuxiliary,
  },
  sunk: {
    battleship: sunkBattleship,
    cruiser: sunkCruiser,
    destroyer: sunkDestroyer,
    aircarrier: sunkAircarrier,
    submarine: sunkSubmarine,
  },
  // Sunk art for the ENEMY row: the sunk bitmap faces left like the ally
  // art (see flip_sunk_icons.py), so the enemy variant is the mirrored copy
  // keeping the enemy row's rightward direction.
  "sunk-enemy": {
    battleship: sunkEnemyBattleship,
    cruiser: sunkEnemyCruiser,
    destroyer: sunkEnemyDestroyer,
    aircarrier: sunkEnemyAircarrier,
    submarine: sunkEnemySubmarine,
  },
  white: {
    battleship: whiteBattleship,
    cruiser: whiteCruiser,
    destroyer: whiteDestroyer,
    aircarrier: whiteAircarrier,
    submarine: whiteSubmarine,
  },
  plain: {
    battleship: plainBattleship,
    cruiser: plainCruiser,
    destroyer: plainDestroyer,
    aircarrier: plainAircarrier,
    submarine: plainSubmarine,
  },
};

export type ShipIconVariant = "ally" | "enemy" | "sunk" | "sunk-enemy" | "white" | "plain";

/** Map a WG ShipInfo.type string to the icon-atlas class key. Unknown types
 *  map to "" — they must NOT impersonate battleships (the old fallback drew
 *  a BB icon for ships no database could classify); "" misses every atlas
 *  row, so `shipIconUrl` answers null and the icon slots render their
 *  empty placeholder instead (BattleIcon's bare span, the shots' skipped
 *  image). Every caller already tolerates a null URL: the sunk/white
 *  variants never had an auxiliary row, so null was always a possible
 *  answer here. */
export function shipTypeClass(type: string | null | undefined): string {
  const t = (type ?? "").toLowerCase();
  if (t.includes("battleship")) return "battleship";
  if (t.includes("cruiser")) return "cruiser";
  if (t.includes("destroyer")) return "destroyer";
  if (t.includes("aircarrier") || t.includes("aircar")) return "aircarrier";
  if (t.includes("submarine")) return "submarine";
  if (t.includes("auxiliary")) return "auxiliary";
  return "";
}

/** Resolve the original game PNG URL for a ship, or null when unknown. */
export function shipIconUrl(
  type: string | null | undefined,
  variant: ShipIconVariant = "plain",
): string | null {
  const cls = shipTypeClass(type);
  return SHIP_ICONS[variant]?.[cls] ?? null;
}

const cache: Record<string, HTMLImageElement | null> = {};
/** Lazy-loaded HTMLImageElement for a ship icon (null until decoded). */
export function shipIcon(
  type: string | null | undefined,
  variant: ShipIconVariant = "plain",
): HTMLImageElement | null {
  const key = `${variant}:${shipTypeClass(type)}`;
  if (key in cache) return cache[key];
  const url = shipIconUrl(type, variant);
  if (!url) {
    cache[key] = null;
    return null;
  }
  const img = new Image();
  img.src = url;
  cache[key] = img;
  return img;
}
