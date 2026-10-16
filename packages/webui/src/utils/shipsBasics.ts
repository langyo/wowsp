/**
 * Bundled ship-basics fallback (`src/res/data/ships_basics.json`, generated
 * by `build_planner_data.py --only ship-basics` from the WG online
 * encyclopedia). The lite install ships it so 舰艇百科, ship specs and the
 * build planner keep working when the WG API is unreachable (offline, blocked
 * network) — everything the UI reads off `ShipInfo.defaultProfile` comes from
 * here in that case. Armor overlays, weapon bars and upgrade prices still
 * need a game install and degrade via their own banners.
 *
 * Names/descriptions are the WG API's English strings; display names get the
 * localized overlay from ship_names.json (same as the online path). The file
 * is lazy-fetched (3.5 MB) so it never lands in the main bundle.
 */
import type { ShipInfo } from "@/api";

export interface ShipBasics {
  name: string;
  tier: number;
  type: string;
  nation: string;
  isPremium?: boolean;
  isSpecial?: boolean;
  description?: string;
  defaultProfile?: unknown;
  images?: { small: string; medium: string; large: string; contour: string };
}

export interface ShipsBasics {
  gameVersion: string;
  ships: Record<string, ShipBasics>;
}

let cache: Promise<ShipsBasics> | null = null;

/** Fetch (once) and keep the bundled basics. Rejects only if the asset is
 *  genuinely unavailable — callers decide their own degraded display. */
export function loadShipsBasics(): Promise<ShipsBasics> {
  cache ??= fetch("/data/ships_basics.json").then((r) => {
    if (!r.ok) throw new Error(`ships_basics.json HTTP ${r.status}`);
    return r.json() as Promise<ShipsBasics>;
  });
  return cache;
}

/** Build a full ShipInfo from a bundled entry (gameVersion from the bundle). */
export function basicsToShipInfo(
  shipId: number,
  basics: ShipsBasics,
  entry: ShipBasics,
): ShipInfo {
  return {
    shipId,
    name: entry.name,
    tier: entry.tier,
    type: entry.type,
    nation: entry.nation,
    isPremium: !!entry.isPremium,
    isSpecial: !!entry.isSpecial,
    description: entry.description ?? "",
    gameVersion: basics.gameVersion,
    defaultProfile: entry.defaultProfile ?? null,
    images: entry.images ?? { small: "", medium: "", large: "", contour: "" },
  };
}
