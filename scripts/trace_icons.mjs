// Trace the game's 28x28 HUD ship-class icons into vector polygons for
// HolographicMap's SHIP_GLYPH_POLYS. Pipeline: dump_icon_grids.ps1 exports
// each icon_<class>.png's alpha channel to D:\icon_<class>.txt ('#' >160,
// '+' 60..160, '.' <60); this script extracts connected components (the
// engraved separators are transparent, so classes split into 1-3 solid
// bands), Moore-traces each boundary and simplifies with Douglas-Peucker.
import { readFileSync } from 'node:fs';

const CLASSES = ['destroyer', 'cruiser', 'battleship', 'aircarrier', 'submarine'];
const NL = String.fromCharCode(10);
const key = (x, y) => x + ',' + y;

function loadGrid(cls) {
  const rows = readFileSync('D:\\icon_' + cls + '.txt', 'ascii').split(NL);
  const solid = new Set();
  rows.forEach((row, y) => {
    const bar = row.indexOf('|');
    if (bar < 0) return;
    const cells = row.slice(bar + 1);
    for (let x = 0; x < cells.length; x++) {
      if (cells[x] === '#') solid.add(key(x, y));
    }
  });
  return solid;
}

const N8 = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];

function components(solid) {
  const seen = new Set();
  const comps = [];
  const sorted = [...solid].map((k) => k.split(',').map(Number)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  for (const [sx, sy] of sorted) {
    if (seen.has(key(sx, sy))) continue;
    const comp = new Set();
    const stack = [[sx, sy]];
    seen.add(key(sx, sy));
    while (stack.length) {
      const [x, y] = stack.pop();
      comp.add(key(x, y));
      for (const [dx, dy] of N8) {
        const k2 = key(x + dx, y + dy);
        if (solid.has(k2) && !seen.has(k2)) { seen.add(k2); stack.push([x + dx, y + dy]); }
      }
    }
    comps.push(comp);
  }
  return comps;
}

function boundary(comp) {
  const pts = [...comp].map((k) => k.split(',').map(Number));
  const minPx = pts.reduce((a, b) => (b[1] < a[1] || (b[1] === a[1] && b[0] < a[0]) ? b : a));
  const inComp = (x, y) => comp.has(key(x, y));
  const contour = [];
  let cur = minPx;
  let dir = 6;
  const startKey = key(cur[0], cur[1]);
  let guard = 0;
  do {
    contour.push(cur);
    let found = null;
    for (let i = 0; i < 8; i++) {
      const d = (dir + 1 + i) % 8;
      const [dx, dy] = N8[d];
      if (inComp(cur[0] + dx, cur[1] + dy)) { found = d; break; }
    }
    if (found == null) break;
    const [dx, dy] = N8[found];
    cur = [cur[0] + dx, cur[1] + dy];
    dir = (found + 6) % 8;
    guard++;
  } while (guard < 5000 && key(cur[0], cur[1]) !== startKey);
  return contour;
}

function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / len;
}

function simplify(pts, eps) {
  if (pts.length <= 2) return pts;
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  const left = simplify(pts.slice(0, idx + 1), eps);
  const right = simplify(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

const out = {};
for (const cls of CLASSES) {
  const grid = loadGrid(cls);
  const polys = components(grid)
    .map((c) => simplify(boundary(c), 0.65))
    .filter((p) => p.length >= 3)
    .sort((a, b) => b.length - a.length)
    .map((p) => p.map(([x, y]) => [Math.round((x + 0.5) * 10) / 10, Math.round((y + 0.5) * 10) / 10]));
  out[cls] = polys;
  console.error(cls + ': ' + polys.length + ' polys, ' + polys.reduce((n, p) => n + p.length, 0) + ' pts');
}
console.log(JSON.stringify(out));
