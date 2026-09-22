/**
 * Minimap grid overlay: the game's own A–J / 1–10 grid (10×10 over the full
 * map rect), drawn so it can ROTATE with the map while its coordinate labels
 * stay pinned to the screen's top and left edges — upright, never turned on
 * their side. Which family labels which edge swaps with rotation (past 45°
 * the letters' columns run horizontally, so they move to the left strip and
 * the numbers take the top), exactly like rotating a paper map under two
 * fixed rulers.
 */

/** WoWS random-battle minimaps use a 10×10 letter/number grid. */
export const MAP_GRID_COLUMNS = 10;
export const GRID_LETTERS = "ABCDEFGHIJ";

export interface GridLabel {
  text: string;
  /** Label centre in logical canvas px (the strip edge offset is the caller's). */
  x: number;
  y: number;
}

export interface GridLabelLayout {
  top: GridLabel[];
  left: GridLabel[];
}

const EDGE_BIAS = 0.35; // |cos θ| below this ⇒ a family's lines run too
// horizontally to label the top edge, so the families swap strips.

/** Cell-centre label positions for a map square of `size` logical px rotated
 *  by `theta` (radians, canvas rotate() convention) around its centre.
 *  Every returned position is guaranteed inside [margin, size - margin]. */
export function gridLabelLayout(theta: number, size: number): GridLabelLayout {
  // Which strip a family labels only depends on the grid's 180°-symmetric
  // orientation, but the label POSITIONS need the real angle (order reverses
  // at 180°), so the rotation math uses theta itself.
  const t = ((theta % Math.PI) + Math.PI) % Math.PI;
  const lettersOnTop = Math.abs(Math.cos(t)) >= EDGE_BIAS;
  const c = size / 2;
  const cell = size / MAP_GRID_COLUMNS;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // Rotate a logical-space point about the square centre.
  const rot = (x: number, y: number): [number, number] => [
    c + (x - c) * cos - (y - c) * sin,
    c + (x - c) * sin + (y - c) * cos,
  ];

  const top: GridLabel[] = [];
  const left: GridLabel[] = [];

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

  const columnLine = (i: number): [[number, number], [number, number]] => {
    const x = (i + 0.5) * cell;
    return [rot(x, 0), rot(x, size)];
  };
  const rowLine = (j: number): [[number, number], [number, number]] => {
    const y = (j + 0.5) * cell;
    return [rot(0, y), rot(size, y)];
  };

  const margin = 14;
  for (let i = 0; i < MAP_GRID_COLUMNS; i++) {
    const [a, b] = columnLine(i);
    const letter = GRID_LETTERS[i];
    if (lettersOnTop) {
      const x = crossTop(a, b);
      if (x != null && x >= margin && x <= size - margin) top.push({ text: letter, x, y: 0 });
    } else {
      const y = crossLeft(a, b);
      if (y != null && y >= margin && y <= size - margin) left.push({ text: letter, x: 0, y });
    }
  }
  for (let j = 0; j < MAP_GRID_COLUMNS; j++) {
    const [a, b] = rowLine(j);
    const num = String(j + 1);
    if (lettersOnTop) {
      const y = crossLeft(a, b);
      if (y != null && y >= margin && y <= size - margin) left.push({ text: num, x: 0, y });
    } else {
      const x = crossTop(a, b);
      if (x != null && x >= margin && x <= size - margin) top.push({ text: num, x, y: 0 });
    }
  }
  return { top, left };
}
