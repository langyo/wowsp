/** Tests for the shared holographic ShaderMaterial. GLSL compiles only on the
 *  GPU at draw time, so a uniform declared in a shader stage but missing from
 *  the material's uniforms object fails silently (the constant reads as 0) —
 *  the declaration/uniforms lockstep check below catches it in vitest
 *  instead. The defaults test pins the legacy look that replay markers and
 *  terrain rely on: stage-only gains at 0, the historical alpha split. */
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { HOLO_FRAG, HOLO_VERT, makeHoloMaterial, tickHoloUniforms } from "./holoShader";

/** Every `uniform <type> <name>;` declared in a shader stage source, array
 *  suffixes included (`uniform vec3 focusPoints[8];`). */
function declaredUniforms(src: string): string[] {
  return [...src.matchAll(/uniform\s+\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/g)].map((m) => m[1]);
}

describe("holoShader", () => {
  it("declares a uniforms entry for every stage uniform", () => {
    const mat = makeHoloMaterial();
    for (const name of [...declaredUniforms(HOLO_VERT), ...declaredUniforms(HOLO_FRAG)]) {
      expect(mat.uniforms, `uniform missing from makeHoloMaterial(): ${name}`)
        .toHaveProperty(name);
    }
  });

  it("ships the entry arrays the focus loop indexes", () => {
    const mat = makeHoloMaterial();
    expect(mat.uniforms.focusPoints.value).toHaveLength(8);
    for (const v of mat.uniforms.focusPoints.value as THREE.Vector3[]) {
      expect(v).toBeInstanceOf(THREE.Vector3);
    }
  });

  it("keeps makeHoloMaterial() at the legacy look by default", () => {
    const mat = makeHoloMaterial();
    expect(mat.uniforms.uBaseAlpha.value).toBeCloseTo(0.72);
    expect(mat.uniforms.uRimAlpha.value).toBeCloseTo(0.28);
    expect(mat.uniforms.uScanGain.value).toBe(0);
    expect(mat.uniforms.uSweepGain.value).toBe(0);
    expect(mat.uniforms.uFlickerGain.value).toBe(0);
    expect(mat.uniforms.uFresnelPow.value).toBeCloseTo(2.5);
    expect(mat.uniforms.uFresnelGain.value).toBeCloseTo(1.2);
    expect(mat.uniforms.ghostAlpha.value).toBe(1);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
  });

  it("advances time and scanOffset per tick", () => {
    const u = { time: { value: 0 }, scanOffset: { value: 0 } };
    tickHoloUniforms(u, 0.5);
    expect(u.time.value).toBeCloseTo(0.5);
    expect(u.scanOffset.value).toBeCloseTo(0.3);
  });
});
