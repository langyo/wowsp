/**
 * Armor-plate overlay for the homepage ship stage — a faithful port of the
 * app's ShipStage `buildArmorOverlay` (armor-viewer mode): the hull is
 * replaced by a set of THIN PLATES (belt runs, citadel walls, deck bands),
 * each a separate box with its own thickness colour and an edge outline,
 * over a translucent dark hull clone + waterline plane + grid.
 *
 * Coordinates: the ship is normalized to length 10 along +Z with the BOW at
 * +maxZ (the website stage's own convention). Zone ratios are expressed the
 * same way as the app (zr: 0 = stern → 1 = bow).
 */
import * as THREE from "three";

export interface ArmorZone {
  name: string;
  /** Thickness in mm; drives the plate colour. */
  thickness: number;
}

/** The app's fixed thickness buckets (ballistics.ts ARMOR_BUCKETS). */
const ARMOR_BUCKETS: { lo: number; hi: number; color: string }[] = [
  { lo: 0, hi: 32, color: "#8a9099" },
  { lo: 33, hi: 99, color: "#5fb0d8" },
  { lo: 100, hi: 199, color: "#3a7bd5" },
  { lo: 200, hi: 299, color: "#9b59b6" },
  { lo: 300, hi: 409, color: "#e74c3c" },
  { lo: 410, hi: -1, color: "#f1c40f" },
];

/** Plate colour for a thickness (mm), matching the app's buckets. */
export function armorColor(mm: number): string {
  if (mm == null || mm <= 0) return "#3a4048";
  for (const b of ARMOR_BUCKETS) {
    if (b.hi < 0 ? mm >= b.lo : mm >= b.lo && mm <= b.hi) return b.color;
  }
  return "#3a4048";
}

export interface ArmorSceneSpec {
  /** Ship hull extents in stage space (bow = +maxZ). */
  sternZ: number;
  bowZ: number;
  hullXMin: number;
  hullXMax: number;
  hullYMin: number;
  hullYMax: number;
  /** Section splits along the length (0 = stern → 1 = bow), same as the app. */
  b2mR: number;
  m2sR: number;
}

export interface FadeTarget {
  mat: THREE.Material;
  /** Full-opacity target, driven by armorMix. */
  base: number;
}

/** Plate thickness as a fraction of hull beam — thick enough to read as
 *  solid armour blocks from the side (the game's armour viewer shows
 *  chunky plates, not paper-thin shells). */
const PLATE_THICKNESS_RATIO = 0.07;

/**
 * Build the armor-viewer scene: thin coloured plates + edge outlines.
 * Returns the group and per-material fade targets so the caller can
 * crossfade it with the hologram via a single 0..1 mix value.
 */
export function buildArmorPlates(
  spec: ArmorSceneSpec,
  zones: ArmorZone[],
): { group: THREE.Group; fades: FadeTarget[] } {
  const group = new THREE.Group();
  group.name = "armor-overlay";
  group.renderOrder = 2;
  const fades: FadeTarget[] = [];

  const hullZLen = spec.bowZ - spec.sternZ;
  const hullXLen = spec.hullXMax - spec.hullXMin;
  const hullXCtr = (spec.hullXMin + spec.hullXMax) * 0.5;
  const hullYLen = spec.hullYMax - spec.hullYMin;
  const plateT = Math.max(0.02, hullXLen * PLATE_THICKNESS_RATIO);

  const byName = new Map<string, number>();
  for (const z of zones) byName.set(z.name, z.thickness);

  // zr: 0 → stern, 1 → bow (same convention as the app).
  function zRel(zr: [number, number]): [number, number] {
    return [spec.sternZ + hullZLen * zr[0], spec.sternZ + hullZLen * zr[1]];
  }
  function xRel(xr: [number, number]): [number, number] {
    const half = hullXLen * 0.5;
    return [hullXCtr + half * xr[0], hullXCtr + half * xr[1]];
  }
  function yRel(yr: [number, number]): [number, number] {
    return [spec.hullYMin + hullYLen * yr[0], spec.hullYMin + hullYLen * yr[1]];
  }

  const b2mR = spec.b2mR;
  const m2sR = spec.m2sR;

  /** Solid zone box (thick block, e.g. citadel/magazine region). */
  function add(zoneName: string, zr: [number, number], yr: [number, number], xr: [number, number], baseOp: number) {
    const [z1, z2] = zRel(zr);
    const [y1, y2] = yRel(yr);
    const [x1, x2] = xRel(xr);
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    if (dx <= 0 || dy <= 0 || dz <= 0) return;
    const mm = byName.get(zoneName) ?? 0;
    const color = armorColor(mm);
    const geo = new THREE.BoxGeometry(dx, dy, dz);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    const box = new THREE.Mesh(geo, mat);
    box.position.set(x1 + dx / 2, y1 + dy / 2, z1 + dz / 2);
    box.userData = { zone: zoneName, thickness: mm };
    group.add(box);
    const edge = new THREE.EdgesGeometry(geo);
    const line = new THREE.LineSegments(
      edge,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthTest: false }),
    );
    line.raycast = () => {};
    box.add(line);
    fades.push({ mat, base: baseOp });
    fades.push({ mat: (line.material as THREE.Material), base: 0.55 });
  }

  /** Thin shell plate with edge outline (the app's addPlate). */
  function addPlate(zoneName: string, width: number, height: number, depth: number, cx: number, cy: number, cz: number, rotY: number, baseOp: number) {
    const mm = byName.get(zoneName) ?? 0;
    const color = armorColor(mm);
    const geo = new THREE.BoxGeometry(width, height, depth);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    });
    const box = new THREE.Mesh(geo, mat);
    box.position.set(cx, cy, cz);
    box.rotation.y = rotY;
    box.userData = { zone: zoneName, thickness: mm };
    group.add(box);
    const edge = new THREE.EdgesGeometry(geo);
    const line = new THREE.LineSegments(
      edge,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthTest: false }),
    );
    line.raycast = () => {};
    box.add(line);
    fades.push({ mat, base: baseOp });
    fades.push({ mat: (line.material as THREE.Material), base: 0.55 });
  }

  /** Vertical belt run — port + starboard thin plates. */
  function addVerticalBelt(zoneName: string, zr: [number, number], yr: [number, number]) {
    const [z1, z2] = zRel(zr);
    const [y1, y2] = yRel(yr);
    const dz = z2 - z1, dy = y2 - y1;
    if (dz <= 0 || dy <= 0) return;
    const cy = (y1 + y2) * 0.5;
    const cz = (z1 + z2) * 0.5;
    const half = hullXLen * 0.5;
    const portX = hullXCtr - half * 0.85;
    const stbdX = hullXCtr + half * 0.85;
    addPlate(zoneName, plateT, dy, dz, portX, cy, cz, 0, 0.35);
    addPlate(zoneName, plateT, dy, dz, stbdX, cy, cz, 0, 0.35);
  }

  /** Horizontal deck band plate. */
  function addHorizontal(zoneName: string, zr: [number, number], xr: [number, number]) {
    const [z1, z2] = zRel(zr);
    const [x1, x2] = xRel(xr);
    const dz = z2 - z1, dx = x2 - x1;
    if (dz <= 0 || dx <= 0) return;
    const cy = spec.hullYMin + hullYLen * 0.48;
    const cz = (z1 + z2) * 0.5;
    const cx = (x1 + x2) * 0.5;
    addPlate(zoneName, dx, plateT, dz, cx, cy, cz, 0, 0.35);
  }

  const GAP = 0.4;
  const m0 = b2mR, m1 = m2sR;
  const THIRD = (m1 - m0) / 3;
  const bLen = 1.0 - m1;

  // Stern solid blocks
  add("stern", [0.00, b2mR], [0.00, 0.40], [-1.0, 1.0], 0.28);
  add("sternBelt", [0.00, b2mR - GAP], [0.04, 0.30], [-1.0, 1.0], 0.28);
  // Stern belts
  addVerticalBelt("stern", [0.00, b2mR], [0.00, 0.40]);
  // Midsection belts
  addVerticalBelt("forwardBelt", [m0, m0 + THIRD - GAP], [0.04, 0.38]);
  addVerticalBelt("mainBelt", [m0 + THIRD, m1 - THIRD], [0.04, 0.38]);
  addVerticalBelt("aftBelt", [m1 - THIRD + GAP, m1], [0.04, 0.38]);
  addVerticalBelt("casemate", [m0, m1], [0.36, 0.50]);
  // Citadel: 4 thin walls (not a solid block)
  const citZr: [number, number] = [m0 + THIRD * 0.5, m1 - THIRD * 0.5];
  const citYr: [number, number] = [0.02, 0.34];
  {
    const [z1, z2] = zRel(citZr);
    const [y1, y2] = yRel(citYr);
    const cy = (y1 + y2) * 0.5;
    const cz = (z1 + z2) * 0.5;
    const dy = y2 - y1, dz = z2 - z1;
    const half = hullXLen * 0.5;
    addPlate("citadel", plateT, dy, dz, hullXCtr - half * 0.28, cy, cz, 0, 0.35);
    addPlate("citadel", plateT, dy, dz, hullXCtr + half * 0.28, cy, cz, 0, 0.35);
    addPlate("citadel", dz, dy, plateT, hullXCtr, cy, z1, Math.PI / 2, 0.35);
    addPlate("citadel", dz, dy, plateT, hullXCtr, cy, z2, Math.PI / 2, 0.35);
  }
  addHorizontal("deck", [m0, m1], [-0.55, 0.55]);
  // Torpedo belt — low vertical plates
  addVerticalBelt("torpedoBelt", [m0, m1], [0.00, 0.14]);
  // Bow
  addVerticalBelt("bow", [m1, 1.00], [0.00, 0.40]);
  addVerticalBelt("bowBelt", [m1 + bLen * 0.15, 1.00], [0.04, 0.30]);
  // Superstructure
  addHorizontal("superstructure", [m0 + 0.02, m1 - 0.02], [-0.20, 0.20]);

  return { group, fades };
}
