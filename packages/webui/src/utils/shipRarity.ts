/**
 * Ship rarity classification — matches the in-game card rarity tiers.
 *
 * The authoritative source is GameParams' `RarityCategory.name` field, mined
 * by `build_rarity_map.py` and bundled at `data/ship_rarity.json`. The
 * game uses five bands, each with its own card-frame colour:
 *
 *   普通      Common    — white
 *   罕见      Uncommon  — green
 *   稀有      Rare      — blue
 *   史诗      Epic      — red
 *   传奇      Legendary — orange
 *
 * On top of the bands sits the EVENT tier (活动): collaboration/battle-mode
 * hulls (Halloween fleets, Azur Lane, Star Trek, …) attributed by
 * GameParams' `peculiarity` system through `data/ship_events.json` (see
 * utils/shipEvents.ts). It is NOT a rarity level — it outranks the bands
 * because the tag position shows the event's official name
 * ("活动·万圣节 2020") instead of a band label.
 *
 * When a shipId isn't in the bundled map (brand-new ship, or the user's
 * region differs), we fall back to a tier+flags derivation that approximates
 * the official bands from the only two signals WG's encyclopedia exposes.
 */
import { authoritativeRarity } from "./shipRarityData";
import { authoritativeEvent } from "./shipEventData";

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary" | "event";

/** All rarity tiers in display order (low → high; event appended). */
export const RARITY_ORDER: Rarity[] = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
  "event",
];

export interface RaritySignals {
  shipId?: number;
  isPremium: boolean;
  isSpecial: boolean;
  tier: number;
}

/** Resolve a ship's rarity. Event attribution wins; else the authoritative
 *  GameParams band; else derive. */
export function shipRarity(s: RaritySignals): Rarity {
  if (authoritativeEvent(s.shipId)) return "event";
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

/** STag variant to use for each rarity tier (frame colour proxy). The
 *  event tier rides `default` + a custom violet class (hikari has no purple
 *  variant and every shipped one is taken by a band). */
export const RARITY_VARIANT: Record<
  Rarity,
  "default" | "success" | "info" | "danger" | "warning"
> = {
  common: "default", // white
  uncommon: "success", // green
  rare: "info", // blue
  epic: "danger", // red
  legendary: "warning", // orange
  event: "default", // violet via the --event CSS modifier
};

/** CSS modifier class for a ship card border, derived from rarity. */
export const RARITY_CARD_MOD: Record<Rarity, Rarity> = {
  common: "common",
  uncommon: "uncommon",
  rare: "rare",
  epic: "epic",
  legendary: "legendary",
  event: "event",
};

/** In-game frame accent colour (RGB) per rarity tier. */
export const RARITY_COLOR: Record<Rarity, string> = {
  common: "200 200 205", // white-ish
  uncommon: "90 200 110", // green
  rare: "90 160 255", // blue
  epic: "230 90 80", // red
  legendary: "255 140 40", // orange
  event: "190 120 255", // violet
};
