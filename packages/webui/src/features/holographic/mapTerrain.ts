/**
 * Map terrain + water planes, extracted verbatim from HolographicMap.tsx:
 * the holo-styled terrain GLB loader (contour shader on the `Terrain`
 * nodes, wire overlay), the deep-sea floor + translucent surface planes
 * and their theme recolouring.
 */
import * as THREE from "three";
import { SCENE_THEMES, scenePalette } from "./useThreeScene";
import { makeHoloContourMaterial } from "./holoContourShader";
import { loadGlbModel, resolveMapModelUrl } from "./modelLoader";
import type { MapInternals } from "./mapInternals";

/** Remove a previously-loaded map terrain model. */
export function clearMapModel(ctx: MapInternals) {
  if (ctx.mapModel) {
    ctx.api.value?.scene.remove(ctx.mapModel);
    ctx.mapModel.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    ctx.mapModel = null;
  }
}

/** Deep-sea floor plane stretching far past the playable area. Without
 *  it the terrain mesh (bounded by the space's chunk rect) ends in a hard
 *  edge against the void, which reads as a bright square patch around the
 *  map's center. The plane sits just below the deepest seabed and uses
 *  the same deep-water color as the contour shader's trench zone, so the
 *  terrain edge blends into open sea instead of clipping. Opaque on
 *  purpose — no blend-order interaction with the transparent terrain. */
/** Water colours follow the app theme: deep-space navy in dark mode,
 *  soft paper-blue sea in light mode (same palette family as the scene
 *  background/grid — see useThreeScene.SCENE_THEMES). */
export function ensureWaterFloor(ctx: MapInternals) {
  const scene = ctx.api.value?.scene;
  if (!scene || ctx.waterFloor) return;
  const p = scenePalette();
  const mat = new THREE.MeshBasicMaterial({ color: p.bg === SCENE_THEMES.light.bg ? 0xd7e2ec : 0x05121f });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -40;
  mesh.renderOrder = -1;
  mesh.raycast = () => {}; // never intercept picks
  scene.add(mesh);
  ctx.waterFloor = mesh;
  // Translucent sea surface at y≈0: hides the seabed tint behind it and
  // lets islands poke through, while keeping ship wake depth readable.
  const seaMat = new THREE.MeshBasicMaterial({
    color: p.bg === SCENE_THEMES.light.bg ? 0xc2d5e4 : 0x071827,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000), seaMat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = 0.6;
  sea.renderOrder = 5;
  sea.raycast = () => {};
  scene.add(sea);
  ctx.seaSurface = sea;
}

/** Live theme switch: recolour the water planes already in the scene
 *  (scene background + grid are handled inside useThreeScene). */
export function reapplyWaterTheme(ctx: MapInternals) {

  const light = scenePalette() === SCENE_THEMES.light;
  if (ctx.waterFloor) {
    (ctx.waterFloor.material as THREE.MeshBasicMaterial).color.setHex(
      light ? 0xd7e2ec : 0x05121f,
    );
  }
  if (ctx.seaSurface) {
    (ctx.seaSurface.material as THREE.MeshBasicMaterial).color.setHex(
      light ? 0xc2d5e4 : 0x071827,
    );
  }
}

/** Attempt to load the terrain GLB for the current mapId and restyle it as
 *  a holographic island mesh (same cyan scanline/fresnel shader as the ship
 *  viewer). If no converted GLB exists, the scene keeps its GridHelper
 *  fallback. Contour-line terrain is a planned feature — for now the map is
 *  the low-poly island geometry in holo style. */
export async function tryLoadMapModel(ctx: MapInternals) {
  clearMapModel(ctx);
  const scene = ctx.api.value?.scene;
  if (!scene || !ctx.props.mapId) return;
  const url = resolveMapModelUrl(ctx.props.mapId);
  if (!url) return; // no converted model — use grid fallback
  try {
    const model = await loadGlbModel(url);
    // Baked GLBs drop POSITION accessor min/max — recompute per-geometry so
    // bounds-dependent logic (future fit/clip) still works.
    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry?.attributes.position) {
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
      }
    });
    // Restyle meshes by role. The converted map GLB is a multi-mesh file
    // whose nodes are named `Terrain` (the elevation height-field, incl.
    // sea-floor bathymetry/trenches) and `Islands` (simplified land). The
    // terrain gets the contour shader (topographic + bathymetric bands);
    // islands get the plain holographic shader. Both share the same
    // time/scanOffset uniforms so one onFrame tick animates everything.
    const contourMat = makeHoloContourMaterial();
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0x2a8fb5,
      wireframe: true,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
    });
    const meshes: THREE.Mesh[] = [];
    model.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
    });
    for (const mesh of meshes) {
      let isTerrain = mesh.name === "Terrain";
      let p: THREE.Object3D | null = mesh.parent;
      while (!isTerrain && p && p !== model) {
        if (p.name === "Terrain") isTerrain = true;
        p = p.parent;
      }
      if (isTerrain) {
        mesh.material = contourMat;
      } else {
        mesh.visible = false;
      }
      const wire = new THREE.Mesh(mesh.geometry, wireMat);
      wire.raycast = () => {}; // overlay shouldn't intercept picks
      mesh.add(wire);
    }
    ctx.mapModel = model;
    scene.add(model);
  } catch (e) {
    // Model load failed (corrupt GLB?) — silently fall back to grid.
    console.warn("[HolographicMap] map model load failed:", e);
  }
}
