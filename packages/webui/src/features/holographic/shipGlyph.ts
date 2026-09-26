/**
 * Ship-class glyphs for the holographic map's 2D canvases (minimap thumb +
 * enlarged view), extracted verbatim from HolographicMap.tsx. Pure canvas-2D
 * drawing — no three.js, no reactive state.
 */

/** Ship-class glyph polygons TRACED from the game's own 28×28 HUD
 *  bitmaps (scripts/trace_icons.mjs: connected-component boundary
 *  extraction + Douglas-Peucker). Each class is a list of solid
 *  polygons; the GAPS between them reproduce the icons' engraved class
 *  separators — battleship: two slanted cuts, cruiser: one, carrier:
 *  deck line + bow joint, submarine: tail joint, destroyer: plain
 *  triangle. Bow points RIGHT (+x) at 0 rotation. */
const SHIP_GLYPH_POLYS: Record<string, number[][][]> = {
  destroyer: [
    [[5.5, 9.5], [21.5, 13.5], [5.5, 17.5]],
  ],
  cruiser: [
    [[16.5, 9.5], [18.5, 9.5], [22.5, 13.5], [18.5, 17.5], [11.5, 17.5], [15.5, 10.5]],
    [[5.5, 9.5], [13.5, 9.5], [8.5, 17.5], [5.5, 17.5]],
  ],
  battleship: [
    [[5.5, 9.5], [11.5, 9.5], [6.5, 17.5], [5.5, 17.5]],
    [[14.5, 9.5], [15.5, 9.5], [11.5, 16.5], [9.5, 17.5], [13.5, 10.5]],
    [[18.5, 9.5], [22.5, 13.5], [18.5, 17.5], [13.5, 17.5], [17.5, 10.5]],
  ],
  aircarrier: [
    [[16.5, 9.5], [18.5, 9.5], [22.5, 13.5], [18.5, 17.5], [16.5, 17.5]],
    [[5.5, 9.5], [14.5, 9.5], [14.5, 12.5], [5.5, 12.5]],
    [[5.5, 14.5], [14.5, 14.5], [14.5, 17.5], [5.5, 17.5]],
  ],
  submarine: [
    [[5.5, 9.5], [6.5, 9.5], [6.5, 17.5], [5.5, 17.5]],
    [[9.5, 10.5], [21.5, 13.5], [9.5, 16.5]],
  ],
};

/** Draw a WoWS class glyph on a canvas context, centered at (x, y),
 *  `size` px tall, in the given color. Solid mode fills the traced
 *  polygons (vector — anti-aliased at any scale/rotation, where the
 *  raster HUD PNGs alias); outline mode strokes each polygon with a
 *  THIN line and no fill — the inter-polygon gaps stay transparent so
 *  the class engraving reads as a proper cut-out (thick strokes would
 *  bridge the 1-2px seams between the traced bands). */
export function drawShipGlyph(
  ctx: CanvasRenderingContext2D,
  type: string | undefined,
  x: number,
  y: number,
  size: number,
  color: number,
  opts?: { outline?: boolean; lineWidth?: number },
) {
  const t = type?.toLowerCase() ?? "";
  const cls = t.includes("destroyer")
    ? "destroyer"
    : t.includes("battleship")
      ? "battleship"
      : t.includes("aircarrier") || t.includes("aircar")
        ? "aircarrier"
        : t.includes("submarine")
          ? "submarine"
          : "cruiser"; // auxiliary + unknown fall back to cruiser
  const polys = SHIP_GLYPH_POLYS[cls];
  const s = size / 28;
  const hex = `#${color.toString(16).padStart(6, "0")}`;
  for (const poly of polys) {
    ctx.beginPath();
    ctx.moveTo(x + poly[0][0] * s, y + poly[0][1] * s);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(x + poly[i][0] * s, y + poly[i][1] * s);
    }
    ctx.closePath();
    if (opts?.outline) {
      // Hairline engraved outline: 0.75 device px per polygon edge (the
      // seams between the traced bands read as the class engraving).
      // Modern displays rasterise sub-pixel strokes cleanly, and thin
      // beats thick here — the traced polygons sit 1-2 atlas units
      // apart, so fat strokes bridge the seams. NOTE the scale is the
      // rotation-invariant magnitude (a alone is s·cosθ and would make
      // diagonally-rotated glyphs ~41% thicker).
      const m = ctx.getTransform();
      const devScale = Math.max(1e-6, Math.hypot(m.a, m.b) || 1);
      ctx.strokeStyle = hex;
      ctx.lineWidth = 0.75 / devScale;
      ctx.lineJoin = "round";
      ctx.stroke();
    } else {
      ctx.fillStyle = hex;
      ctx.fill();
    }
  }
}
