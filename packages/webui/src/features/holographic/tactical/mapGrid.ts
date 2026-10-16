/**
 * Minimap grid overlay: the game's own A–J / 1–10 grid (10×10 over the full
 * map rect). Labels sit on the screen's top (letters) and left (numbers)
 * edges, riding the squares they name: the caller projects each square's
 * centre through the current pan/zoom view, so panning/zooming moves the
 * labels together with the (world-anchored) grid lines instead of leaving
 * them parked at fixed decile slots. When deep zoom pushes every square of
 * a family off-canvas, the nearest one is pinned to the strip end (flagged
 * `clamped`) so the ruler always names the square being looked at.
 *
 * `theta` is the map's world-frame rotation (radians, canvas rotate
 * convention): labels stay pinned to the screen strips, so WHICH family
 * labels which strip swaps once a family's lines run parallel to the other
 * strip (at the 90°/270° rotate steps; EDGE_BIAS sets the exact angle), and
 * each label's position rides its (rotated) square — like rotating a paper
 * map under two fixed rulers.
 */

/** WoWS random-battle minimaps use a 10×10 letter/number grid. */
export const MAP_GRID_COLUMNS = 10;
export const GRID_LETTERS = "ABCDEFGHIJ";

/** How far a label may sit from the strip ends (logical px). */
const MARGIN = 14;

/** |cos θ| below this ⇒ a family's lines run too horizontally to label the
 *  top edge, so the families swap strips. */
const EDGE_BIAS = 0.35;

export interface GridLabel {
  text: string;
  /** Label position on its strip (logical canvas px). */
  x: number;
  y: number;
  /** Pinned to the strip end nearest its off-canvas square: the view is
   *  zoomed in past a whole cell, so this label names the closest square
   *  THAT WAY rather than a position on the map — render it de-emphasised. */
  clamped?: boolean;
}

export interface GridLabelLayout {
  top: GridLabel[];
  left: GridLabel[];
}

/** Edge labels for grid squares whose centre lines land at `colCenters` /
 *  `rowCenters` logical px — values ALREADY projected through the current
 *  pan/zoom view (off-canvas entries allowed). Row j is the (j+1)-th band
 *  counted from NORTH (the game's numbering: row 1 sits at maxZ). `theta`
 *  is the map frame's rotation (0 = north-up). */
export function gridEdgeLabels(
  size: number,
  colCenters: number[],
  rowCenters: number[],
  theta = 0,
): GridLabelLayout {
  const top: GridLabel[] = [];
  const left: GridLabel[] = [];

  // Strip assignment only depends on the grid's 180°-symmetric
  // orientation; the POSITIONS need the real angle (order reverses at
  // 180°), so the rotation math uses theta itself.
  const lettersOnTop = Math.abs(Math.cos(theta)) >= EDGE_BIAS;
  const c = size / 2;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // Rotate a logical-space point about the square centre: where the map
  // frame carries the square's centre line at this rotation.
  const rot = (x: number, y: number): [number, number] => [
    c + (x - c) * cos - (y - c) * sin,
    c + (x - c) * sin + (y - c) * cos,
  ];

  const place = (text: string, pt: [number, number], onTop: boolean): void => {
    const pos = onTop ? pt[0] : pt[1];
    if (pos >= MARGIN && pos <= size - MARGIN) {
      (onTop ? top : left).push(onTop ? { text, x: pos, y: 0 } : { text, x: 0, y: pos });
      return;
    }
    offCanvas.push({ text, pos, onTop });
  };

  // Deep-zoom fallback: a ruler with nothing on it is useless — keep the
  // nearest off-canvas square clamped to the strip end it approached from.
  const offCanvas: { text: string; pos: number; onTop: boolean }[] = [];
  for (let i = 0; i < colCenters.length && i < MAP_GRID_COLUMNS; i++) {
    place(GRID_LETTERS[i], rot(colCenters[i], c), lettersOnTop);
  }
  for (let j = 0; j < rowCenters.length && j < MAP_GRID_COLUMNS; j++) {
    place(String(j + 1), rot(c, rowCenters[j]), !lettersOnTop);
  }
  for (const strip of [top, left] as const) {
    if (strip.length > 0) continue;
    const onTop = strip === top;
    const stripDist = (pos: number): number =>
      pos < MARGIN ? MARGIN - pos : pos > size - MARGIN ? pos - (size - MARGIN) : 0;
    const nearest = offCanvas
      .filter((o) => o.onTop === onTop)
      .sort((a, b) => stripDist(a.pos) - stripDist(b.pos))[0];
    if (!nearest) continue;
    const pos = Math.min(size - MARGIN, Math.max(MARGIN, nearest.pos));
    strip.push(onTop ? { text: nearest.text, x: pos, y: 0, clamped: true } : { text: nearest.text, x: 0, y: pos, clamped: true });
  }
  return { top, left };
}
