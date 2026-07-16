/**
 * Holographic contour shader for map terrain. Extends the plain holo shader
 * (`holoShader.ts`) with elevation-based contour bands so the height-field
 * terrain mesh reads as a topographic / bathymetric map:
 *
 *   - Land (y > 0): cyan contours every `contourInterval` metres, brightening
 *     with height.
 *   - Shallow sea (trenchDepth < y < 0): teal, denser contour bands.
 *   - Deep sea / trenches (y <= trenchDepth): deep blue, brightest bands —
 *     these are the submarine operating depths the map must surface.
 *
 * Contour lines are drawn via `fract(y / interval)` smoothed with `fwidth`,
 * giving crisp bands that adapt to viewing distance (screen-space derivatives,
 * same trick the ship shader uses for face normals). A slow scanline sweep +
 * fresnel keep the holographic feel consistent with the ship viewer.
 *
 * Used by `HolographicMap` for the `Terrain` mesh of a converted map GLB.
 */
import * as THREE from "three";

import { tickHoloUniforms, type HoloUniforms } from "./holoShader";

/** Reuse the plain holo shader's vertex stage (it provides vWorldPos/vLocalPos). */
import { HOLO_VERT } from "./holoShader";

export const HOLO_CONTOUR_FRAG = /* glsl */ `
  precision highp float;
  uniform float time;
  uniform float scanOffset;
  uniform vec3 baseColor;
  uniform vec3 fresnelColor;
  uniform float contourInterval;   // metres between contour lines
  uniform float seaLevel;          // y of the water surface (0)
  uniform float trenchDepth;       // y below which "deep sea / trench" styling kicks in
  varying vec3 vWorldPos;
  varying vec3 vViewPos;
  varying vec3 vLocalPos;

  // Draw a contour line at a given absolute height 'h' using the fragment's
  // world Y. Returns line intensity 0..1; 'fwidth' adapts line width to the
  // on-screen derivative so distant terrain stays readable without aliasing.
  float contourLine(float h) {
    float d = fwidth(vWorldPos.y) * 1.5;          // line width in world units
    return 1.0 - smoothstep(0.0, d, abs(vWorldPos.y - h));
  }

  void main() {
    // Face normal from screen-space derivatives (baked GLBs have no normals).
    vec3 dx = dFdx(vWorldPos);
    vec3 dy = dFdy(vWorldPos);
    vec3 n = normalize(cross(dx, dy));
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 2.5);

    float y = vWorldPos.y;
    bool isLand = y > seaLevel;
    bool isDeep = y <= trenchDepth;

    // ── Base tint by zone ────────────────────────────────────────────────
    vec3 col;
    if (isLand) {
      // Land: cyan, brightening with height.
      float t = clamp(y / 40.0, 0.0, 1.0);
      col = mix(baseColor * 0.5, fresnelColor * 0.9, t);
    } else if (isDeep) {
      // Deep sea / trenches: deep blue, brightest in the troughs.
      float depth = clamp((-y) / 30.0, 0.0, 1.0);
      col = mix(vec3(0.04, 0.10, 0.22), vec3(0.10, 0.32, 0.55), 1.0 - depth);
    } else {
      // Shallow sea: teal.
      float depth = clamp((-y) / (-trenchDepth + 0.001), 0.0, 1.0);
      col = mix(vec3(0.05, 0.22, 0.30), vec3(0.08, 0.40, 0.52), depth);
    }

    // ── Contour bands ────────────────────────────────────────────────────
    // Stacked lines every contourInterval metres, centred on multiples.
    float interval = max(contourInterval, 0.5);
    float band = fract((y - seaLevel) / interval);
    float lineW = fwidth((y - seaLevel) / interval) * 0.7;
    float major = 1.0 - smoothstep(0.0, lineW, abs(band - 0.5));
    // Every 5th band is a bolder "index" contour.
    float idx = step(0.5, fract((y - seaLevel) / (interval * 5.0)));
    float contour = max(major * 0.6, idx * major);

    col += fresnelColor * contour * (isLand ? 1.1 : 0.8);

    // ── Scanline sweep + fresnel (matches the ship hologram) ─────────────
    float scan = sin((vLocalPos.y * 0.08 + scanOffset) * 6.2831) * 0.5 + 0.5;
    scan = smoothstep(0.82, 1.0, scan);
    col += fresnelColor * scan * 0.4;
    col += fresnelColor * fres * 1.1;

    float alpha = 0.62 + 0.30 * fres + contour * 0.15;
    gl_FragColor = vec4(col, alpha);
  }
`;

/** Contour shader uniforms (extends the plain holo uniforms with terrain ones). */
export interface ContourUniforms extends HoloUniforms {
  contourInterval: { value: number };
  seaLevel: { value: number };
  trenchDepth: { value: number };
}

/** Create a holographic contour ShaderMaterial for a terrain mesh.
 *  Returns the material; uniforms are reachable via `mat.uniforms`. */
export function makeHoloContourMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      scanOffset: { value: 0 },
      baseColor: { value: new THREE.Color(0x0d6e8a) },
      fresnelColor: { value: new THREE.Color(0x33ccff) },
      contourInterval: { value: 5 },  // 5 m between contour lines
      seaLevel: { value: 0 },
      trenchDepth: { value: -8 },     // below -8 m → deep-sea styling
    },
    vertexShader: HOLO_VERT,
    fragmentShader: HOLO_CONTOUR_FRAG,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

/** Advance the shared scanline animation. Same contract as `tickHoloUniforms`
 *  — contour materials carry the same time/scanOffset uniforms. */
export { tickHoloUniforms };
