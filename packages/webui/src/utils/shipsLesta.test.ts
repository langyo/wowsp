/** Tests for the Lesta ship overlay against the generated data file: every
 *  Lesta-only tech-tree ship must carry a usable entry (name in every
 *  curated language, a WG-shaped profile with the numbers the cards and the
 *  planner gate on), and the overlay must stay a strict subset of the Lesta
 *  tree — no WG-covered ship, no id outside it. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { useShipsUiStore } from "@/stores/shipsUi";
import { allTechTreeNodes } from "@/utils/techTreeData";
import { lestaToShipInfo, loadShipsLesta, withLestaOverlay } from "./shipsLesta";
import type { ShipInfo } from "@/api";

beforeEach(() => {
  setActivePinia(createPinia());
  useShipsUiStore().setTreeRealm("lesta");
});

describe("generated overlay data", () => {
  it("covers every Lesta-only tech-tree ship", async () => {
    const overlay = await loadShipsLesta();
    const overlayIds = new Set(Object.keys(overlay.ships).map(Number));
    const lestaTree = allTechTreeNodes("lesta");
    const wgTree = allTechTreeNodes("wg");
    const wgIndexes = new Set(Object.values(wgTree).map((n) => n.index));

    for (const node of Object.values(lestaTree)) {
      if (wgIndexes.has(node.index)) continue;
      expect(overlayIds.has(node.shipId), `missing overlay entry for ${node.index}`).toBe(true);
    }
    // And nothing beyond the tree's Lesta-only set.
    const treeIds = new Set(
      Object.values(lestaTree)
        .filter((n) => !wgIndexes.has(n.index))
        .map((n) => n.shipId),
    );
    for (const id of overlayIds) {
      expect(treeIds.has(id), `overlay id ${id} is not a Lesta-only tree ship`).toBe(true);
    }
  });

  it("carries names, tiers and WG-shaped profiles", async () => {
    const overlay = await loadShipsLesta();
    expect(Object.keys(overlay.ships).length).toBeGreaterThan(0);
    for (const [id, entry] of Object.entries(overlay.ships)) {
      expect(entry.names["en-US"], `${id} en-US name`).toBeTruthy();
      expect(entry.names["ru-RU"], `${id} ru-RU name`).toBeTruthy();
      expect(entry.names["zh-CN"], `${id} zh-CN name`).toBeTruthy();
      expect(entry.tier, `${id} tier`).toBeGreaterThanOrEqual(1);
      const dp = entry.defaultProfile as Record<string, any> | null;
      if (dp) {
        expect(dp.hull?.health, `${id} hull.health`).toBeGreaterThan(0);
        expect(dp.mobility?.max_speed, `${id} max_speed`).toBeGreaterThan(0);
        expect(dp.concealment?.detect_distance_by_ship, `${id} detect`).toBeGreaterThan(0);
      }
    }
  });

  it("converts to ShipInfo with a localized name and empty CDN images", async () => {
    const overlay = await loadShipsLesta();
    const [id, entry] = Object.entries(overlay.ships)[0]!;
    const info = lestaToShipInfo(Number(id), overlay, entry, "zh-CN");
    expect(info.name).toBe(entry.names["zh-CN"] ?? entry.names["en-US"]);
    expect(info.images).toEqual({ small: "", medium: "", large: "", contour: "" });
    expect(info.gameVersion).toBe(overlay.gameVersion);
  });
});

describe("withLestaOverlay merge", () => {
  it("appends only missing ships while the realm is lesta", async () => {
    const overlay = await loadShipsLesta();
    const [firstId, firstEntry] = Object.entries(overlay.ships)[0]!;
    const existing: ShipInfo[] = [lestaToShipInfo(Number(firstId), overlay, firstEntry, "en-US")];
    const merged = await withLestaOverlay(existing, "zh-CN");
    expect(merged.length).toBe(Object.keys(overlay.ships).length);
    // The WG-known entry is kept as-is, not duplicated.
    expect(merged.filter((s) => s.shipId === Number(firstId))).toHaveLength(1);
  });

  it("returns the WG list untouched outside the Lesta realm", async () => {
    useShipsUiStore().setTreeRealm("wg");
    const list: ShipInfo[] = [{ shipId: 1, name: "WG ship" } as ShipInfo];
    expect(await withLestaOverlay(list, "zh-CN")).toBe(list);
  });
});
