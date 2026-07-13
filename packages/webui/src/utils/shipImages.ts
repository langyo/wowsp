/**
 * Local ship image resolution.
 *
 * Ship portraits are pre-downloaded by `scripts/model_convert/download_ship_images.py`
 * and cached under `src/res/images/ships/<shipId>.png` (which, because
 * `src/res` is Vite's publicDir, is served at runtime from
 * `${BASE_URL}images/ships/<shipId>.png`). This module discovers them via a
 * file-relative Vite glob (a `/src/res/...` absolute glob would trip Vite's
 * "publicDir served at root" warning) and provides a resolver returning the
 * local URL when available, falling back to the WG CDN URL otherwise.
 *
 * Design: prefer local images (offline-capable, no CDN dependency, committed
 * to the repo as permanent assets). Fall back to CDN for ships whose image
 * hasn't been downloaded yet.
 */
const localImageModules = import.meta.glob("../res/images/ships/*.png", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Map: shipId (as string) → local image URL. */
const localImageUrls = new Map<string, string>();
for (const [path, url] of Object.entries(localImageModules)) {
  const stem = path.split("/").pop()!.replace(/\.png$/i, "");
  localImageUrls.set(stem, url);
}

/**
 * Resolve the best available image URL for a ship.
 * Returns the local cached URL if available, otherwise the WG CDN URL,
 * otherwise null.
 */
export function resolveShipImage(
  shipId: number | undefined,
  cdnUrl: string | undefined,
  size: "small" | "medium" | "large" = "medium",
): string | null {
  if (shipId != null) {
    const local = localImageUrls.get(String(shipId));
    if (local) return local;
  }
  return cdnUrl ?? null;
}

/** Check whether a local image exists for the given shipId. */
export function hasLocalImage(shipId: number | undefined): boolean {
  if (shipId == null) return false;
  return localImageUrls.has(String(shipId));
}
