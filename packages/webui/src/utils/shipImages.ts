/**
 * Local ship image resolution.
 *
 * Ship portraits are cached under `src/res/images/ships/<shipId>.png`.
 * Since `src/res` is Vite's publicDir, images are served at root path
 * (e.g. `/images/ships/12345.png`). This module discovers which images
 * exist via a glob and constructs proper public URLs.
 */

const _imgGlob = import.meta.glob("../res/images/ships/*.png", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const localImageIds = new Set<string>();
for (const path of Object.keys(_imgGlob)) {
  const stem = path.split("/").pop()!.replace(/\.png$/i, "");
  localImageIds.add(stem);
}

export function resolveShipImage(
  shipId: number | undefined,
  cdnUrl: string | undefined,
  _size?: string,
): string | null {
  if (shipId != null && localImageIds.has(String(shipId))) {
    return `/images/ships/${shipId}.png`;
  }
  return cdnUrl ?? null;
}

export function hasLocalImage(shipId: number | undefined): boolean {
  if (shipId == null) return false;
  return localImageIds.has(String(shipId));
}
