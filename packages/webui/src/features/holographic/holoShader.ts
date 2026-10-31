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
 * Scanlines sweep vertically over time. The replay markers used to pair
 * this material with a per-mesh wireframe overlay mesh — removed once it
 * doubled the fleet's draw calls; the hull read now rides this shader's
 * own terms (see uLinesGain) plus the caller's hull outline.
 *
 * Surface-structure layer: the ship stage gets its panel read from terms
 * that CANNOT fragment on the coarse quantized bake. Normal-driven terms
 * (a headlight, a ship-fixed facet key, a measuring grid) were tried for
 * this and rejected: every normal-based gain turns the ~30–50° plate-
 * incidence spread into mottled light/dark blotches that read as broken
 * reflections. The stage's structure now comes from `uSliceGain` —
 *   - `uSliceGain` / `uSliceSpacing` — thin world-space-Y iso-contour
 *     lines (fwidth-antialiased, additive in the fresnel colour): the
 *     stacked-projection-lines hologram cue. Normal-independent, so the
 *     plate mosaic cannot break them. World space because the bake's local
 *     units differ per ship while the stage normalizes every model to the
 *     same 200-unit box.
 * The legacy definition terms (`uLightGain`, `uLinesGain`, `uFacetGain` /
 * `uFacetSat` / `uFacetDir`) stay wired — `uLinesGain` still serves the
 * replay's ship markers — but the stage look (`stageLook.applyStageLook`)
 * leaves them at 0.
 * Texture layer: three more stage-only terms push the look from "moulded
 * plastic" toward a transmitted projection —
 *   - `uScanGain` — fine CRT-pitch scanline rows in SCREEN space (constant
 *     density at any zoom), drifting slowly upward.
 *   - `uSweepGain` — a soft gaussian band climbing the world-space Y axis
 *     once every ~7.7 s, brightening and slightly densifying the hull as it
 *     passes (a "materializing" wash).
 *   - `uFlickerGain` — a single-digit-percent brightness flicker (two
 *     incommensurate sines) so the surface feels transmitted.
 * Translucency: the fill/rim alpha split moved into `uBaseAlpha` /
 * `uRimAlpha` (legacy constants 0.72 / 0.28) so the stage can trade fill
 * opacity for rim glow — a glassier shell whose broadsides show the
 * background through them while the depth anchor still occludes the far
 * side.
 * All new terms default to 0 / legacy — `makeHoloMaterial()` alone still
 * reproduces the legacy look.
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

/** Uniforms object shape for the holographic ShaderMaterial.
 *
 *  Deliberately a type alias, not an interface: aliases of object literals get
 *  the implicit string index signature that `Record<string, IUniform>` needs,
 *  which is what lets `HoloShaderMaterial.uniforms` narrow the open record
 *  three declares instead of double-casting back to it. The key set stays
 *  closed — an undeclared uniform is still a type error. */
export type HoloUniforms = {
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
  /** Fill opacity at zero fresnel — the legacy shell is 0.72; the ship stage
   *  drops it well below so broadsides read as glass, not moulded plastic. */
  uBaseAlpha: { value: number };
  /** Fresnel-driven opacity added toward the rim (legacy 0.28). */
  uRimAlpha: { value: number };
  /** Fine screen-space scanline rows (CRT pitch, slow upward crawl) —
   *  0 draws none. */
  uScanGain: { value: number };
  /** A soft bright band climbing the world-space Y axis — 0 draws none. */
  uSweepGain: { value: number };
  /** Subtle whole-surface brightness flicker — 0 stays steady. */
  uFlickerGain: { value: number };
  /** Fresnel exponent / gain — the legacy constants (2.5 / 1.2) by default so
   *  markers keep the old rim; the stage raises the exponent to confine the
   *  rim to the true silhouette (a coarse quantized hull at low incidence
   *  otherwise turns the broad rim into a per-plate mosaic of bright wedges). */
  uFresnelPow: { value: number };
  uFresnelGain: { value: number };
  /** Hologram slice lines: thin world-space-Y iso-contours (fwidth-
   *  antialiased), additive in the fresnel colour. Normal-independent, so
   *  the coarse bake's plate mosaic cannot break them — this is the stage
   *  look's main surface-structure carrier (0 = off, legacy default). */
  uSliceGain: { value: number };
  /** World-space interval between slice lines (stage units — every model is
   *  normalized into the same 200-unit box, so one value fits all ships). */
  uSliceSpacing: { value: number };
  /** Ship-fixed facet key: a brightness step per plate orientation (0 = the
   *  legacy flat fill). The headlight above fades out at grazing angles, which
   *  is exactly where a broadside melts into one fill — this term does not. */
  uFacetGain: { value: number };
  /** Saturation spread of the same key: differently-angled plates take
   *  slightly different saturation, which is what makes the coarse bake read
   *  as facets instead of one pastel wash (0 = off). */
  uFacetSat: { value: number };
  /** The facet key direction in OBJECT space (the ship's own frame: +Y up, bow
   *  along ±Z) so the tone pattern is fixed to the hull, not to the camera. */
  uFacetDir: { value: THREE.Vector3 };
};

/** A holographic ShaderMaterial whose `uniforms` keep the authored shape.
 *
 *  `THREE.ShaderMaterial` types `uniforms` as an open `Record<string, IUniform>`
 *  — the library cannot know a shader's uniform names — so the table authored
 *  by `makeHoloMaterial` is erased for every reader. Redeclaring the field on
 *  a subclass restores the closed shape at the creation point, which is where
 *  it is actually known: consumers then read `mat.uniforms.time` etc. with no
 *  assertion anywhere (`HoloUniforms` is assignable to the open record, so the
 *  override is checked, not forced). Nothing at runtime changes — `declare`
 *  emits no field and the constructor is inherited. */
export class HoloShaderMaterial extends THREE.ShaderMaterial {
  declare uniforms: HoloUniforms;
}

export const HOLO_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vViewPos;
  varying vec3 vLocalPos;
  varying vec3 vNormal;
  varying vec3 vObjNormal;
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
    // Object-space normal for the facet key (see uFacetDir): the mesh nodes
    // carry no rotation, so this is the ship's own frame whatever the camera
    // or the normalization group do.
    vObjNormal = normal;
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
  uniform float uBaseAlpha;
  uniform float uRimAlpha;
  uniform float uScanGain;
  uniform float uSweepGain;
  uniform float uFlickerGain;
  uniform float uFresnelPow;
  uniform float uFresnelGain;
  uniform float uFacetGain;
  uniform float uFacetSat;
  uniform vec3 uFacetDir;
  uniform float uSliceGain;
  uniform float uSliceSpacing;
  varying vec3 vWorldPos;
  varying vec3 vViewPos;
  varying vec3 vLocalPos;
  varying vec3 vNormal;
  varying vec3 vObjNormal;
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
    // Exponent/gain ride uniforms (legacy 2.5 / 1.2). A high exponent with a
    // modest gain keeps the rim a silhouette light: the baked hull's quantized
    // plates sit at slightly different incidences, and a broad rim turns those
    // small differences into a mosaic of bright wedge patches and seam lines.
    float fres = pow(1.0 - max(dot(n, viewDir), 0.0), uFresnelPow);
    // With smooth normals the PRE-flip facing is trustworthy, and a plate whose
    // normal leans slightly AWAY from the camera sits at |facing| ≈ 0 exactly
    // like a true silhouette — the rim then paints it as a bright crumpled-foil
    // seam over the whole flank. Fade the rim out across the leaning-away
    // range. Gated to the smooth-normal path: derivative normals flip with the
    // hull's random winding, where "negative facing" means nothing.
    fres *= mix(1.0, smoothstep(-0.25, 0.05, facing), vHasNormal);
    float scan = sin((vLocalPos.y * 0.08 + scanOffset) * 6.2831) * 0.5 + 0.5;
    scan = smoothstep(0.82, 1.0, scan);
    vec3 col = baseColor * (0.75 + 0.45 * fres);
    col += fresnelColor * fres * uFresnelGain;
    col += fresnelColor * scan * 0.5;
    // Headlight: ease the facing ratio so only surfaces square to the camera
    // lift, while grazing panels stay dark toward the rim. Multiplicative —
    // the hue stays the category's own instead of washing toward white.
    if (uLightGain > 0.0 && vHasNormal > 0.5) {
      float def = dot(n, viewDir);
      col *= 1.0 + uLightGain * def * def;
    }
    // Facet definition: a key light FIXED IN THE SHIP'S FRAME. The headlight
    // above fades out at grazing incidence — a low broadside has every plate
    // nearly parallel to the view — which is exactly where the coarse bake
    // melts into a single pastel fill. A ship-fixed key keeps deck, flank and
    // end plates at stable, different tones, so the deck edge, the chine and
    // every superstructure corner read as edges without a line overlay, and
    // the pattern does not swim as the camera moves. abs() because the bake's
    // winding is random: a plate's tone must not depend on which way its
    // triangle happens to face. Centred on 0.5 so the ship's overall tone is
    // unchanged.
    if ((uFacetGain > 0.0 || uFacetSat > 0.0) && vHasNormal > 0.5) {
      vec3 nObj = normalize(vObjNormal);
      float key = abs(dot(nObj, uFacetDir)) - 0.5;
      col *= 1.0 + uFacetGain * key;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, clamp(1.0 + uFacetSat * key, 0.0, 2.0));
    }
    // Measuring grid, one line every 10 world units on each axis. Kept
    // faint: it must read as panel structure, not as a cage over the ship.
    if (uLinesGain > 0.0) {
      vec3 g = abs(fract(vWorldPos / 10.0 - 0.5) - 0.5) / fwidth(vWorldPos);
      float line = 1.0 - min(min(g.x, g.y), g.z);
      col += fresnelColor * clamp(line, 0.0, 1.0) * uLinesGain;
    }
    // Hologram slice lines: thin iso-contours of the world-space Y axis.
    // fwidth keeps them at a constant pixel width at any zoom; the width
    // floor keeps a deck that sits exactly ON a contour from lighting up
    // wholesale (fwidth ≈ 0 on a flat horizontal plate is the degenerate
    // case). Additive and normal-independent — a curved hull flank picks
    // up the classic stacked-projection-lines read.
    if (uSliceGain > 0.0) {
      float sy = vWorldPos.y / max(uSliceSpacing, 0.001);
      float sd = abs(fract(sy + 0.5) - 0.5);
      float sw = max(fwidth(sy) * 1.2, 0.015);
      float sliceLine = 1.0 - smoothstep(0.0, sw, sd);
      col += fresnelColor * sliceLine * uSliceGain;
    }
    // Fine scanline rows in SCREEN space: constant CRT pitch at any zoom,
    // drifting slowly upward. Screen space because local-space rows change
    // density with the ship's bake units while the effect wants to read as
    // a property of the projector, not of the hull.
    float sweep = 0.0;
    if (uScanGain > 0.0 || uSweepGain > 0.0) {
      float row = sin(gl_FragCoord.y * 1.7 - time * 3.0);
      col += fresnelColor * smoothstep(0.55, 0.98, row) * uScanGain * 0.30;
      // Sweep band: one soft gaussian wave climbing the world-space Y axis
      // (the stage normalizes every model to the same 200-unit box, so the
      // band crosses any ship in ~7.7 s). Lifts colour and a little alpha so
      // the pass visibly "washes over" translucent hulls.
      float yBand = -120.0 + 240.0 * fract(time * 0.13);
      float d = vWorldPos.y - yBand;
      sweep = exp(-d * d * 0.006);
      col += fresnelColor * sweep * uSweepGain;
    }
    // Faint projector flicker — a beat of two incommensurate sines so the
    // surface feels transmitted, never a steady paint job. Kept in single
    // digits of gain: past that it reads as a rendering bug.
    if (uFlickerGain > 0.0) {
      col *= 1.0 + uFlickerGain * sin(time * 23.0) * sin(time * 7.3);
    }
    // No interior alpha fade: it would be another dot(n, viewDir) sign test at
    // the same grazing incidence the plate mosaic comes from. Occlusion is the
    // depth test's job (the stage writes depth); every fragment keeps one
    // opacity, and a back face simply fades out through the Fresnel term.
    // uBaseAlpha/uRimAlpha split the legacy 0.72 + 0.28 * fres so callers can
    // trade fill opacity for rim glow (glassier hologram) without touching
    // the shader.
    float alpha = min(uBaseAlpha + uRimAlpha * fres + sweep * uSweepGain * 0.20, 1.0);
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

/** Create a fresh holographic material with its own uniforms object. Returns
 *  the material; the uniforms are reachable via `mat.uniforms`. */
export function makeHoloMaterial(): HoloShaderMaterial {
  const fps: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) fps.push(new THREE.Vector3());
  // Typing the LITERAL (not just the class field) is what makes the closed
  // shape VERIFIED rather than declared: `THREE.ShaderMaterial`'s constructor
  // takes an open `Record<string, IUniform>` whose `value` is `any`, so
  // without this annotation `time: { value: "0" }` compiles and renders
  // garbage at runtime.
  const uniforms: HoloUniforms = {
      time: { value: 0 },
      scanOffset: { value: 0 },
      baseColor: { value: new THREE.Color(0x0d6e8a) },
      fresnelColor: { value: new THREE.Color(0x33ccff) },
      focusPoints: { value: fps },
      focusCount: { value: 0 },
      focusRadius: { value: 30.0 },
      focusBoost: { value: 0.8 },
      ghostAlpha: { value: 1.0 },
      // Legacy look: every definition/texture term off and the alpha split at
      // the historical constants. The ship stage turns the gains on per
      // material after loading a model; markers and terrain keep these.
      uLightGain: { value: 0.0 },
      uLinesGain: { value: 0.0 },
      uBaseAlpha: { value: 0.72 },
      uRimAlpha: { value: 0.28 },
      uScanGain: { value: 0.0 },
      uSweepGain: { value: 0.0 },
      uFlickerGain: { value: 0.0 },
      uFresnelPow: { value: 2.5 },
      uFresnelGain: { value: 1.2 },
      // Facet key off (and its direction at a normalized default) so markers,
      // terrain and the replay's ghost ships keep the legacy flat fill.
      uFacetGain: { value: 0.0 },
      uFacetSat: { value: 0.0 },
      uFacetDir: { value: new THREE.Vector3(0.5, 0.78, 0.38).normalize() },
      // Slice lines off by default (markers, terrain and the mod stage keep
      // the legacy fill); the ship stage opts in via applyStageLook.
      uSliceGain: { value: 0.0 },
      uSliceSpacing: { value: 4.0 },
  };

  return new HoloShaderMaterial({
    uniforms,
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
