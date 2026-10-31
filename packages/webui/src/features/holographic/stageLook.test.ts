/** Tests for the ship stage's shared look module: the palette contract
 *  (category coding stays stable, weapons stay muted glass, the light
 *  theme gets the saturated "ink rim" treatment) and the uniform tuning
 *  applyStageLook stamps onto a holo material. */
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { makeHoloMaterial } from "./holoShader";
import {
  applyStageLook,
  categoryBase,
  colorForCategory,
  HOLO_BASE_ALPHA,
  WEAPON_NAMES,
} from "./stageLook";

const hsl = (c: THREE.Color): { h: number; s: number; l: number } => {
  const out = { h: 0, s: 0, l: 0 };
  c.getHSL(out);
  return out;
};

describe("stageLook", () => {
  it("colours instance-suffixed bake names by their category prefix", () => {
    expect(categoryBase("main_battery_249")).toBe("main_battery");
    expect(categoryBase("hull_bow")).toBe("hull_bow");
    expect(categoryBase("unheard_of_thing")).toBe("unheard_of_thing");
    // GLTFLoader auto-names unnamed meshes "mesh_0" — those single-mesh
    // marker models take the misc hull tone, not a random hash hue.
    expect(categoryBase("mesh_0")).toBe("misc");
    expect(categoryBase("mesh_123")).toBe("misc");
    const a = colorForCategory("main_battery", "dark");
    const b = colorForCategory("main_battery_249", "dark");
    expect(a.base.getHex()).toBe(b.base.getHex());
  });

  it("keeps weapons as muted tinted glass in both themes", () => {
    for (const mode of ["dark", "light"] as const) {
      const { base } = colorForCategory("main_battery", mode);
      const { s } = hsl(base);
      // The saturated orange blobs (sat 0.72) were the "plastic toys on a
      // ghost ship" cue — the look keeps hue coding but well under half
      // saturation.
      expect(s).toBeLessThan(0.4);
      // …but the hue itself survives (main battery stays in the warm band).
      expect(hsl(base).h * 360).toBeCloseTo(22, 0);
    }
    expect(WEAPON_NAMES.has("aa_mount")).toBe(true);
  });

  it("runs the light theme saturated and the dark theme ghostly", () => {
    const light = hsl(colorForCategory("hull_body", "light").base);
    const dark = hsl(colorForCategory("hull_body", "dark").base);
    expect(light.s).toBeGreaterThan(dark.s);
    expect(HOLO_BASE_ALPHA.light).toBeGreaterThan(HOLO_BASE_ALPHA.dark);
    // The light-theme rim is pulled DARKER ("glowing ink" on paper) — an
    // additive bright rim vanishes against the white stage background.
    for (const name of ["hull_body", "main_battery"]) {
      const l = colorForCategory(name, "light").fresnel;
      const d = colorForCategory(name, "dark").fresnel;
      expect(l.r + l.g + l.b).toBeLessThan(d.r + d.g + d.b);
    }
  });

  it("stamps the slice-based look and leaves normal-driven terms dark", () => {
    const mat = makeHoloMaterial();
    const u = mat.uniforms;
    applyStageLook(u, "light");
    expect(u.uBaseAlpha.value).toBe(HOLO_BASE_ALPHA.light);
    expect(u.uSliceGain.value).toBeGreaterThan(0);
    expect(u.uSliceSpacing.value).toBeGreaterThan(0);
    expect(u.uLightGain.value).toBe(0);
    expect(u.uLinesGain.value).toBe(0);
    expect(u.uFacetGain.value).toBe(0);
    expect(u.uFacetSat.value).toBe(0);
  });
});
