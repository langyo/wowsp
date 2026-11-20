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

/** The game's aircraft art only ships ALLY faces — an enemy squadron drawn
 *  with it read green on the minimap (2026-11-20 report). Team-tinted
 *  variants: the ally face passes through untouched, the enemy face is a
 *  cached offscreen canvas whose pixels are recolored with source-in (the
 *  original silhouette is the mask, so the marker keeps its shape). */
const tintCache = new Map<string, HTMLCanvasElement | null>();
const ROLE_TINT: Record<string, string> = {
  enemy: "rgba(226, 64, 64, 0.98)",
};

export function planeIconTinted(
  type: string,
  role: "ally" | "enemy" | "self" | "neutral" | undefined,
): HTMLImageElement | HTMLCanvasElement | null {
  const tint = role ? ROLE_TINT[role] : undefined;
  const img = planeIcon(type);
  if (!tint || !img) return img;
  const key = `${type}:${role}`;
  if (tintCache.has(key)) return tintCache.get(key) ?? img;
  if (!img.complete || img.naturalWidth === 0) return img;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c2d = canvas.getContext("2d");
  if (!c2d) {
    tintCache.set(key, null);
    return img;
  }
  c2d.drawImage(img, 0, 0);
  c2d.globalCompositeOperation = "source-in";
  c2d.fillStyle = tint;
  c2d.fillRect(0, 0, w, h);
  tintCache.set(key, canvas);
  return canvas;
}

export default planeIcon;
