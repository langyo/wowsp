# Platform badge archive

Raster archive (256×256, transparent background, lossless WebP) of the
game-client platform badges rendered by
`packages/webui/src/components/base/PlatformIcon.tsx`. The app draws them
as inline SVG — these files are the reference stills of the same marks,
for docs, store listings, and issue reports.

| File              | Platform                        | Mark                                                     |
| ----------------- | ------------------------------- | -------------------------------------------------------- |
| `steam.webp`      | Steam (`steam`)                 | Piston mark (simple-icons, CC0) inset 78% on the official navy-to-azure roundel gradient `#151d3a → #05669a` |
| `wargaming.webp`  | Wargaming (`wargaming`)         | World of Warships anchor shield: white rim, `#1e94cf` field |
| `lesta.webp`      | Lesta (`lesta`)                 | Мир кораблей cyan hexagon `#00d7eb` with navy `#010a19` anchor |
| `cn360.webp`      | CN 360 (`cn360`, `cnKongzhong`) | `#6fbe2c` disc with white "360" digits (Roboto Bold outlines, Apache 2.0) |

Provenance: the WG shield and Lesta hexagon are hand-traced from the
official client icons (`game_metadata/game.ico` shipped with each
install); no official brand asset files are vendored here — these
rasterisations are of wowsp's own traced marks. Regenerate with the
same pipeline rather than hand-editing: render each badge's SVG at
256 px and encode as lossless WebP.
