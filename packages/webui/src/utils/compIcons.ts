/** Composition icon glyphs (成分图标印章 — the live panel's 空中小人 /
 *  水下小人 faces). Original in-house vector silhouettes, drawn for this
 *  repo (no icon-font dependency, no licensed asset): a carrier-aviation
 *  plane (nose up, plan view) for the CV share, a side-view submarine (bow
 *  left) for the SS share.
 *
 *  Dual-track by design, the same contract RatingStamp's "full"/"mini"
 *  faces keep: the ONE identity renders as two prepared detail levels so
 *  each size gets a drawing made for it, never a scaled-down wrong one.
 *   - "mini" (缩略图场景): a single chunky filled silhouette on a 24×24
 *     grid — reads at the live rows' 34px seal size where any interior
 *     detail would smear into noise.
 *   - "full" (大图场景): the same silhouette scaled to 48×48 plus a
 *     subdued detail layer (prop arc + canopy + nacelles for the plane,
 *     periscope + fin + portholes + waterline for the submarine) for any
 *     future large rendering.
 *
 *  The primary consumer is the square seal component (components/base/
 *  CompSeal), which embeds [`COMP_ICON_BODY`] inside its own stamped SVG
 *  frame — this module carries only the glyph geometry, monochrome and
 *  `currentColor`-skinned everywhere (tier coloring is the caller's). The
 *  in-game Tab overlay keeps its TEXT seals; the water-meter faces keep the
 *  four-char bitmap seals (RatingStamp) — neither consumes this module. */

export type CompIconKind = "air" | "sub";

/** The chunky one-path silhouettes (24×24, nose-up plane / bow-left
 *  submarine). The submarine carries its sail as a second subpath inside
 *  the same fill. CompSeal scales this onto its face with an SVG group
 *  transform — the path coordinates stay on the 24 grid. */
export const COMP_ICON_BODY: Record<CompIconKind, string> = {
  // Plane, plan view, nose up: tapered fuselage, swept wings out to the
  // 22-unit tips, smaller mirrored tailplane, all one closed path.
  air: "M12 1.5C12.9 2.7 13.5 4.5 13.5 6.5L13.5 9L22 14.2L22 16.4L13.5 13.6"
    + "L13.5 16.9L17 20.1L17 21.8L12 20.4L7 21.8L7 20.1L10.5 16.9L10.5 13.6"
    + "L2 16.4L2 14.2L10.5 9L10.5 6.5C10.5 4.5 11.1 2.7 12 1.5Z",
  // Submarine, side view, bow left: a sleek teardrop attack hull (pointed
  // bow, level deck, tapered rounded stern) with a raked sail, periscope
  // mast, upper stern rudder and a propeller disc — subpaths in one fill.
  sub: "M1.6 13.8C2.1 12.4 3.6 11.35 5.4 11.15L14.2 11.15C17.6 11.15 20.1"
    + " 12.2 21.4 13.25C22 13.75 22 14 21.4 14.45C20.1 15.5 17.6 16.55"
    + " 14.2 16.55L5.4 16.55C3.6 16.35 2.1 15.3 1.6 13.8Z"
    + "M8.7 11.15L10 7.35C10.15 6.85 10.6 6.5 11.1 6.5L12.2 6.5C12.7 6.5"
    + " 13.15 6.85 13.3 7.35L13.9 11.15Z"
    + "M11.15 6.5L11.15 4.35L11.85 4.35L11.85 6.5Z"
    + "M19.7 12.4L21.1 10.9L22.15 10.9L21.55 12.75Z"
    + "M21.7 12.3C22.85 12.6 22.85 15.1 21.7 15.4Z",
};

/** Detail-layer markup for the large track (48 grid): stroked/filled
 *  accents at reduced opacity — embedded by the seal component's "full"
 *  variant beside the 48-grid body. */
export const COMP_ICON_DETAIL: Record<CompIconKind, string> = {
  // Plane: spinning-prop arc + spinner at the nose, cockpit bubble, two
  // engine nacelles on the wings, wing-spar lines.
  air: '<circle cx="24" cy="7.4" r="2" fill="currentColor"/>'
    + '<ellipse cx="24" cy="6" rx="8.4" ry="2" fill="none" stroke="currentColor"'
    + ' stroke-width="1.5" opacity="0.45"/>'
    + '<circle cx="24" cy="14.6" r="2.1" fill="currentColor" opacity="0.85"/>'
    + '<ellipse cx="17.2" cy="23.2" rx="2.5" ry="4" fill="currentColor" opacity="0.8"/>'
    + '<ellipse cx="30.8" cy="23.2" rx="2.5" ry="4" fill="currentColor" opacity="0.8"/>'
    + '<path d="M14.2 21.4L20.4 25.2M33.8 21.4L27.6 25.2" fill="none"'
    + ' stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.5"/>',
  // Submarine: portholes along the hull, a sail window, the deck seam
  // line, and two staggered waterline waves under the hull (the hull's own
  // periscope / rudder / propeller ride the body silhouette already).
  sub: '<circle cx="13" cy="27.6" r="1.7" fill="currentColor" opacity="0.7"/>'
    + '<circle cx="19" cy="27.6" r="1.7" fill="currentColor" opacity="0.7"/>'
    + '<circle cx="25" cy="27.6" r="1.7" fill="currentColor" opacity="0.7"/>'
    + '<circle cx="22.8" cy="17" r="1.5" fill="currentColor" opacity="0.75"/>'
    + '<path d="M7 25.6L37 25.6" fill="none" stroke="currentColor"'
    + ' stroke-width="1.5" stroke-linecap="round" opacity="0.45"/>'
    + '<path d="M6 35.4C9 33.8 12 33.8 15 35.4C18 37 21 37 24 35.4C27 33.8 30 33.8'
    + ' 33 35.4C36 37 39 37 42 35.4" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" opacity="0.45"/>'
    + '<path d="M10 40C13 38.4 16 38.4 19 40C22 41.6 25 41.6 28 40C31 38.4 34 38.4 37 40"'
    + ' fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.3"/>',
};

/** Scale a 24-grid path string onto the 48 grid. The bodies are built from
 *  one-decimal coordinates, so a token-wise ×2 keeps the curves exact.
 *  This holds because both paths use only M/C/L/Z commands, whose tokens
 *  are all coordinates — an elliptical-arc `A` command's large-arc/sweep
 *  flags are single DIGITS a numeric doubling would corrupt, so introducing
 *  one into COMP_ICON_BODY means replacing this with an arc-aware scaler. */
function scalePath24to48(path: string): string {
  return path.replace(/-?\d+(?:\.\d+)?/g, (n) => String(Number(n) * 2));
}

/** The large track's body path (48 grid) — the mini silhouette scaled
 *  whole, the detail layer (COMP_ICON_DETAIL) riding beside it. */
export function compIconBody48(kind: CompIconKind): string {
  return scalePath24to48(COMP_ICON_BODY[kind]);
}
