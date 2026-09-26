/**
 * Class-scaled hull outline marker for the 3D scene, extracted verbatim from
 * HolographicMap.tsx: a pointed-bow LINE LOOP laid out on XZ, used both as
 * the live ship outline (child of the marker) and the "last known position"
 * ghost. Pure three.js construction — no scene or reactive state; the caller
 * positions/rotates the returned object.
 */
import * as THREE from "three";
import { SHIP_CLASS_LEN } from "./shipMarker";

/** Class hull lengths for the 3D outline markers — the SAME true-scale
 *  table the ship GLBs are scaled to (SHIP_CLASS_LEN in @wowsp/holo,
 *  ≈ 4.5 m per world unit), so outline and installed model always agree. */
const HULL_LEN: Record<string, number> = SHIP_CLASS_LEN;

/** Build a ship-shaped LINE LOOP for the 3D scene: a pointed bow,
 *  parallel midbody and tapered stern, laid out on XZ with the bow along
 *  +Z (matching the marker cone / model convention). Doubles as the
 *  live outline (child of the marker, follows position + yaw) and the
 *  "last known position" ghost. */
export function makeHullOutline(
  color: number,
  type: string | null | undefined,
  scale = 1,
): THREE.LineLoop {
  const t = (type ?? "").toLowerCase();
  const len =
    (HULL_LEN[
      Object.keys(HULL_LEN).find((k) => t.includes(k)) ?? "cruiser"
    ] ?? HULL_LEN.cruiser) * scale;
  const beam = len * 0.24;
  // (x, z) around the hull, bow at +Z.
  const pts: [number, number][] = [
    [0, 0.5],
    [0.5, 0.3],
    [0.5, 0.0],
    [0.42, -0.36],
    [0, -0.5],
    [-0.42, -0.36],
    [-0.5, 0.0],
    [-0.5, 0.3],
  ];
  const arr = new Float32Array(pts.length * 3);
  pts.forEach(([px, pz], i) => {
    arr[i * 3] = px * beam;
    arr[i * 3 + 1] = 0.6;
    arr[i * 3 + 2] = pz * len;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  geo.computeBoundingSphere();
  return new THREE.LineLoop(
    geo,
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    }),
  );
}
