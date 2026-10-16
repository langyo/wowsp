/** Tests for the Lesta ship overlay against the generated data file: every
 *  Lesta-only tech-tree ship must carry a usable entry (name in every
 *  curated language, a WG-shaped profile with the numbers the cards and the
 *  planner gate on), and the overlay must never cover a WG-tree ship — the
 *  non-tree premium/event fleet (Lesta-only premiums, CLR clones, event
 *  hulls) rides along beyond the tree on top of that.
 *
 *  The WG-only roster artifact (ships_wg_only.json) is pinned here too: it
 *  must partition the split with the overlay (disjoint from it and from the
 *  Lesta tree), carry the WG-only research lines and premiums, and spare
 *  the hulls the Lesta client hosts in non-tree groups. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useShipsUiStore } from "@/stores/shipsUi";
import { allTechTreeNodes } from "@/utils/techTreeData";
import { lestaToShipInfo, loadShipsLesta, withLestaOverlay, type WgOnlyRoster } from "./shipsLesta";
import type { ShipInfo } from "@/api";
import wgOnlyRoster from "@/data/ships_wg_only.json";

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
    // And no WG-tree ship ever rides in (the tree cohort is the Lesta-only
    // subset; the non-tree premium/event fleet must also stay clear of the
    // WG tree's ids — WG covers those).
    const wgTreeIds = new Set(Object.values(wgTree).map((n) => n.shipId));
    for (const id of overlayIds) {
      expect(wgTreeIds.has(id), `overlay id ${id} collides with a WG-tree ship`).toBe(false);
    }
  });

  it("carries the non-tree premium/event fleet beyond the tree set", async () => {
    const overlay = await loadShipsLesta();
    const lestaTree = allTechTreeNodes("lesta");
    const treeIds = new Set(Object.values(lestaTree).map((n) => n.shipId));
    const beyond = Object.entries(overlay.ships).filter(([id]) => !treeIds.has(Number(id)));
    // The Lesta-only premiums, CLR clones and event hulls (Koschei, the
    // Lukodrager pair, the ch_dragons family, …) — 100+ ships, not a rounding
    // error of the tree walk.
    expect(beyond.length).toBeGreaterThan(100);
    for (const [id, entry] of beyond) {
      expect(entry.tier, `${id} tier`).toBeGreaterThanOrEqual(1);
      expect(entry.names["en-US"], `${id} en-US name`).toBeTruthy();
      expect(entry.names["ru-RU"], `${id} ru-RU name`).toBeTruthy();
      expect(entry.isPremium || entry.isSpecial, `${id} premium/special flag`).toBe(true);
    }
    // The curated zh pass covers all but a small deliberately-English tail
    // (event internals, untranslatable working names) — a regen that drops
    // the curation file would fall far below this floor.
    const zhCount = beyond.filter(([, e]) => e.names["zh-CN"]).length;
    expect(zhCount, "curated zh-CN coverage of the port fleet").toBeGreaterThanOrEqual(125);
  });

  it("carries names, tiers and WG-shaped profiles", async () => {
    const overlay = await loadShipsLesta();
    expect(Object.keys(overlay.ships).length).toBeGreaterThan(0);
    const lestaTree = allTechTreeNodes("lesta");
    const treeIds = new Set(Object.values(lestaTree).map((n) => n.shipId));
    for (const [id, entry] of Object.entries(overlay.ships)) {
      expect(entry.names["en-US"], `${id} en-US name`).toBeTruthy();
      expect(entry.names["ru-RU"], `${id} ru-RU name`).toBeTruthy();
      // The tree cohort is fully curated into Chinese; the premium/event
      // fleet carries ru+en until curation catches up.
      if (treeIds.has(Number(id))) {
        expect(entry.names["zh-CN"], `${id} zh-CN name`).toBeTruthy();
      }
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

describe("generated WG-only roster data", () => {
  const roster = wgOnlyRoster as WgOnlyRoster;
  const rosterIds = () => new Set(Object.keys(roster.ships).map(Number));
  const wgTree = () => Object.values(allTechTreeNodes("wg"));

  it("is a sizeable roster with well-formed entries", () => {
    const ids = rosterIds();
    // Full-dump diff of two diverged clients — hundreds of hulls, not a
    // tree-scale rounding error (the artifact also carries premiums and
    // collabs no tree records).
    expect(ids.size).toBeGreaterThan(200);
    for (const [id, entry] of Object.entries(roster.ships)) {
      expect(Number.isFinite(Number(id)), `${id} key`).toBe(true);
      expect(entry.index, `${id} index`).toMatch(/^P[A-Z]{3}\d+$/);
    }
  });

  it("never flags a ship the Lesta side has", async () => {
    const ids = rosterIds();
    // Disjoint from the Lesta overlay ids (Lesta-only ships) and from the
    // Lesta tree's ids — the artifact and the overlay partition the split.
    const overlay = await loadShipsLesta();
    for (const id of Object.keys(overlay.ships)) {
      expect(ids.has(Number(id)), `overlay id ${id} leaked into the WG-only roster`).toBe(false);
    }
    for (const node of Object.values(allTechTreeNodes("lesta"))) {
      expect(ids.has(node.shipId), `Lesta-tree id ${node.index} leaked`).toBe(false);
    }
  });

  it("carries the WG-only research lines but not hulls Lesta hosts anyway", () => {
    const ids = rosterIds();
    // The whole Commonwealth line hides (Lesta never grew it)...
    for (const n of wgTree().filter((n) => n.nation === "commonwealth")) {
      expect(ids.has(n.shipId), n.index).toBe(true);
    }
    // ...while Piemonte (PISC111) stays out: its index IS in the Lesta
    // client's dump, hosted as the ultimate-group clone — same for the
    // Pr.30 special (PRSD208). Only the tree-derived fallback set, which
    // cannot see non-tree groups, treats those two as WG-only.
    const piemonte = wgTree().find((n) => n.index === "PISC111")!;
    const pr30 = wgTree().find((n) => n.index === "PRSD208")!;
    expect(piemonte).toBeDefined();
    expect(pr30).toBeDefined();
    expect(ids.has(piemonte.shipId)).toBe(false);
    expect(ids.has(pr30.shipId)).toBe(false);
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

  it("drops the WG-only research lines while the realm is lesta", async () => {
    // The Commonwealth line exists only in the WG tree; 河内 (PJSB001) is a
    // hull both clients share — the Lesta-mode list keeps the shared hull
    // and hides the WG-exclusive one.
    const wgTree = Object.values(allTechTreeNodes("wg"));
    const cw = wgTree.find((n) => n.nation === "commonwealth")!;
    const shared = wgTree.find((n) => n.index === "PJSB001")!;
    const list: ShipInfo[] = [
      { shipId: cw.shipId, name: cw.name } as ShipInfo,
      { shipId: shared.shipId, name: shared.name } as ShipInfo,
    ];
    const merged = await withLestaOverlay(list, "en-US");
    expect(merged.some((s) => s.shipId === cw.shipId)).toBe(false);
    expect(merged.some((s) => s.shipId === shared.shipId)).toBe(true);
  });

  it("drops WG-only premiums no tree records, via the roster artifact", async () => {
    // The roster diff sees what the trees cannot: WG premiums and collabs
    // absent from both trees hide too. Pick any roster id the WG tree does
    // not carry to prove the filter works beyond the tree-derived set.
    const wgTreeIds = new Set(Object.values(allTechTreeNodes("wg")).map((n) => n.shipId));
    const premium = Object.keys((wgOnlyRoster as WgOnlyRoster).ships)
      .map(Number)
      .find((id) => !wgTreeIds.has(id))!;
    expect(premium).toBeDefined();
    const list: ShipInfo[] = [{ shipId: premium, name: "WG-only premium" } as ShipInfo];
    const merged = await withLestaOverlay(list, "en-US");
    expect(merged.some((s) => s.shipId === premium)).toBe(false);
  });

  it("keeps hulls the Lesta client hosts in non-tree groups", async () => {
    // Piemonte (PISC111): a WG-tree researchable node, but Lesta's dump
    // hosts the index as its ultimate-group clone — the roster artifact
    // (unlike the tree-derived fallback set) keeps it listed in Lesta mode.
    const piemonte = Object.values(allTechTreeNodes("wg")).find((n) => n.index === "PISC111")!;
    expect(piemonte).toBeDefined();
    const list: ShipInfo[] = [{ shipId: piemonte.shipId, name: piemonte.name } as ShipInfo];
    const merged = await withLestaOverlay(list, "en-US");
    expect(merged.some((s) => s.shipId === piemonte.shipId)).toBe(true);
  });

  it("falls back to the tree-derived set when the roster chunk fails to load", async () => {
    // Degraded build (roster module missing): the tree-derived set stands
    // in — it still hides the WG-only research lines, but is blind to
    // non-tree groups, so Piemonte hides too. That is the fallback's
    // documented trade-off; the roster artifact refines it when present.
    vi.resetModules();
    vi.doMock("@/data/ships_wg_only.json", () => Promise.reject(new Error("chunk missing")));
    try {
      const { withLestaOverlay: fallbackOverlay } = await import("./shipsLesta");
      const { createPinia: mkPinia, setActivePinia: setActive } = await import("pinia");
      const { useShipsUiStore: useShipsUi } = await import("@/stores/shipsUi");
      setActive(mkPinia());
      useShipsUi().setTreeRealm("lesta");

      const wgTree = Object.values(allTechTreeNodes("wg"));
      const cw = wgTree.find((n) => n.nation === "commonwealth")!;
      const piemonte = wgTree.find((n) => n.index === "PISC111")!;
      const shared = wgTree.find((n) => n.index === "PJSB001")!;
      const merged = await fallbackOverlay(
        [cw, piemonte, shared].map((n) => ({ shipId: n.shipId, name: n.name }) as ShipInfo),
        "en-US",
      );
      expect(merged.some((s) => s.shipId === cw.shipId)).toBe(false);
      expect(merged.some((s) => s.shipId === piemonte.shipId)).toBe(false);
      expect(merged.some((s) => s.shipId === shared.shipId)).toBe(true);
    } finally {
      vi.doUnmock("@/data/ships_wg_only.json");
      vi.resetModules();
    }
  });

  it("returns the WG list untouched outside the Lesta realm", async () => {
    useShipsUiStore().setTreeRealm("wg");
    const cw = Object.values(allTechTreeNodes("wg")).find((n) => n.nation === "commonwealth")!;
    const list: ShipInfo[] = [{ shipId: 1, name: "WG ship" } as ShipInfo, { shipId: cw.shipId, name: cw.name } as ShipInfo];
    expect(await withLestaOverlay(list, "zh-CN")).toBe(list);
  });
});
