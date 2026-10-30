/**
 * The ship stage's holographic LOOK in one place: the category palette and
 * the uniform tuning that turns the legacy flat shell into the stage's
 * glass-projection hologram. ShipStage applies it per material after loading
 * a model; the holo lab harness imports the same module so what is tuned
 * there is what ships. Replay markers, terrain and the mod-hub stage keep
 * `makeHoloMaterial()`'s legacy defaults and never call applyStageLook.
 *
 * Design notes (tuned in the holo lab against Montana/Fuso/Jervis renders):
 * - NO normal-driven lighting (headlight / facet key / measuring grid). On
 *   the coarse quantized bake every such term turns the ~30–50° plate-
 *   incidence spread into mottled light/dark blotches that read as broken
 *   reflections — the "weird reflective blocks" complaint. Surface
 *   structure comes from the slice lines (normal-independent) instead.
 * - The LIGHT theme is the hard case: additive glow vanishes against the
 *   paper-white stage background. There the fill gets a saturated azure
 *   and real opacity, and the rim/FX colour is pulled DARKER ("ink rim")
 *   so silhouettes, scanlines and slices stay visible on white. The dark
 *   theme keeps the classic translucent-cyan ghost.
 * - Weapons keep their hue coding but are heavily muted — pale tinted
 *   glass, not solid painted parts. The loud saturated orange/red blobs
 *   were the main "plastic toys glued to a ghost ship" cue; hue mixing
 *   toward the hull colour was tried and rejected (the interpolation
 *   passes through green).
 */
import * as THREE from "three";
import type { HoloUniforms } from "./holoShader";

/** Mesh categories that render one hue step brighter (weapons pop off the
 *  hull under the holographic palette). */
export const WEAPON_NAMES = new Set([
  "main_battery", "secondary_battery", "aa_mount", "torpedo",
  "weapon", "turret_part", "aircraft",
]);

/** Pre-defined base hues (0-360) for known category names. Each category
 *  name always maps to the same hue — no hash drift. */
export const PRESET_HUES: Record<string, number> = {
  // Hull — ONE hue for the whole plating. The bow/mid/stern split is
  // a bake-chunk boundary, not a visible structure: giving each chunk
  // its own hue painted three mismatched pastel slabs over a
  // continuous hull, one of the main "mushy patchwork" cues.
  hull_bow:    195,
  hull_mid:    195,
  hull_stern:  195,
  hull_body:   195,
  deck_house:  205,
  // Superstructure — teal, a half-step off the hull azure. (Was 148°
  // green: on the saturated light-theme hologram the green fire-control
  // blocks read as mould spots, and a floating green ball at the mast
  // top drew the eye off the ship.)
  superstructure: 170,
  funnel:      210,
  // Weapons — warm spectrum with 30–40° gaps
  main_battery:      22,   // orange
  secondary_battery: 55,   // amber
  aa_mount:          6,    // red
  torpedo:          172,   // teal
  aircraft:         280,   // purple
  weapon:            36,   // gold (generic)
  turret_part:       44,   // darker gold
  propeller:        200,   // screws share the misc hue
  misc:             200,
};

/** Instance-suffixed bake names ("main_battery_249") still colour by
 *  their category prefix, so every turret looks the same while
 *  remaining individually addressable. */
export function categoryBase(name: string): string {
  for (const key of Object.keys(PRESET_HUES)) {
    if (name === key || name.startsWith(`${key}_`)) return key;
  }
  // Auto-generated names for unnamed glTF meshes (GLTFLoader's "mesh_0")
  // carry no category information — paint them the generic misc hull tone
  // instead of letting them roll an arbitrary hash hue (a whole low-poly
  // ship rendered yellow-olive was the visible symptom).
  if (/^mesh_\d+$/.test(name)) return "misc";
  return name;
}

/** Holographic fill alpha per theme mode: the pale light-theme stage needs
 *  a much denser fill — a translucent cyan wash disappears against the
 *  paper-white background (applyStageLook and the live theme flip share
 *  this table). Both values also sit high enough that the hull's far side
 *  contributes almost nothing through the near shell — at 0.72 the leaked
 *  far-side rim painted a patchy "water glint" sparkle over the flank. */
export const HOLO_BASE_ALPHA = { dark: 0.52, light: 0.85 } as const;
export type StageLookMode = keyof typeof HOLO_BASE_ALPHA;

/** Rim/FX colour multiplier per theme. On the dark stage the rim is a
 *  bright additive glow; on the white stage a bright rim is invisible, so
 *  the rim (and the scanline/slice/sweep accents coloured by it) goes
 *  darker — "glowing ink" that reads on paper. */
const RIM_INK: Record<StageLookMode, number> = { dark: 1.0, light: 0.60 };

export function colorForCategory(
  name: string,
  mode: StageLookMode,
): { base: THREE.Color; fresnel: THREE.Color } {
  name = categoryBase(name);
  let hue: number, sat: number, lit: number;
  if (PRESET_HUES[name] != null) {
    hue = PRESET_HUES[name];
  } else {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
      h = ((h << 5) - h) + name.charCodeAt(i);
      h |= 0;
    }
    hue = (h >>> 0) % 360;
  }
  const light = mode === "light";
  if (WEAPON_NAMES.has(name)) {
    // Weapons stay hue-coded but read as pale tinted glass — the hue lives
    // in the rim, the fill is a whisper of it. Loud saturated fills were
    // the "solid orange blobs" that broke the projection read.
    sat = light ? 0.30 : 0.35;
    lit = light ? 0.55 : 0.45;
  } else if (name.startsWith("hull_") || name === "deck_house" || name === "superstructure") {
    // The light theme's hologram is a saturated azure glass ship; the dark
    // theme keeps the ghostly translucent cyan.
    sat = light ? 0.75 : 0.48;
    lit = light ? 0.42 : 0.30;
  } else if (name === "funnel") {
    sat = light ? 0.30 : 0.15;
    lit = light ? 0.45 : 0.22;
  } else {
    sat = light ? 0.60 : 0.50;
    lit = light ? 0.45 : 0.32;
  }
  const fresnel = new THREE.Color().setHSL(
    hue / 360,
    sat * 0.85,
    Math.min(lit * 2.0, 0.85),
  );
  fresnel.multiplyScalar(RIM_INK[mode]);
  return {
    base: new THREE.Color().setHSL(hue / 360, sat, lit),
    fresnel,
  };
}

/** Apply the stage's holographic look to a fresh material's uniforms: the
 *  glass alpha split, the slice-line structure, the texture layer. The
 *  normal-driven definition terms are deliberately left DARK (see the
 *  header): their uniforms stay wired for markers / ModelStage / tests. */
export function applyStageLook(u: HoloUniforms, mode: StageLookMode): void {
  u.uLightGain.value = 0.0;
  u.uLinesGain.value = 0.0;
  u.uFacetGain.value = 0.0;
  u.uFacetSat.value = 0.0;
  u.uBaseAlpha.value = HOLO_BASE_ALPHA[mode];
  u.uRimAlpha.value = 0.55;
  u.uScanGain.value = 0.45;
  u.uSweepGain.value = 0.40;
  u.uFlickerGain.value = 0.05;
  // Confine the rim to the true silhouette: exponent 20 with a modest
  // gain keeps the rim a silhouette light instead of a per-plate mosaic of
  // bright wedges on the coarse quantized hull. At pow 10 the continuously
  // curving hull regions (bilge turn, bow flare, plate creases) still
  // crossed the visible threshold and painted bright curving lines across
  // the flank; 0.9^20 = 0.12 vs 0.9^10 = 0.35 pushes them under it while
  // the true silhouette (dot -> 1) is untouched.
  u.uFresnelPow.value = 20.0;
  u.uFresnelGain.value = 1.2;
  // Stacked-projection slices: the hologram's main surface cue. 4 world
  // units of pitch puts ~10 lines over a normalized hull's height; the
  // gain stays a whisper so they read as scan structure, not venetian
  // blinds.
  u.uSliceGain.value = 0.30;
  u.uSliceSpacing.value = 4.0;
}
