/**
 * Local ship image resolution.
 *
 * Local portraits come from the baked set cached under
 * `src/res/images/ships/<shipId>.png`; anything not baked rides the proxied
 * `media` protocol (see `./media`), whose Rust handler honors the configured
 * network proxy and disk-caches the result.
 *
 * Since `src/res` is Vite's publicDir, local images are served at root path
 * (e.g. `/images/ships/12345.png`). We collect filenames lazily from
 * glob keys — no eager import of hundreds of PNGs.
 */
import { mediaImageUrl } from "./media";

const _imgGlobKeys = Object.keys(
  import.meta.glob("../res/images/ships/*.png"),
);
const localImageIds = new Set<string>();
for (const path of _imgGlobKeys) {
  localImageIds.add(path.split("/").pop()!.replace(/\.png$/i, ""));
}

export function resolveShipImage(
  shipId: number | undefined,
  cdnUrl: string | undefined,
  _size?: string,
): string | null {
  if (shipId != null && localImageIds.has(String(shipId))) {
    return `/images/ships/${shipId}.png`;
  }
  return cdnUrl ? mediaImageUrl(cdnUrl) : null;
}

export function hasLocalImage(shipId: number | undefined): boolean {
  if (shipId == null) return false;
  return localImageIds.has(String(shipId));
}
