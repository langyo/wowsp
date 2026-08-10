/**
 * Real ship catalogue for the site's lookup page — generated from the game's
 * own data (packages/webui/src/data/ship_names.json, 15.6). 1168 ships with
 * tier/type/nation/hp and names in all eight site languages.
 *
 * Regenerate with the one-liner in the repo history (node, from
 * ship_names.json) when the game data updates.
 */
import shipsData from "./ships.json";

export type ShipType =
  | "Battleship"
  | "Cruiser"
  | "Destroyer"
  | "AirCarrier"
  | "Submarine"
  | "Auxiliary";

export interface ShipEntry {
  id: string;
  tier: number;
  type: ShipType;
  nation: string;
  hp: number | null;
  n: {
    en: string;
    zhs: string;
    zht: string;
    ja: string;
    ko: string;
    ru: string;
    fr: string;
    es: string;
  };
}

export const ships: ShipEntry[] = shipsData as ShipEntry[];

/** Resolve the display name for the site's locale code. */
export function shipName(s: ShipEntry, locale: string): string {
  switch (locale) {
    case "zh-Hans": return s.n.zhs;
    case "zh-Hant": return s.n.zht;
    case "ja": return s.n.ja;
    case "ko": return s.n.ko;
    case "ru": return s.n.ru;
    case "fr": return s.n.fr;
    case "es": return s.n.es;
    default: return s.n.en;
  }
}

/** All nations present in the data, ordered roughly by fleet size. */
export const NATIONS = [
  "usa", "japan", "germany", "united_kingdom", "russia", "france",
  "italy", "pan_asia", "europe", "commonwealth", "pan_america",
  "netherlands", "spain", "events",
] as const;

const FLAGS: Record<string, string> = {
  usa: "🇺🇸",
  japan: "🇯🇵",
  germany: "🇩🇪",
  united_kingdom: "🇬🇧",
  russia: "🇷🇺",
  france: "🇫🇷",
  italy: "🇮🇹",
  pan_asia: "🇨🇳",
  europe: "🇪🇺",
  commonwealth: "🇦🇺",
  pan_america: "🌎",
  netherlands: "🇳🇱",
  spain: "🇪🇸",
  events: "⭐",
};

export function nationFlag(nation: string): string {
  return FLAGS[nation] ?? "🏳️";
}
