/**
 * Holographic shaders for the site's live-replay renderer — ported from the
 * app's `features/holographic/` (holoShader + holoContourShader) so the
 * homepage shows the SAME look the desktop app produces.
 *
 * The glass/scanline layer (fine screen rows, climbing sweep band, flicker,
 * translucent fill, raised rim exponent) is opt-in: `makeShipHoloMaterial()`
 * alone reproduces the legacy look and the replay ships keep it — only
 * `shipStage`'s turntable sets the gains, mirroring the app's ship stage.
 */
import * as THREE from "three";

export const HOLO_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vLocalPos = position;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const HOLO_COMMON = /* glsl */ `
  uniform float time;
  uniform float scanOffset;
  uniform vec3 baseColor;
  uniform vec3 fresnelColor;
  uniform float ghostAlpha;
  uniform float uFresnelPow;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;

  vec3 faceNormal() {
    vec3 dx = dFdx(vWorldPos);
    vec3 dy = dFdy(vWorldPos);
    return normalize(cross(dx, dy));
  }

  float fresnel(vec3 n) {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    return pow(1.0 - max(dot(n, viewDir), 0.0), uFresnelPow);
  }

  float scanline() {
    float s = sin((vLocalPos.y * 0.08 + scanOffset) * 6.2831) * 0.5 + 0.5;
    return smoothstep(0.82, 1.0, s);
  }
`;

export const SHIP_FRAG = /* glsl */ `
  precision highp float;
  ${HOLO_COMMON}
  uniform vec3 focusPoints[8];
  uniform float focusCount;
  uniform float focusRadius;
  uniform float focusBoost;
  uniform vec3 focusColor;
  // Glass/scanline layer — the homepage turntable opts in; every default
  // reproduces the legacy look (see makeShipHoloMaterial).
  uniform float uFresnelGain;
  uniform float uBaseAlpha;
  uniform float uRimAlpha;
  uniform float uScanGain;
  uniform float uSweepGain;
  uniform float uFlickerGain;
  uniform float uSweepLo;
  uniform float uSweepHi;

  void main() {
    vec3 n = faceNormal();
    float fres = fresnel(n);
    float scan = scanline();
    vec3 col = baseColor * (0.62 + 0.30 * fres);
    col += fresnelColor * fres * uFresnelGain;
    col += fresnelColor * scan * 0.6;
    // Fine CRT rows in screen space (constant pitch at any zoom) and a soft
    // gaussian band climbing the world-space Y between uSweepLo and uSweepHi
    // — the same two motions the desktop ship stage runs. The sweep range is
    // a uniform because site scenes differ in scale: the turntable works in
    // ~10-unit hulls while the replay map sits in engine units.
    float sweep = 0.0;
    if (uScanGain > 0.0 || uSweepGain > 0.0) {
      float row = sin(gl_FragCoord.y * 1.7 - time * 3.0);
      col += fresnelColor * smoothstep(0.55, 0.98, row) * uScanGain * 0.30;
      if (uSweepGain > 0.0) {
        float yBand = mix(uSweepLo, uSweepHi, fract(time * 0.13));
        float sigma = max((uSweepHi - uSweepLo) / 16.0, 1e-4);
        float d = (vWorldPos.y - yBand) / sigma;
        sweep = exp(-d * d);
        col += fresnelColor * sweep * uSweepGain;
      }
    }
    // Faint projector flicker — two incommensurate sines, single digits of
    // gain so it reads as transmission, not as a rendering bug.
    if (uFlickerGain > 0.0) {
      col *= 1.0 + uFlickerGain * sin(time * 23.0) * sin(time * 7.3);
    }
    // uBaseAlpha/uRimAlpha split the legacy 0.95 + 0.05 * fres so a host can
    // trade fill opacity for rim glow (the glassier hologram) without
    // touching the shader. The sweep adds a little density as it passes.
    float alpha = min(uBaseAlpha + uRimAlpha * fres + sweep * uSweepGain * 0.20, 1.0);
    // Focus highlight (subtle tint — marks the part without painting it).
    for (int i = 0; i < 8; i++) {
      if (float(i) >= focusCount) break;
      float d = distance(vWorldPos, focusPoints[i]);
      if (d < focusRadius) {
        float w = 1.0 - d / focusRadius;
        w = w * w;
        alpha += w * focusBoost;
        col += focusColor * w * 0.35;
      }
    }
    gl_FragColor = vec4(col, alpha * ghostAlpha);
  }
`;

export const TERRAIN_FRAG = /* glsl */ `
  precision highp float;
  ${HOLO_COMMON}
  uniform float contourInterval;
  uniform float seaLevel;
  uniform float trenchDepth;
  void main() {
    vec3 n = faceNormal();
    float fres = fresnel(n);
    float y = vWorldPos.y;
    bool isLand = y > seaLevel;
    bool isDeep = y <= trenchDepth;

    vec3 col;
    if (isLand) {
      float t = clamp(y / 40.0, 0.0, 1.0);
      col = mix(baseColor * 0.5, fresnelColor * 0.9, t);
    } else if (isDeep) {
      float depth = clamp((-y) / 30.0, 0.0, 1.0);
      col = mix(vec3(0.010, 0.022, 0.038), vec3(0.022, 0.050, 0.080), 1.0 - depth);
    } else {
      float depth = clamp((-y) / (-trenchDepth + 0.001), 0.0, 1.0);
      col = mix(vec3(0.014, 0.035, 0.045), vec3(0.022, 0.060, 0.075), depth);
    }

    float interval = max(contourInterval, 0.5);
    float band = fract((y - seaLevel) / interval);
    float lineW = fwidth((y - seaLevel) / interval) * 0.7;
    float major = 1.0 - smoothstep(0.0, lineW, abs(band - 0.5));
    float idx = step(0.5, fract((y - seaLevel) / (interval * 5.0)));
    float contour = max(major * 0.6, idx * major);
    col += fresnelColor * contour * (isLand ? 1.1 : 0.18);

    float scan = scanline();
    col += fresnelColor * scan * (isLand ? 0.4 : 0.12);
    col += fresnelColor * fres * (isLand ? 1.1 : 0.25);

    float alpha = isLand ? (0.42 + 0.20 * fres + contour * 0.08) : 0.20;
    gl_FragColor = vec4(col, alpha);
  }
`;

export interface HoloUniforms {
  time: { value: number };
  scanOffset: { value: number };
  baseColor: { value: THREE.Color };
  fresnelColor: { value: THREE.Color };
  ghostAlpha: { value: number };
  [k: string]: { value: unknown };
}

/** Depth-only twin of the ship holo material (occlusion pre-pass). Same
 *  contract as the app's `makeHoloDepthMaterial`: opaque queue, colorWrite
 *  off, same vertex shader so rasterized depth matches the transparent pass;
 *  the polygonOffset pushes it ~1 depth LSB farther so depth-equal colour
 *  fragments survive. Without it a translucent hull paints its own far side
 *  over the near shell ("x-ray ghosting"). */
export function makeShipHoloDepthMaterial(): THREE.ShaderMaterial {
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

export function makeShipHoloMaterial(): THREE.ShaderMaterial {
  const fps: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) fps.push(new THREE.Vector3());
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      scanOffset: { value: 0 },
      baseColor: { value: new THREE.Color(0x0d6e8a) },
      fresnelColor: { value: new THREE.Color(0x33ccff) },
      ghostAlpha: { value: 1 },
      focusPoints: { value: fps },
      focusCount: { value: 0 },
      focusRadius: { value: 2.6 },
      focusBoost: { value: 0 },
      focusColor: { value: new THREE.Color(0x33ccff) },
      // Legacy look: the alpha split at the historical constants, the rim at
      // the old exponent/gain, every texture term off. The homepage
      // turntable opts in after loading a model; replay ships keep these.
      uFresnelPow: { value: 2.5 },
      uFresnelGain: { value: 1.4 },
      uBaseAlpha: { value: 0.95 },
      uRimAlpha: { value: 0.05 },
      uScanGain: { value: 0.0 },
      uSweepGain: { value: 0.0 },
      uFlickerGain: { value: 0.0 },
      uSweepLo: { value: 0.0 },
      uSweepHi: { value: 0.0 },
    },
    vertexShader: HOLO_VERT,
    fragmentShader: SHIP_FRAG,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

export function makeTerrainHoloMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      scanOffset: { value: 0 },
      baseColor: { value: new THREE.Color(0x0d6e8a) },
      fresnelColor: { value: new THREE.Color(0x33ccff) },
      ghostAlpha: { value: 1 },
      // Legacy rim exponent/gain; the terrain frag carries its own hardcoded
      // gain multipliers and never reads uFresnelGain.
      uFresnelPow: { value: 2.5 },
      uFresnelGain: { value: 1.4 },
      contourInterval: { value: 5 },
      seaLevel: { value: 0 },
      trenchDepth: { value: -8 },
    },
    vertexShader: HOLO_VERT,
    fragmentShader: TERRAIN_FRAG,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

export function tickHolo(mat: THREE.ShaderMaterial, dt: number): void {
  (mat.uniforms.time as { value: number }).value += dt;
  (mat.uniforms.scanOffset as { value: number }).value += dt * 0.6;
}
