/**
 * Holographic shaders for the site's live-replay renderer — ported from the
 * app's `features/holographic/` (holoShader + holoContourShader) so the
 * homepage shows the SAME look the desktop app produces.
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
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;

  vec3 faceNormal() {
    vec3 dx = dFdx(vWorldPos);
    vec3 dy = dFdy(vWorldPos);
    return normalize(cross(dx, dy));
  }

  float fresnel(vec3 n) {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    return pow(1.0 - max(dot(n, viewDir), 0.0), 2.5);
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

  void main() {
    vec3 n = faceNormal();
    float fres = fresnel(n);
    float scan = scanline();
    vec3 col = baseColor * (0.62 + 0.30 * fres);
    col += fresnelColor * fres * 1.4;
    col += fresnelColor * scan * 0.6;
    float alpha = 0.95 + 0.05 * fres;
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
