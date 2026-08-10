/**
 * Shared registry for the game's OWN battle-HUD ship icons
 * (`gui/battle_hud/markers/ship/icon_{variant}_{class}.png`).
 *
 * Both apps ship the same extracted PNGs but bundle them through their own
 * asset pipelines, so each app registers its URL map once at startup; the
 * shared scorebar / minimap then render the real game icons everywhere.
 */
export type HoloShipIconVariant = "ally" | "enemy" | "sunk";

export type HoloShipClass =
  | "battleship" | "cruiser" | "destroyer" | "aircarrier" | "submarine" | "auxiliary";

/** Map a WG ShipInfo.type string to the icon-atlas class key. */
export function shipTypeClass(type: string | null | undefined): HoloShipClass {
  const t = (type ?? "").toLowerCase();
  if (t.includes("battleship")) return "battleship";
  if (t.includes("cruiser")) return "cruiser";
  if (t.includes("destroyer")) return "destroyer";
  if (t.includes("aircarrier") || t.includes("aircar")) return "aircarrier";
  if (t.includes("submarine")) return "submarine";
  if (t.includes("auxiliary")) return "auxiliary";
  return "battleship";
}

type UrlMap = Partial<Record<HoloShipClass, string>>;
const urlRegistry: Record<HoloShipIconVariant, UrlMap> = { ally: {}, enemy: {}, sunk: {} };

/** Register the app's bundled icon URLs (call once per app bootstrap). */
export function registerHoloShipIcons(variant: HoloShipIconVariant, urls: UrlMap): void {
  Object.assign(urlRegistry[variant], urls);
}

export function holoShipIconUrl(type: string | null | undefined, variant: HoloShipIconVariant): string | null {
  return urlRegistry[variant][shipTypeClass(type)] ?? null;
}

const imgCache = new Map<string, HTMLImageElement>();
/** Lazy-loaded HTMLImageElement for canvas drawing (may still be decoding —
 *  check `.complete && .naturalWidth` before drawImage). */
export function holoShipIconImage(type: string | null | undefined, variant: HoloShipIconVariant): HTMLImageElement | null {
  const url = holoShipIconUrl(type, variant);
  if (!url) return null;
  let img = imgCache.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    imgCache.set(url, img);
  }
  return img;
}
