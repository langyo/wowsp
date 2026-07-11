// WoWSP holographic fragment shader — placeholder scanline + tint pass.
// TODO(M4): full holographic map material (depth-based glow, ship markers).
precision mediump float;

varying vec2 vUv;
uniform float uTime;
uniform vec3 uTint;

void main() {
  vec2 uv = vUv;
  // Subtle horizontal scanline drift.
  float scan = 0.5 + 0.5 * sin((uv.y * 220.0) + uTime * 2.0);
  scan = mix(0.85, 1.0, scan);
  // Radial vignette.
  float vig = smoothstep(0.9, 0.2, distance(uv, vec2(0.5)));
  vec3 col = uTint * scan * vig;
  gl_FragColor = vec4(col, vig * 0.55);
}
