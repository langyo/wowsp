/** Lazy-load the in-game aircraft-type icons (battle-HUD minimap markers)
 *  for the replay viewer's minimap. Keys mirror the PLANE_TYPES type names. */
// PublicDir art served at the root path (see utils/shipImages.ts) — plain
// URL constants instead of imports (same URLs, no module-graph nodes).
const auxiliaryUrl = "/images/planes/auxiliary_ally.webp";
const bomberApUrl = "/images/planes/bomber_ap_ally.webp";
const bomberHeUrl = "/images/planes/bomber_he_ally.webp";
const fighterUrl = "/images/planes/fighter_ally.webp";
const scoutUrl = "/images/planes/scout_ally.webp";
const skipApUrl = "/images/planes/skip_ap_ally.webp";
const torpedoUrl = "/images/planes/torpedo_regular_ally.webp";

const ICON_URLS: Record<string, string> = {
  fighter: fighterUrl,
  dive: bomberHeUrl,
  skip: skipApUrl,
  torpedo: torpedoUrl,
  rocket: auxiliaryUrl,
  bomber: bomberApUrl,
  scout: scoutUrl,
  attack: auxiliaryUrl,
};

const cache: Record<string, HTMLImageElement | null> = {};
export function planeIcon(type: string): HTMLImageElement | null {
  if (type in cache) return cache[type];
  const url = ICON_URLS[type] ?? auxiliaryUrl;
  const img = new Image();
  img.src = url;
  cache[type] = img;
  return img;
}

export default planeIcon;
