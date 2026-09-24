/**
 * Shared holographic shader — the cyan scanline + fresnel material used by the
 * ship viewer (`ShipStage`) and the replay's recorder-ship panel
 * (`ReplayShipStage`). Extracted here so both surfaces share one look.
 *
 * Normals: baked GLBs ship without normals (merged + stripped during baking),
 * so callers that want smooth shading add crease-aware vertex normals first
 * (`computeSmoothNormals` — the hulls are coarse meshes whose vertices sit on
 * hard chines, so plain averaging shades as shards). When the `normal`
 * attribute is missing it reads as (0,0,0) and the fragment shader falls back
 * to face normals from screen-space derivatives (dFdx/dFdy — WebGL2 default in
 * three r150+), as the replay's markers still do. Fresnel uses the normal vs.
 * the view direction; both paths orient it by dot(n, viewDir) instead of
 * gl_FrontFacing, whose winding test is unreliable on the baked hulls.
 * Scanlines sweep vertically over time; a separate wireframe overlay mesh is
 * drawn by the caller.
 *
 * Definition layer: the ship stage enables two extra terms that give large
 * panels surface reading (a flat pastel fill with nothing between the
 * silhouette and the rim reads as porridge on a broadside hull):
 *   - `uLightGain` — a soft headlight (dot of the smooth normal with the view
 *     direction, eased, multiplicative) so curvature and creases modulate the
 *     fill instead of every facing fragment getting the same colour. Gated on
 *     `vHasNormal`: markers and terrain build on normal-less geometry and
 *     keep the flat look (their uniforms stay at the 0 defaults).
 *   - `uLinesGain` — a faint world-space measuring grid (10-unit pitch,
 *     fwidth-antialiased) so a broadside slab shows panel-scale structure
 *     without a per-triangle wireframe. World space because the bake's local
 *     units differ per ship while the stage normalizes every model to the
 *     same 200-unit box.
 * Both default to 0 — `makeHoloMaterial()` alone reproduces the legacy look.
 *
 * Usage:
 *   const mat = makeHoloMaterial();          // a ShaderMaterial (transparent)
 *   tickHoloUniforms(mat.uniforms, dt);      // drive it each frame
 * Both the material and its uniforms object are owned by the caller; dispose
 * the material when the mesh leaves the scene.
 *
 * The material writes no depth (transparent layering), so for correct
 * occlusion the caller should add a depth-only twin of each mesh that shares
 * the SAME vertex shader (makeHoloDepthMaterial — renders in the opaque queue
 * ahead of this transparent pass). The twin must transform vertices through
 * the identical GLSL path: a different vertex pipeline (e.g. a
 * MeshBasicMaterial's CPU-premultiplied modelViewMatrix) rounds depth
 * differently and the depth test then rejects arbitrary whole triangles.
 * See ShipStage.loadModel.
 */
import * as THREE from "three";

/** Uniforms object shape for the holographic ShaderMaterial. */
export interface HoloUniforms {
  time: { value: number };
  scanOffset: { value: number };
  baseColor: { value: THREE.Color };
  fresnelColor: { value: THREE.Color };
  focusPoints: { value: THREE.Vector3[] };
  focusCount: { value: number };
  focusRadius: { value: number };
  focusBoost: { value: number };
  /** Multiplier for the output alpha — ghosts (unseen/spawned/ sunk ships)
   *  render at a fraction of the normal opacity. */
  ghostAlpha: { value: number };
  /** Headlight gain — 0 keeps the flat legacy fill (markers, terrain). */
  uLightGain: { value: number };
  /** Measuring-grid gain — 0 draws no grid. */
  uLinesGain: { value: number };
}

export const HOLO_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vViewPos;
  varying vec3 vLocalPos;
  varying vec3 vNormal;
  varying float vHasNormal;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vLocalPos = position;
    vec4 vp = viewMatrix * wp;
    vViewPos = vp.xyz;
    gl_Position = projectionMatrix * vp;
    // World-space smooth normal. Assumes UNIFORM node scale (everything here
    // scales via setScalar; a non-uniform scale would need the inverse
    // transpose). Geometries without a normal attribute bind a constant
    // (0,0,0) — flagged via vHasNormal so the fragment shader can fall back
    // to derivative face normals.
    vNormal = normalize(mat3(modelMatrix) * normal);
    vHasNormal = step(0.001, length(normal));
  }
`;

export const HOLO_FRAG = /* glsl */ `
  precision highp float;
  uniform float time;
  uniform float scanOffset;
  uniform vec3 baseColor;
  uniform vec3 fresnelColor;
  uniform vec3 focusPoints[8];
  uniform float focusCount;
  uniform float focusRadius;
  uniform float focusBoost;
  uniform float ghostAlpha;
  uniform float uLightGain;
  uniform float uLinesGain;
  varying vec3 vWorldPos;
  varying vec3 vViewPos;
  varying vec3 vLocalPos;
  varying vec3 vNormal;
  varying float vHasNormal;
  void main() {
    vec3 n;
    if (vHasNormal > 0.5) {
      n = normalize(vNormal);
    } else {
      vec3 dx = dFdx(vWorldPos);
      vec3 dy = dFdy(vWorldPos);
      n = normalize(cross(dx, dy));
    }
    // Orient the normal toward the viewer by the geometric test, NOT by
    // gl_FrontFacing: the baked hull is a coarse mesh of LARGE flat plates, and
    // at a low camera its side plates sit at grazing incidence where a winding
    // test flips whole plates at a time — the hull then reads as a mosaic of
    // wedge patches that crawls as the camera moves. dot(n, viewDir) comes from
    // the (smooth) normal, so it varies continuously across a plate and is
    // independent of the exporter's triangle winding.
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float facing = dot(n, viewDir);
    if (facing < 0.0) n = -n;
    float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 2.5);
    float scan = sin((vLocalPos.y * 0.08 + scanOffset) * 6.2831) * 0.5 + 0.5;
    scan = smoothstep(0.82, 1.0, scan);
    vec3 col = baseColor * (0.75 + 0.45 * fres);
    col += fresnelColor * fres * 1.2;
    col += fresnelColor * scan * 0.5;
    // Headlight: ease the facing ratio so only surfaces square to the camera
    // lift, while grazing panels stay dark toward the rim. Multiplicative —
    // the hue stays the category's own instead of washing toward white.
    if (uLightGain > 0.0 && vHasNormal > 0.5) {
      float def = dot(n, viewDir);
      col *= 1.0 + uLightGain * def * def;
    }
    // Measuring grid, one line every 10 world units on each axis. Kept
    // faint: it must read as panel structure, not as a cage over the ship.
    if (uLinesGain > 0.0) {
      vec3 g = abs(fract(vWorldPos / 10.0 - 0.5) - 0.5) / fwidth(vWorldPos);
      float line = 1.0 - min(min(g.x, g.y), g.z);
      col += fresnelColor * clamp(line, 0.0, 1.0) * uLinesGain;
    }
    // No interior alpha fade: it would be another dot(n, viewDir) sign test at
    // the same grazing incidence the plate mosaic comes from. Occlusion is the
    // depth test's job (the stage writes depth); every fragment keeps one
    // opacity, and a back face simply fades out through the Fresnel term.
    float alpha = 0.72 + 0.28 * fres;
    // Focus highlight: brighten fragments near any focus point.
    for (int i = 0; i < 8; i++) {
      if (float(i) >= focusCount) break;
      float d = distance(vWorldPos, focusPoints[i]);
      if (d < focusRadius) {
        float w = 1.0 - d / focusRadius;
        w = w * w;
        alpha += w * focusBoost;
        col += fresnelColor * w * 0.6;
      }
    }
    gl_FragColor = vec4(col, alpha * ghostAlpha);
  }
`;

/** Depth-only twin of the holo material for occlusion pre-passes. Renders in
 *  the opaque queue (transparent: false) with colorWrite off, using the SAME
 *  vertex shader so rasterized depth matches the transparent pass. The tiny
 *  polygonOffset pushes the anchor ~1 depth LSB farther so depth-equal color
 *  fragments reliably survive the LessEqual test — separate GL programs may
 *  round gl_Position differently even with identical source, and without the
 *  bias arbitrary whole triangles get rejected ("half the hull missing").
 *  Real occlusion is unaffected at 1 LSB. */
export function makeHoloDepthMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: HOLO_VERT,
    fragmentShader: "void main() { gl_FragColor = vec4(0.0); }",
    side: THREE.DoubleSide,
    colorWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1.0,
    polygonOffsetUnits: 1.0,
  });
}

/** Create a fresh holographic ShaderMaterial with its own uniforms object.
 *  Returns the material; the uniforms are reachable via `mat.uniforms`. */
export function makeHoloMaterial(): THREE.ShaderMaterial {
  const fps: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) fps.push(new THREE.Vector3());
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      scanOffset: { value: 0 },
      baseColor: { value: new THREE.Color(0x0d6e8a) },
      fresnelColor: { value: new THREE.Color(0x33ccff) },
      focusPoints: { value: fps },
      focusCount: { value: 0 },
      focusRadius: { value: 30.0 },
      focusBoost: { value: 0.8 },
      ghostAlpha: { value: 1.0 },
      // Legacy look: both definition terms off. The ship stage turns them on
      // per material after loading a model.
      uLightGain: { value: 0.0 },
      uLinesGain: { value: 0.0 },
    },
    vertexShader: HOLO_VERT,
    fragmentShader: HOLO_FRAG,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

/** Advance the scanline/fresnel animation by `dt` seconds. Pass the material's
 *  `uniforms` (or a HoloUniforms object) each frame. */
export function tickHoloUniforms(
  uniforms: { time: { value: number }; scanOffset: { value: number } },
  dt: number,
): void {
  uniforms.time.value += dt;
  uniforms.scanOffset.value += dt * 0.6;
}
