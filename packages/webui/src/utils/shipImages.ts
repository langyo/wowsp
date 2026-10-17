/**
 * Local ship image resolution.
 *
 * Local portraits come from the baked set cached under
 * `src/res/images/ships/<shipId>.webp` (PNG on trees mid-migration — old
 * resource packs still hold `.png`); anything not baked rides the proxied
 * `media` protocol (see `./media`), whose Rust handler honors the configured
 * network proxy and disk-caches the result.
 *
 * Since `src/res` is Vite's publicDir, local images are served at root path
 * (e.g. `/images/ships/12345.webp`). We collect filenames lazily from
 * glob keys — no eager import of hundreds of portraits. The stem→extension
 * map keeps URL building extension-resilient while the pack channel serves
 * mixed trees; stems the glob has never seen (a pack-only ship added after
 * this build was cut) optimistically get `.webp`, today's pack format.
 */
import { mediaImageUrl } from "./media";

const _imgGlobKeys = Object.keys(
  import.meta.glob("../res/images/ships/*.{png,webp}"),
);
const localImageIds = new Set<string>();
const localImageExt = new Map<string, string>();
for (const path of _imgGlobKeys) {
  const name = path.split("/").pop()!;
  const dot = name.lastIndexOf(".");
  const stem = name.slice(0, dot);
  localImageIds.add(stem);
  localImageExt.set(stem, name.slice(dot));
}

export function resolveShipImage(
  shipId: number | undefined,
  cdnUrl: string | undefined,
  _size?: string,
): string | null {
  const id = shipId == null ? null : String(shipId);
  if (id != null && localImageIds.has(id)) {
    return `/images/ships/${id}${localImageExt.get(id) ?? ".webp"}`;
  }
  return cdnUrl ? mediaImageUrl(cdnUrl) : null;
}

export function hasLocalImage(shipId: number | undefined): boolean {
  if (shipId == null) return false;
  return localImageIds.has(String(shipId));
}
