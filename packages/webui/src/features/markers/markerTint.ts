/**
 * markerTint — the animated NAME recoloring for marked players on the
 * app's lists (player names themselves carry the mark; the in-game
 * overlay keeps the dot-beside-name language instead).
 *
 * Red / yellow are same-hue flows (the color breathes through its own
 * shades); purple is the multi-hue "彩色流体" sweep. The class is
 * applied to the name SPAN, so masked nicknames (maskOf's bullet
 * swap) tint exactly like raw ones.
 */
import type { MarkerColor } from "@/api";

import "./markerTint.scss";

/** The tint class for a marker color ("" when unmarked). */
export function markerTintClass(color: MarkerColor | null | undefined): string {
  return color ? `marker-tint marker-tint--${color}` : "";
}
