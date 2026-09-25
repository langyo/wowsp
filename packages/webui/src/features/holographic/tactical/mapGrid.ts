/**
 * Minimap grid overlay: the game's own A–J / 1–10 grid (10×10 over the full
 * map rect), drawn so it can ROTATE with the map while its coordinate labels
 * stay pinned to the screen's top and left edges — upright, never turned on
 * their side. Which family labels which edge swaps with rotation (past 45°
 * the letters' columns run horizontally, so they move to the left strip and
 * the numbers take the top), exactly like rotating a paper map under two
 * fixed rulers.
 *
 * `gridLabelLayout` is the at-rest layout for a map that fills the canvas
 * (the minimap thumb, scale 1). A pan/zoom viewport must instead project
 * each square's centre through the view window and call
 * `gridLabelLayoutForView`, so the labels ride their grid squares as the
 * camera moves instead of sitting at fixed decile slots that decouple from
 * the (world-anchored) grid lines the first time the user zooms.
 */

/** WoWS random-battle minimaps use a 10×10 letter/number grid. */
export const MAP_GRID_COLUMNS = 10;
export const GRID_LETTERS = "ABCDEFGHIJ";

export interface GridLabel {
  text: string;
  /** Label centre in logical canvas px (the strip edge offset is the caller's). */
  x: number;
  y: number;
  /** Pinned to the strip end nearest its off-canvas square: the view is
   *  zoomed in past a whole cell, so this label names the closest square
   *  THAT WAY rather than a position on the map — render it de-emphasised
   *  and it still tells the author which grid square they are looking at. */
  clamped?: boolean;
}

export interface GridLabelLayout {
  top: GridLabel[];
  left: GridLabel[];
}

const EDGE_BIAS = 0.35; // |cos θ| below this ⇒ a family's lines run too
// horizontally to label the top edge, so the families swap strips.

/** Label layout for grid squares whose centre lines land at `colCenters` /
 *  `rowCenters` logical px — values ALREADY projected through the current
 *  pan/zoom view (off-canvas entries allowed). Rotation and strip-swap rules
 *  are the fixed layout's; a family whose every square slid off-canvas keeps
 *  one clamped label (see GridLabel.clamped) so the rulers never go blank. */
export function gridLabelLayoutForView(
  theta: number,
  size: number,
  colCenters: number[],
  rowCenters: number[],
): GridLabelLayout {
  // Which strip a family labels only depends on the grid's 180°-symmetric
  // orientation, but the label POSITIONS need the real angle (order reverses
  // at 180°), so the rotation math uses theta itself.
  const t = ((theta % Math.PI) + Math.PI) % Math.PI;
  const lettersOnTop = Math.abs(Math.cos(t)) >= EDGE_BIAS;
  const c = size / 2;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // Rotate a logical-space point about the square centre.
  const rot = (x: number, y: number): [number, number] => [
    c + (x - c) * cos - (y - c) * sin,
    c + (x - c) * sin + (y - c) * cos,
  ];

  // Endpoint coordinates a hair off the edge (float noise at exact 45/90/180°
  // rotations) must still count as touching it.
  const EPS = 1e-6;
  const snap = (v: number): number => (Math.abs(v) < EPS ? 0 : v);

  /** Where does the screen segment a→b cross the given edge? null = never.
   *  An endpoint lying exactly on the edge counts as a crossing. */
  const crossTop = (a: [number, number], b: [number, number]): number | null => {
    const ay = snap(a[1]);
    const by = snap(b[1]);
    if (ay === by || Math.sign(ay) * Math.sign(by) > 0) return null;
    return a[0] + (ay / (ay - by)) * (b[0] - a[0]);
  };
  const crossLeft = (a: [number, number], b: [number, number]): number | null => {
    const ax = snap(a[0]);
    const bx = snap(b[0]);
    if (ax === bx || Math.sign(ax) * Math.sign(bx) > 0) return null;
    return a[1] + (ax / (ax - bx)) * (b[1] - a[1]);
  };

  const margin = 14;
  const top: GridLabel[] = [];
  const left: GridLabel[] = [];
  /** Not showing on its strip (crossed it out of range, or never reached it
   *  at this rotation): candidates for the keep-nearest fallback when
   *  nothing else is on-canvas. */
  const offCanvas: { label: GridLabel; pos: number; dist: number; strip: GridLabel[] }[] = [];

  const place = (text: string, seg: [[number, number], [number, number]], onTop: boolean): void => {
    const [a, b] = seg;
    let pos = onTop ? crossTop(a, b) : crossLeft(a, b);
    let edgeDist = 0;
    if (pos == null) {
      // The line never reaches this strip (steep rotation + deep zoom).
      // Stand in with its nearest endpoint so the fallback can still keep a
      // label on the ruler instead of letting it go blank.
      const da = onTop ? Math.abs(snap(a[1])) : Math.abs(snap(a[0]));
      const db = onTop ? Math.abs(b[1]) : Math.abs(b[0]);
      const near = da <= db ? a : b;
      pos = onTop ? near[0] : near[1];
      edgeDist = Math.min(da, db);
    }
    if (pos >= margin && pos <= size - margin && edgeDist === 0) {
      (onTop ? top : left).push(onTop ? { text, x: pos, y: 0 } : { text, x: 0, y: pos });
      return;
    }
    const stripDist = pos < margin ? margin - pos : pos > size - margin ? pos - (size - margin) : 0;
    offCanvas.push({
      label: onTop ? { text, x: pos, y: 0 } : { text, x: 0, y: pos },
      pos,
      dist: edgeDist + stripDist,
      strip: onTop ? top : left,
    });
  };

  for (let i = 0; i < colCenters.length && i < MAP_GRID_COLUMNS; i++) {
    const x = colCenters[i];
    const letter = GRID_LETTERS[i];
    if (lettersOnTop) place(letter, [rot(x, 0), rot(x, size)], true);
    else place(letter, [rot(x, 0), rot(x, size)], false);
  }
  for (let j = 0; j < rowCenters.length && j < MAP_GRID_COLUMNS; j++) {
    const y = rowCenters[j];
    const num = String(j + 1);
    if (lettersOnTop) place(num, [rot(0, y), rot(size, y)], false);
    else place(num, [rot(0, y), rot(size, y)], true);
  }

  // Deep-zoom fallback: a ruler with nothing on it is useless — keep the
  // nearest off-canvas square clamped to the strip end.
  for (const strip of [top, left]) {
    if (strip.length > 0) continue;
    const nearest = offCanvas
      .filter((o) => o.strip === strip)
      .sort((a, b) => a.dist - b.dist)[0];
    if (!nearest) continue;
    const pos = Math.min(size - margin, Math.max(margin, nearest.pos));
    strip.push(
      nearest.label.x === 0
        ? { ...nearest.label, y: pos, clamped: true }
        : { ...nearest.label, x: pos, clamped: true },
    );
  }
  return { top, left };
}

/** Cell-centre label positions for a map square of `size` logical px rotated
 *  by `theta` (radians, canvas rotate() convention) around its centre, with
 *  the FULL map filling the canvas (scale 1 — the minimap thumb). */
export function gridLabelLayout(theta: number, size: number): GridLabelLayout {
  const cell = size / MAP_GRID_COLUMNS;
  return gridLabelLayoutForView(
    theta,
    size,
    Array.from({ length: MAP_GRID_COLUMNS }, (_, i) => (i + 0.5) * cell),
    Array.from({ length: MAP_GRID_COLUMNS }, (_, j) => (j + 0.5) * cell),
  );
}
