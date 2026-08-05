/**
 * Lazy loaders for the game's OWN battle-HUD ship icons
 * (`/gui/battle_hud/markers/ship/icon_{variant}_{class}.png`), extracted by
 * scripts/model_convert/extract_ship_icons.py. Used by the hologram labels
 * (BattleIcon component) and the minimap canvas (drawImage).
 */
import allyBattleship from "../../res/images/ships/icon_ally_battleship.png";
import allyCruiser from "../../res/images/ships/icon_ally_cruiser.png";
import allyDestroyer from "../../res/images/ships/icon_ally_destroyer.png";
import allyAircarrier from "../../res/images/ships/icon_ally_aircarrier.png";
import allySubmarine from "../../res/images/ships/icon_ally_submarine.png";
import allyAuxiliary from "../../res/images/ships/icon_ally_auxiliary.png";
import enemyBattleship from "../../res/images/ships/icon_enemy_battleship.png";
import enemyCruiser from "../../res/images/ships/icon_enemy_cruiser.png";
import enemyDestroyer from "../../res/images/ships/icon_enemy_destroyer.png";
import enemyAircarrier from "../../res/images/ships/icon_enemy_aircarrier.png";
import enemySubmarine from "../../res/images/ships/icon_enemy_submarine.png";
import enemyAuxiliary from "../../res/images/ships/icon_enemy_auxiliary.png";
import sunkBattleship from "../../res/images/ships/icon_sunk_battleship.png";
import sunkCruiser from "../../res/images/ships/icon_sunk_cruiser.png";
import sunkDestroyer from "../../res/images/ships/icon_sunk_destroyer.png";
import sunkAircarrier from "../../res/images/ships/icon_sunk_aircarrier.png";
import sunkSubmarine from "../../res/images/ships/icon_sunk_submarine.png";
import whiteBattleship from "../../res/images/ships/icon_white_battleship.png";
import whiteCruiser from "../../res/images/ships/icon_white_cruiser.png";
import whiteDestroyer from "../../res/images/ships/icon_white_destroyer.png";
import whiteAircarrier from "../../res/images/ships/icon_white_aircarrier.png";
import whiteSubmarine from "../../res/images/ships/icon_white_submarine.png";
import plainBattleship from "../../res/images/ships/icon_battleship.png";
import plainCruiser from "../../res/images/ships/icon_cruiser.png";
import plainDestroyer from "../../res/images/ships/icon_destroyer.png";
import plainAircarrier from "../../res/images/ships/icon_aircarrier.png";
import plainSubmarine from "../../res/images/ships/icon_submarine.png";

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

export type ShipIconVariant = "ally" | "enemy" | "sunk" | "white" | "plain";

/** Map a WG ShipInfo.type string to the icon-atlas class key. */
export function shipTypeClass(type: string | null | undefined): string {
  const t = (type ?? "").toLowerCase();
  if (t.includes("battleship")) return "battleship";
  if (t.includes("cruiser")) return "cruiser";
  if (t.includes("destroyer")) return "destroyer";
  if (t.includes("aircarrier") || t.includes("aircar")) return "aircarrier";
  if (t.includes("submarine")) return "submarine";
  if (t.includes("auxiliary")) return "auxiliary";
  return "battleship";
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
