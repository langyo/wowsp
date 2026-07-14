/**
 * Shared holographic shader — the cyan scanline + fresnel material used by the
 * ship viewer (`ShipStage`) and the replay's recorder-ship panel
 * (`ReplayShipStage`). Extracted here so both surfaces share one look.
 *
 * The baked GLBs ship without normals (they're merged + stripped during
 * baking), so the fragment shader derives face normals from screen-space
 * derivatives (dFdx/dFdy — WebGL2 default in three r150+). Fresnel uses that
 * normal vs. the view direction. Scanlines sweep vertically over time; a
 * separate wireframe overlay mesh is drawn by the caller.
 *
 * Usage:
 *   const mat = makeHoloMaterial();          // a ShaderMaterial (transparent)
 *   tickHoloUniforms(mat.uniforms, dt);      // drive it each frame
 * Both the material and its uniforms object are owned by the caller; dispose
 * the material when the mesh leaves the scene.
 */
import * as THREE from "three";

/** Uniforms object shape for the holographic ShaderMaterial. */
export interface HoloUniforms {
  time: { value: number };
  scanOffset: { value: number };
  baseColor: { value: THREE.Color };
  fresnelColor: { value: THREE.Color };
}

export const HOLO_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vViewPos;
  varying vec3 vLocalPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vLocalPos = position;
    vec4 vp = viewMatrix * wp;
    vViewPos = vp.xyz;
    gl_Position = projectionMatrix * vp;
  }
`;

export const HOLO_FRAG = /* glsl */ `
  precision highp float;
  uniform float time;
  uniform float scanOffset;
  uniform vec3 baseColor;
  uniform vec3 fresnelColor;
  varying vec3 vWorldPos;
  varying vec3 vViewPos;
  varying vec3 vLocalPos;
  void main() {
    // Face normal from screen-space derivatives of the world position.
    vec3 dx = dFdx(vWorldPos);
    vec3 dy = dFdy(vWorldPos);
    vec3 n = normalize(cross(dx, dy));
    // View direction (from fragment to camera, in world space).
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    // Fresnel: bright at glancing angles.
    float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 2.5);
    // Scanlines along the model's vertical (Y) axis, sweeping over time.
    float scan = sin((vLocalPos.y * 0.08 + scanOffset) * 6.2831) * 0.5 + 0.5;
    scan = smoothstep(0.82, 1.0, scan);
    vec3 col = baseColor * (0.35 + 0.25 * fres);
    col += fresnelColor * fres * 1.4;
    col += fresnelColor * scan * 0.6;
    float alpha = 0.72 + 0.28 * fres;
    gl_FragColor = vec4(col, alpha);
  }
`;

/** Create a fresh holographic ShaderMaterial with its own uniforms object.
 *  Returns the material; the uniforms are reachable via `mat.uniforms`. */
export function makeHoloMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      scanOffset: { value: 0 },
      baseColor: { value: new THREE.Color(0x0d6e8a) },
      fresnelColor: { value: new THREE.Color(0x33ccff) },
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
