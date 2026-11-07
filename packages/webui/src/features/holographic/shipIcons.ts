/**
 * The ship-class icon provider's data layer — ONE source of art for every
 * surface (DOM faces go through the BattleIcon component, canvas faces
 * preload the same URLs here).
 *
 * The art is the game's battle-HUD marker set
 * (`/gui/battle_hud/markers/ship/icon_{variant}_{class}.png`), authored as
 * GEOMETRY by `scripts/model_convert/ship_class_glyphs.py` (a rounded hull,
 * a bow wedge, the speed slashes) so it renders crisp at every size and DPR
 * — no bitmap tracing: the first vector pass traced the 27 px markers and
 * baked their stair-steps into the paths (2026-11-07 review).
 *
 * The `outline` variant is a plate-free redraw of the white markers
 * (traced from their line ink): the ship-class hint cards tint it to the
 * popup ink, and dropping the plate is what keeps the glyph's interior
 * gaps open at card size.
 */
// PublicDir art served at the root path (see utils/shipImages.ts) — URL
// constants, not imports, keep the 37 HUD icons out of Vite's module
// graph.
const allyBattleship = "/images/ships/icon_ally_battleship.svg";
const allyCruiser = "/images/ships/icon_ally_cruiser.svg";
const allyDestroyer = "/images/ships/icon_ally_destroyer.svg";
const allyAircarrier = "/images/ships/icon_ally_aircarrier.svg";
const allySubmarine = "/images/ships/icon_ally_submarine.svg";
const allyAuxiliary = "/images/ships/icon_ally_auxiliary.svg";
const enemyBattleship = "/images/ships/icon_enemy_battleship.svg";
const enemyCruiser = "/images/ships/icon_enemy_cruiser.svg";
const enemyDestroyer = "/images/ships/icon_enemy_destroyer.svg";
const enemyAircarrier = "/images/ships/icon_enemy_aircarrier.svg";
const enemySubmarine = "/images/ships/icon_enemy_submarine.svg";
const enemyAuxiliary = "/images/ships/icon_enemy_auxiliary.svg";
const sunkBattleship = "/images/ships/icon_sunk_battleship.svg";
const sunkCruiser = "/images/ships/icon_sunk_cruiser.svg";
const sunkDestroyer = "/images/ships/icon_sunk_destroyer.svg";
const sunkAircarrier = "/images/ships/icon_sunk_aircarrier.svg";
const sunkSubmarine = "/images/ships/icon_sunk_submarine.svg";
const sunkEnemyBattleship = "/images/ships/icon_sunk_enemy_battleship.svg";
const sunkEnemyCruiser = "/images/ships/icon_sunk_enemy_cruiser.svg";
const sunkEnemyDestroyer = "/images/ships/icon_sunk_enemy_destroyer.svg";
const sunkEnemyAircarrier = "/images/ships/icon_sunk_enemy_aircarrier.svg";
const sunkEnemySubmarine = "/images/ships/icon_sunk_enemy_submarine.svg";
const whiteBattleship = "/images/ships/icon_white_battleship.svg";
const whiteCruiser = "/images/ships/icon_white_cruiser.svg";
const whiteDestroyer = "/images/ships/icon_white_destroyer.svg";
const whiteAircarrier = "/images/ships/icon_white_aircarrier.svg";
const whiteSubmarine = "/images/ships/icon_white_submarine.svg";
const outlineBattleship = "/images/ships/icon_outline_battleship.svg";
const outlineCruiser = "/images/ships/icon_outline_cruiser.svg";
const outlineDestroyer = "/images/ships/icon_outline_destroyer.svg";
const outlineAircarrier = "/images/ships/icon_outline_aircarrier.svg";
const outlineSubmarine = "/images/ships/icon_outline_submarine.svg";
const plainBattleship = "/images/ships/icon_battleship.svg";
const plainCruiser = "/images/ships/icon_cruiser.svg";
const plainDestroyer = "/images/ships/icon_destroyer.svg";
const plainAircarrier = "/images/ships/icon_aircarrier.svg";
const plainSubmarine = "/images/ships/icon_submarine.svg";

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
  // art (the mirrored copy the historical flip script derived; the
  // current traced SVG set comes from the same mirrored source art), so
  // the enemy variant keeps the enemy row's rightward direction.
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

/** Resolve the traced SVG URL for a ship class, or null when unknown. */
export function shipIconUrl(
  type: string | null | undefined,
  variant: ShipIconVariant = "plain",
): string | null {
  const cls = shipTypeClass(type);
  return SHIP_ICONS[variant]?.[cls] ?? null;
}

/**
 * Intrinsic raster size canvas faces load the traced class-glyph SVGs at
 * (shotKit's `loadImage(url, raster)`). The art's viewBox is 27 px; drawn
 * at 18–20 px logical slots on the 2x shot canvases, loading at 96 px keeps
 * every draw a smooth downsample instead of a bitmap upscale.
 */
export const SHIP_GLYPH_RASTER = 96;

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

