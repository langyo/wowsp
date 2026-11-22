/**
 * The clip export renders the replay's own three.js scene through a SEPARATE
 * camera, so that camera's layer mask decides which object classes reach the
 * clip at all. These tests pin the rule: the export camera sees every layer
 * the LIVE camera enables, plus the export-only label layer — never a
 * hand-listed subset that would silently drop a class (the hull models were
 * the motivating case).
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  GOD_SYMBOL_MAX_SCALE,
  GOD_SYMBOL_MIN_SCALE,
  GOD_SYMBOL_TARGET_PX,
  MAX_LAYER_INDEX,
  adoptExportCameraLayers,
  exportCameraLayerMask,
  godViewSymbolScale,
} from "./sceneUtils";

/** The 3D take's label cards (see exportShipLabels.EXPORT_LABEL_LAYER). */
const LABEL_LAYER = 1;

/** Every bit of a 32-bit layer mask, layer 0 first. */
function maskBits(mask: number): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i <= MAX_LAYER_INDEX; i++) bits.push(((mask >>> i) & 1) === 1);
  return bits;
}

/** An Object3D that lives on exactly one layer. */
function objectOn(layer: number): THREE.Object3D {
  const object = new THREE.Object3D();
  object.layers.set(layer);
  return object;
}

describe("exportCameraLayerMask", () => {
  it("is the live mask plus the export-only layer", () => {
    // A fresh three.js camera starts on layer 0; the take adds its cards.
    expect(exportCameraLayerMask(0b1, [LABEL_LAYER])).toBe(0b11);
  });

  it("keeps EVERY layer the live camera enables", () => {
    // Layer 30 and 31 pin the sign edge: `1 << 31` is negative in JS and
    // three's own masks mix int32/uint32 — only the BIT may ever be compared.
    const live = (1 << 0) | (1 << 2) | (1 << 5) | (1 << 30) | (1 << 31);
    const bits = maskBits(exportCameraLayerMask(live, [LABEL_LAYER]));
    for (let layer = 0; layer <= MAX_LAYER_INDEX; layer++) {
      const wanted = ((live >>> layer) & 1) === 1 || layer === LABEL_LAYER;
      expect({ layer, visible: bits[layer] }).toEqual({ layer, visible: wanted });
    }
  });

  it("does not enable layers the live camera keeps hidden", () => {
    const mask = exportCameraLayerMask(0b1, [LABEL_LAYER]);
    // Layer 3 is neither the live view's nor the cards': the clip must not
    // leak it (same visible set, not "everything").
    expect(mask & (1 << 3)).toBe(0);
  });

  it("is idempotent when the live camera already shows the cards' layer", () => {
    expect(exportCameraLayerMask(0b11, [LABEL_LAYER])).toBe(0b11);
  });

  it("ignores indices outside the Layers 0..31 range", () => {
    // JS shifts wrap (1 << 32 === 1), which would light up layer 0 instead.
    expect(exportCameraLayerMask(0b1, [32, -1, 1.5])).toBe(0b1);
  });

  it("is the identity without export-only layers", () => {
    expect(exportCameraLayerMask(0b10110)).toBe(0b10110);
  });

  it("can add the top layer (31) without shifting onto another channel", () => {
    expect((exportCameraLayerMask(0, [31]) >>> 31) & 1).toBe(1);
  });
});

describe("adoptExportCameraLayers", () => {
  it("makes the export camera see every live layer plus the label layer", () => {
    const live = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
    live.layers.enable(2);
    live.layers.enable(7);
    const take = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);

    adoptExportCameraLayers(take, live, [LABEL_LAYER]);

    for (const layer of [0, 1, 2, 7]) {
      expect({ layer, seen: take.layers.test(objectOn(layer).layers) }).toEqual({
        layer,
        seen: true,
      });
    }
    expect(take.layers.test(objectOn(4).layers)).toBe(false);
  });

  it("never mutates the live camera's mask", () => {
    const live = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
    live.layers.enable(3);
    const before = live.layers.mask;

    adoptExportCameraLayers(new THREE.PerspectiveCamera(), live, [LABEL_LAYER]);

    expect(live.layers.mask).toBe(before);
  });

  it("restores a hull model on a new layer that the hand-listed mask skipped", () => {
    // Regression: the export camera used to be built from a fresh camera's
    // default layer 0 plus the label layer only. A hull model that lives on
    // another layer (the scene's hulls are the motivating class) rendered in
    // the live view but was missing from every exported clip.
    const live = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
    live.layers.enable(2);
    const take = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
    take.layers.set(0);
    take.layers.enable(LABEL_LAYER); // the old hand-listed export set
    const hull = objectOn(2);
    expect(take.layers.test(hull.layers)).toBe(false); // the bug's symptom

    adoptExportCameraLayers(take, live, [LABEL_LAYER]);

    expect(take.layers.test(hull.layers)).toBe(true);
    // The take's own export-only cards still render.
    expect(take.layers.test(objectOn(LABEL_LAYER).layers)).toBe(true);
  });
});

/* ── The 3D export's god-view hull symbols ──────────────────────────────
 * The clip frames the whole map from tens of km away, where a true-scale
 * hull is a ~2 px sliver. The export therefore draws hulls as tactical-map
 * symbols whose longest world dimension holds a constant screen length, using
 * the label cards' own distance math. These tests pin that math: the
 * screen-length invariant, each linear term, both clamp bounds, and the
 * degenerate-input floor. */

/** The clip's logical map square edge (playbackExport.EXPORT_LOGICAL). */
const BUFFER = 760;
/** The export camera's vertical FOV in degrees. */
const FOV = 50;

/** World units one logical map px spans at `distance` — the card math. */
function worldPerPx(distance: number, fov = FOV, buffer = BUFFER): number {
  return (2 * distance * Math.tan((fov * Math.PI) / 360)) / buffer;
}

/** On-screen length (logical px) `scale` gives a hull of `length` units. */
function screenPx(scale: number, length: number, distance: number): number {
  return (scale * length) / worldPerPx(distance);
}

describe("godViewSymbolScale", () => {
  it("exports the clip's symbol constants", () => {
    // The hull symbol must stay under the label card's 92 px width so the
    // card keeps the live view's visual hierarchy (card strictly dominant).
    expect(GOD_SYMBOL_TARGET_PX).toBe(56);
    expect(GOD_SYMBOL_MIN_SCALE).toBe(1);
    expect(GOD_SYMBOL_MAX_SCALE).toBe(40);
  });

  it("makes a hull span the target length at full-map range", () => {
    // ~7.2k scene units is the fitted god camera's distance for a ~26 km map
    // (the ~2 px sliver report this scaling exists for).
    const distance = 7_158;
    const scale = godViewSymbolScale(distance, FOV, 56, BUFFER, 50);

    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeLessThan(GOD_SYMBOL_MAX_SCALE);
    expect(screenPx(scale, 50, distance)).toBeCloseTo(56, 6);
  });

  it("gives every hull class the same on-screen length", () => {
    // A battleship (50 u) and a destroyer (27 u) are different world lengths:
    // the symbol scale absorbs the difference instead of the screen size.
    const distance = 7_158;
    const bb = godViewSymbolScale(distance, FOV, 56, BUFFER, 50);
    const dd = godViewSymbolScale(distance, FOV, 56, BUFFER, 27);

    expect(screenPx(bb, 50, distance)).toBeCloseTo(56, 6);
    expect(screenPx(dd, 27, distance)).toBeCloseTo(56, 6);
    expect(dd / bb).toBeCloseTo(50 / 27, 6);
  });

  it("is linear in distance", () => {
    const base = godViewSymbolScale(2_000, FOV, 56, BUFFER, 20);
    const twice = godViewSymbolScale(4_000, FOV, 56, BUFFER, 20);

    expect(twice).toBeCloseTo(base * 2, 6);
  });

  it("is linear in the target length and inversely linear in the buffer", () => {
    const base = godViewSymbolScale(2_000, FOV, 56, BUFFER, 20);

    expect(
      godViewSymbolScale(2_000, FOV, 112, BUFFER, 20),
    ).toBeCloseTo(base * 2, 6);
    expect(
      godViewSymbolScale(2_000, FOV, 56, BUFFER * 2, 20),
    ).toBeCloseTo(base / 2, 6);
  });

  it("widens with the field of view", () => {
    // A wider lens sees more world per pixel, so the constant-px symbol is
    // physically larger.
    const narrow = godViewSymbolScale(2_000, 30, 56, BUFFER, 20);
    const wide = godViewSymbolScale(2_000, 60, 56, BUFFER, 20);

    expect(wide).toBeGreaterThan(narrow);
    expect(wide / narrow).toBeCloseTo(
      Math.tan((60 * Math.PI) / 360) / Math.tan((30 * Math.PI) / 360),
      6,
    );
  });

  it("is the identity at close range (never shrinks below true scale)", () => {
    // 100 u from the camera, a 50 u hull is already far more than 56 px.
    expect(godViewSymbolScale(100, FOV, 56, BUFFER, 50)).toBe(1);
    // ...and exactly 1 at the distance where the true hull spans 56 px.
    const identityDistance =
      (50 * BUFFER) / (2 * Math.tan((FOV * Math.PI) / 360) * 56);
    expect(
      godViewSymbolScale(identityDistance, FOV, 56, BUFFER, 50),
    ).toBeCloseTo(1, 10);
    expect(
      godViewSymbolScale(identityDistance * 1.01, FOV, 56, BUFFER, 50),
    ).toBeGreaterThan(1);
  });

  it("caps runaway scaling at the hard cap", () => {
    expect(godViewSymbolScale(1e9, FOV, 56, BUFFER, 50)).toBe(GOD_SYMBOL_MAX_SCALE);
    // A bogusly tiny measured hull is capped too, never a screen-filling blob.
    expect(godViewSymbolScale(7_158, FOV, 56, BUFFER, 0.01)).toBe(
      GOD_SYMBOL_MAX_SCALE,
    );
  });

  it("honours caller-supplied clamps", () => {
    expect(godViewSymbolScale(100, FOV, 56, BUFFER, 50, 2, 40)).toBe(2);
    expect(godViewSymbolScale(1e9, FOV, 56, BUFFER, 50, 1, 5)).toBe(5);
  });

  it("falls back to the true scale for degenerate inputs", () => {
    // Unmeasurable hull/camera values must never produce a NaN transform.
    // [distance, fovDeg, targetPx, bufferWidth, modelWorldLength]
    const degenerate: [number, number, number, number, number][] = [
      [Number.NaN, FOV, 56, BUFFER, 50],
      [0, FOV, 56, BUFFER, 50],
      [-5, FOV, 56, BUFFER, 50],
      [2_000, Number.NaN, 56, BUFFER, 50],
      [2_000, 0, 56, BUFFER, 50],
      [2_000, 180, 56, BUFFER, 50],
      [2_000, FOV, 0, BUFFER, 50],
      [2_000, FOV, 56, 0, 50],
      [2_000, FOV, 56, BUFFER, 0],
      [2_000, FOV, 56, BUFFER, Number.NaN],
    ];
    for (const args of degenerate) {
      expect(godViewSymbolScale(...args)).toBe(GOD_SYMBOL_MIN_SCALE);
    }
  });
});
