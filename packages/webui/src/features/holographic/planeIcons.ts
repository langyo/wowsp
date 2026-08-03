/** Lazy-load the in-game aircraft-type icons (battle-HUD minimap markers)
 *  for the replay viewer's minimap. Keys mirror the PLANE_TYPES type names. */
import auxiliaryUrl from "../../res/images/planes/auxiliary_ally.png";
import bomberApUrl from "../../res/images/planes/bomber_ap_ally.png";
import bomberHeUrl from "../../res/images/planes/bomber_he_ally.png";
import fighterUrl from "../../res/images/planes/fighter_ally.png";
import scoutUrl from "../../res/images/planes/scout_ally.png";
import skipApUrl from "../../res/images/planes/skip_ap_ally.png";
import torpedoUrl from "../../res/images/planes/torpedo_regular_ally.png";

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
