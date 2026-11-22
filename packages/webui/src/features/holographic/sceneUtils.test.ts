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
  MAX_LAYER_INDEX,
  adoptExportCameraLayers,
  exportCameraLayerMask,
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
