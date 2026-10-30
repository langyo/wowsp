/**
 * Lazy loaders for the game's OWN battle-HUD ship icons
 * (`/gui/battle_hud/markers/ship/icon_{variant}_{class}.png`), extracted by
 * scripts/model_convert/extract_ship_icons.py and re-encoded to WebP. Used
 * by the hologram labels
 * (BattleIcon component) and the minimap canvas (drawImage).
 *
 * The `outline` variant is a derived plate-free redraw of the white markers
 * (scripts/model_convert/derive_outline_marker_icons.py): the ship-class hint
 * cards tint it to the popup ink, and dropping the plate is what keeps the
 * glyph's interior gaps open at card size.
 */
// PublicDir art served at the root path (see utils/shipImages.ts) — URL
// constants, not imports, keep the 32 HUD icons out of Vite's module
// graph; the URLs are byte-identical to what the imports resolved to.
const allyBattleship = "/images/ships/icon_ally_battleship.webp";
const allyCruiser = "/images/ships/icon_ally_cruiser.webp";
const allyDestroyer = "/images/ships/icon_ally_destroyer.webp";
const allyAircarrier = "/images/ships/icon_ally_aircarrier.webp";
const allySubmarine = "/images/ships/icon_ally_submarine.webp";
const allyAuxiliary = "/images/ships/icon_ally_auxiliary.webp";
const enemyBattleship = "/images/ships/icon_enemy_battleship.webp";
const enemyCruiser = "/images/ships/icon_enemy_cruiser.webp";
const enemyDestroyer = "/images/ships/icon_enemy_destroyer.webp";
const enemyAircarrier = "/images/ships/icon_enemy_aircarrier.webp";
const enemySubmarine = "/images/ships/icon_enemy_submarine.webp";
const enemyAuxiliary = "/images/ships/icon_enemy_auxiliary.webp";
const sunkBattleship = "/images/ships/icon_sunk_battleship.webp";
const sunkCruiser = "/images/ships/icon_sunk_cruiser.webp";
const sunkDestroyer = "/images/ships/icon_sunk_destroyer.webp";
const sunkAircarrier = "/images/ships/icon_sunk_aircarrier.webp";
const sunkSubmarine = "/images/ships/icon_sunk_submarine.webp";
const sunkEnemyBattleship = "/images/ships/icon_sunk_enemy_battleship.webp";
const sunkEnemyCruiser = "/images/ships/icon_sunk_enemy_cruiser.webp";
const sunkEnemyDestroyer = "/images/ships/icon_sunk_enemy_destroyer.webp";
const sunkEnemyAircarrier = "/images/ships/icon_sunk_enemy_aircarrier.webp";
const sunkEnemySubmarine = "/images/ships/icon_sunk_enemy_submarine.webp";
const whiteBattleship = "/images/ships/icon_white_battleship.webp";
const whiteCruiser = "/images/ships/icon_white_cruiser.webp";
const whiteDestroyer = "/images/ships/icon_white_destroyer.webp";
const whiteAircarrier = "/images/ships/icon_white_aircarrier.webp";
const whiteSubmarine = "/images/ships/icon_white_submarine.webp";
const outlineBattleship = "/images/ships/icon_outline_battleship.webp";
const outlineCruiser = "/images/ships/icon_outline_cruiser.webp";
const outlineDestroyer = "/images/ships/icon_outline_destroyer.webp";
const outlineAircarrier = "/images/ships/icon_outline_aircarrier.webp";
const outlineSubmarine = "/images/ships/icon_outline_submarine.webp";
const plainBattleship = "/images/ships/icon_battleship.webp";
const plainCruiser = "/images/ships/icon_cruiser.webp";
const plainDestroyer = "/images/ships/icon_destroyer.webp";
const plainAircarrier = "/images/ships/icon_aircarrier.webp";
const plainSubmarine = "/images/ships/icon_submarine.webp";

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
  // Plate-free line art derived from the white markers (see the module
  // comment): ink-tinted consumers that draw the glyph small — the
  // ship-class hint cards — need the interior gaps the plate would fill.
  outline: {
    battleship: outlineBattleship,
    cruiser: outlineCruiser,
    destroyer: outlineDestroyer,
    aircarrier: outlineAircarrier,
    submarine: outlineSubmarine,
  },
  plain: {
    battleship: plainBattleship,
    cruiser: plainCruiser,
    destroyer: plainDestroyer,
    aircarrier: plainAircarrier,
    submarine: plainSubmarine,
  },
};

export type ShipIconVariant = "ally" | "enemy" | "sunk" | "sunk-enemy" | "white" | "outline" | "plain";

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
