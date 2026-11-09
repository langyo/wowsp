/** Pure-helper guards for the layered resource-pack swimlane: ordering,
 *  legacy pinning, row badges and the render report's conflict-path fold.
 *  The component / composable are exercised through their props and the
 *  IPC contract, so these rules stay pin-able without mounting hikari. */
import { describe, expect, it } from "vitest";

import type { LayerPathWinner, LayerSlotConflict, ModLayer } from "@/api";

import {
  conflictPaths,
  conflictsOfLayer,
  layerBadges,
  layerCategoryKey,
  moveLayer,
  normalizeLayerOrder,
  orderLayers,
} from "./layerStackHelpers";

function layer(patch: Partial<ModLayer> & { packId: string }): ModLayer {
  return {
    name: patch.packId,
    version: "1.0.0",
    category: "skin",
    layerClass: "override",
    enabled: true,
    priority: 0,
    slots: [],
    fileCount: 0,
    winningCount: 0,
    shadowedCount: 0,
    coveredBy: null,
    managed: true,
    ...patch,
  };
}

describe("layer stack ordering", () => {
  it("applies a packId order and appends ids the order omits", () => {
    const a = layer({ packId: "a" });
    const b = layer({ packId: "b" });
    const c = layer({ packId: "c" });
    expect(orderLayers([a, b, c], ["c", "a"]).map((l) => l.packId)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("applies the drag's from/to indexes to a copied list", () => {
    const list = [layer({ packId: "a" }), layer({ packId: "b" }), layer({ packId: "c" })];
    expect(moveLayer(list, 2, 0).map((l) => l.packId)).toEqual(["c", "a", "b"]);
    // Out-of-range gestures leave the list untouched.
    expect(moveLayer(list, 5, 0).map((l) => l.packId)).toEqual(["a", "b", "c"]);
    expect(list.map((l) => l.packId)).toEqual(["a", "b", "c"]);
  });

  it("keeps legacy layers pinned at the bottom, preserving both relative orders", () => {
    const managedA = layer({ packId: "a" });
    const legacyB = layer({ packId: "b", managed: false });
    const managedC = layer({ packId: "c" });
    const legacyD = layer({ packId: "d", managed: false });
    expect(
      normalizeLayerOrder([legacyB, managedA, legacyD, managedC]).map((l) => l.packId),
    ).toEqual(["a", "c", "b", "d"]);
  });
});

describe("layer badges", () => {
  it("reports shadowing, slot conflicts, legacy state and pending renders", () => {
    const conflicts: LayerSlotConflict[] = [
      { slot: "ship:JSB039", packIds: ["a", "b"] },
    ];
    expect(
      layerBadges(layer({ packId: "a", shadowedCount: 3 }), {
        rendered: false,
        conflicts,
      }),
    ).toEqual([
      { key: "shadowed", count: 3 },
      { key: "slotConflict" },
      { key: "pending" },
    ]);
    expect(
      layerBadges(layer({ packId: "z", managed: false }), {
        rendered: true,
        conflicts,
      }),
    ).toEqual([{ key: "unmanaged" }]);
  });

  it("finds only the conflicts naming the layer", () => {
    const conflicts: LayerSlotConflict[] = [
      { slot: "ship:JSB039", packIds: ["a", "b"] },
      { slot: "voice:MyBank", packIds: ["c"] },
    ];
    expect(conflictsOfLayer(layer({ packId: "b" }), conflicts)).toEqual([
      conflicts[0],
    ]);
    expect(conflictsOfLayer(layer({ packId: "a" }), conflicts)).toHaveLength(1);
    expect(conflictsOfLayer(layer({ packId: "d" }), conflicts)).toHaveLength(0);
  });
});

describe("render report conflict paths", () => {
  const path = (patch: Partial<LayerPathWinner> & { path: string }): LayerPathWinner => ({
    packId: null,
    shadowed: [],
    foreign: false,
    ...patch,
  });

  it("keeps only shadowed or foreign paths and caps the rows", () => {
    const paths = [
      path({ path: "a.dds" }),
      path({ path: "b.dds", shadowed: ["lower"] }),
      path({ path: "c.dds", foreign: true }),
      path({ path: "d.dds", packId: "win", shadowed: ["lower"], foreign: true }),
    ];
    const folded = conflictPaths(paths, 2);
    expect(folded.total).toBe(3);
    expect(folded.rows.map((row) => row.path)).toEqual(["b.dds", "c.dds"]);
  });
});

describe("layer category labels", () => {
  it("resolves catalog categories and on-disk kinds, unknown codes pass through", () => {
    expect(layerCategoryKey("video")).toBe("resources.cat.video");
    expect(layerCategoryKey("model")).toBe("resources.cat.model");
    expect(layerCategoryKey("textures")).toBe("resources.kind.textures");
    expect(layerCategoryKey("brand-new-category")).toBeNull();
  });
});
