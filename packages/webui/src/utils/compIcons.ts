/** Composition icon glyphs (实时对局的成分图标印章 — the live Tab overlay's
 *  空中小人 / 水下小人 faces). Original in-house vector silhouettes, drawn
 *  for this repo (no icon-font dependency, no licensed asset): a carrier
 *  aviation plane (nose up, plan view) for the CV share, a side-view
 *  submarine (bow left) for the SS share.
 *
 *  Dual-track by design, the same contract RatingStamp's "full"/"mini"
 *  faces keep: the ONE identity renders as two prepared detail levels so
 *  each size gets a drawing made for it, never a scaled-down wrong one.
 *   - "mini" (缩略图场景): a single chunky filled silhouette on a 24×24
 *     grid — reads at the overlay chips' ~1em line size where any interior
 *     detail would smear into noise.
 *   - "full" (大图场景): the same silhouette scaled to 48×48 plus a
 *     subdued detail layer (prop arc + canopy + nacelles for the plane,
 *     periscope + fin + portholes + waterline for the submarine) for
 *     review surfaces and any future large rendering.
 *
 *  Everything is plain SVG markup strings with `currentColor`, so the bare
 *  DOM overlay page and Vue consumers skin them from CSS alike. Tier
 *  coloring (>=20% minor cinnabar / >=50% veteran gold) is the CALLER's
 *  styling — the glyph itself is monochrome. */

export type CompIconKind = "air" | "sub";
export type CompIconVariant = "full" | "mini";

/** The chunky one-path silhouettes (24×24, nose-up plane / bow-left
 *  submarine). The submarine carries its sail as a second subpath inside
 *  the same fill. */
const MINI_BODY: Record<CompIconKind, string> = {
  // Plane, plan view, nose up: tapered fuselage, swept wings out to the
  // 22-unit tips, smaller mirrored tailplane, all one closed path.
  air: "M12 1.5C12.9 2.7 13.5 4.5 13.5 6.5L13.5 9L22 14.2L22 16.4L13.5 13.6"
    + "L13.5 16.9L17 20.1L17 21.8L12 20.4L7 21.8L7 20.1L10.5 16.9L10.5 13.6"
    + "L2 16.4L2 14.2L10.5 9L10.5 6.5C10.5 4.5 11.1 2.7 12 1.5Z",
  // Submarine, side view, bow left: rounded-taper hull capsule plus the
  // conning-tower sail riding its top — two subpaths, one fill.
  sub: "M2.4 13.5C2.4 11.9 4.4 10.6 6.8 10.6L15.8 10.6C19 10.6 21.6 11.9"
    + " 21.6 13.6C21.6 15.3 19 16.6 15.8 16.6L6.8 16.6C4.4 16.6 2.4 15.3"
    + " 2.4 13.5Z"
    + "M8.8 10.6L9.6 7.2C9.7 6.7 10.1 6.4 10.6 6.4L12.8 6.4C13.3 6.4 13.7"
    + " 6.7 13.8 7.2L14.6 10.6Z",
};

/** The large-track body: the same silhouette at 2× (the 24-grid geometry
 *  scaled onto the 48 grid), so both tracks keep one shape identity. */
const FULL_BODY: Record<CompIconKind, string> = {
  air: scalePath24to48(MINI_BODY.air),
  sub: scalePath24to48(MINI_BODY.sub),
};

/** Detail layer markup for the large track (48 grid): stroked/filled
 *  accents at reduced opacity — present in "full" only. */
const FULL_DETAIL: Record<CompIconKind, string> = {
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
  // Submarine: periscope mast + head, stern fin, portholes, prop arc, and
  // two staggered waterline waves under the hull.
  sub: '<path d="M21.6 12.8L21.6 8.4L26.6 8.4" fill="none" stroke="currentColor"'
    + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M40.6 21.2C41 18.6 42.2 16.9 44.4 16.2L44.4 21.2Z" fill="currentColor" opacity="0.85"/>'
    + '<circle cx="13.5" cy="27.2" r="1.7" fill="currentColor" opacity="0.7"/>'
    + '<circle cx="20" cy="27.2" r="1.7" fill="currentColor" opacity="0.7"/>'
    + '<circle cx="26.5" cy="27.2" r="1.7" fill="currentColor" opacity="0.7"/>'
    + '<ellipse cx="45.2" cy="27.2" rx="1.5" ry="4.6" fill="currentColor" opacity="0.5"/>'
    + '<path d="M6 34.4C9 32.8 12 32.8 15 34.4C18 36 21 36 24 34.4C27 32.8 30 32.8'
    + ' 33 34.4C36 36 39 36 42 34.4" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" opacity="0.45"/>'
    + '<path d="M10 39C13 37.4 16 37.4 19 39C22 40.6 25 40.6 28 39C31 37.4 34 37.4 37 39"'
    + ' fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.3"/>',
};

/** Scale a 24-grid path string onto the 48 grid. The mini bodies are built
 *  from one-decimal coordinates, so a token-wise ×2 keeps the curves exact.
 *  This holds because both paths use only M/C/L/Z commands, whose tokens
 *  are all coordinates — an elliptical-arc `A` command's large-arc/sweep
 *  flags are single DIGITS a numeric doubling would corrupt, so introducing
 *  one into MINI_BODY means replacing this with an arc-aware scaler. */
function scalePath24to48(path: string): string {
  return path.replace(/-?\d+(?:\.\d+)?/g, (n) => String(Number(n) * 2));
}

/** One composition glyph as standalone `<svg>` markup, colored by
 *  `currentColor` and sized by the caller's CSS (the svg itself carries no
 *  width/height). `aria-hidden` — the surrounding badge carries the
 *  accessible label. */
export function compIconSvg(kind: CompIconKind, variant: CompIconVariant): string {
  if (variant === "mini") {
    return (
      `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">` +
      `<path d="${MINI_BODY[kind]}"/></svg>`
    );
  }
  return (
    `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">` +
    `<path fill="currentColor" d="${FULL_BODY[kind]}"/>` +
    `<g class="comp-icon__detail">${FULL_DETAIL[kind]}</g>` +
    `</svg>`
  );
}
