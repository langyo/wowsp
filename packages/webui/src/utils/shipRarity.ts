/**
 * Ship rarity classification — matches the in-game card rarity tiers.
 *
 * The authoritative source is GameParams' `RarityCategory.name` field, mined
 * by `build_rarity_map.py` and bundled at `res/data/ship_rarity.json`. The
 * game uses five bands, each with its own card-frame colour:
 *
 *   普通      Common    — white
 *   罕见      Uncommon  — green
 *   稀有      Rare      — blue
 *   史诗      Epic      — red
 *   传奇      Legendary — orange
 *
 * When a shipId isn't in the bundled map (brand-new ship, or the user's
 * region differs), we fall back to a tier+flags derivation that approximates
 * the official bands from the only two signals WG's encyclopedia exposes.
 */
import { authoritativeRarity } from "./shipRarityData";

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

/** All rarity tiers in display order (low → high). */
export const RARITY_ORDER: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"];

export interface RaritySignals {
  shipId?: number;
  isPremium: boolean;
  isSpecial: boolean;
  tier: number;
}

/** Resolve a ship's rarity. Authoritative GameParams value wins; else derive. */
export function shipRarity(s: RaritySignals): Rarity {
  const auth = authoritativeRarity(s.shipId);
  if (auth) return normalizeAuthRarity(auth);
  return deriveRarity(s);
}

/** Map a GameParams RarityCategory.name onto our display tiers. */
function normalizeAuthRarity(name: string): Rarity {
  switch (name.toLowerCase()) {
    case "common":
      return "common";
    case "uncommon":
      return "uncommon";
    case "rare":
      return "rare";
    case "epic":
      return "epic";
    case "legendary":
      return "legendary";
    default:
      return "common";
  }
}

/** Tier+flags fallback when no GameParams rarity is bundled for the ship. */
function deriveRarity(s: RaritySignals): Rarity {
  if (!s.isPremium && !s.isSpecial) return "common";
  if (s.tier >= 9) return "epic";
  if (s.tier >= 7) return "rare";
  return "uncommon";
}

/** STag variant to use for each rarity tier (frame colour proxy). */
export const RARITY_VARIANT: Record<
  Rarity,
  "neutral" | "success" | "info" | "danger" | "legendary"
> = {
  common: "neutral", // white
  uncommon: "success", // green
  rare: "info", // blue
  epic: "danger", // red
  legendary: "legendary", // orange
};

/** CSS modifier class for a ship card border, derived from rarity. */
export const RARITY_CARD_MOD: Record<Rarity, Rarity> = {
  common: "common",
  uncommon: "uncommon",
  rare: "rare",
  epic: "epic",
  legendary: "legendary",
};

/** In-game frame accent colour (RGB) per rarity tier. */
export const RARITY_COLOR: Record<Rarity, string> = {
  common: "200 200 205", // white-ish
  uncommon: "90 200 110", // green
  rare: "90 160 255", // blue
  epic: "230 90 80", // red
  legendary: "255 140 40", // orange
};
