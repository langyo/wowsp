/** Acceptance smoke tests for the 装备选择 panel inside BuildPlanner.
 *
 *  The row-builder has its own pure suite (upgradeChainRows.test.ts); this
 *  one mounts the real planner with the real bundled chain data to pin the
 *  panel glue the user asked for:
 *   - 装备选择 sits FIRST in the rail (above 舰长技能);
 *   - one row per slot, stock anchor first, square tiles, credits under
 *     researched modules only (em dash placeholder, no fake numbers);
 *   - connector hit paths carry the research-XP tooltip;
 *   - the hull row carries the previous-tier card and every unlocking row
 *     ends in next-tier card(s);
 *   - clicking a next-tier card emits openShip with the unlocked ship id;
 *   - a ship without chain data renders the empty state.
 *
 *  Minsk (PRSD207, 4077794768) is the fixture: 5 slots, top hull unlocks
 *  Pr.48 (3971888592) and top torpedoes unlock Pr.30 (4076746192); its
 *  predecessor PRSD206 (4078843344) is the previous-tier card.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";

vi.mock("@/i18n", () => ({
  t: (key: string) => key,
  te: () => true,
  i18n: { global: { te: () => true } },
}));
vi.mock("@/i18n/useLanguage", () => ({
  useLanguage: () => ({
    dataLanguage: { value: "en-US" },
    uiLocale: { value: "en-US" },
  }),
  wgApiLanguage: (code: string) => code,
}));
vi.mock("@/api", () => ({ api: {} }));
vi.mock("@/stores/shipsUi", () => ({
  useShipsUiStore: () => ({ treeRealm: "wg", setTreeRealm: () => {} }),
}));
vi.mock("@/stores/encyclopedia", () => {
  const list = [
    {
      shipId: 4077794768,
      name: "Minsk",
      tier: 7,
      type: "Destroyer",
      nation: "ussr",
      isPremium: false,
      isSpecial: false,
      description: "",
      gameVersion: "",
      defaultProfile: null,
      images: { small: "", medium: "", large: "", contour: "" },
    },
    {
      shipId: 4078843344,
      name: "Pr. 6",
      tier: 6,
      type: "Destroyer",
      nation: "ussr",
      isPremium: false,
      isSpecial: false,
      description: "",
      gameVersion: "",
      defaultProfile: null,
      images: { small: "", medium: "", large: "", contour: "" },
    },
    {
      shipId: 3971888592,
      name: "Pr. 48",
      tier: 8,
      type: "Destroyer",
      nation: "ussr",
      isPremium: false,
      isSpecial: false,
      description: "",
      gameVersion: "",
      defaultProfile: null,
      images: { small: "", medium: "", large: "", contour: "" },
    },
  ];
  return {
    useEncyclopediaStore: () => ({
      ships: list,
      byId: new Map(list.map((ship) => [ship.shipId, ship])),
      shipDisplayName: (ship: { name: string }) => ship.name,
    }),
  };
});
vi.mock("@wowsp/holo", () => ({ tierToRoman: (tier: number) => String(tier) }));
vi.mock("@celestia-island/hikari", () => {
  const stub = (name: string) =>
    defineComponent({
      name,
      setup(_, { slots }) {
        return () => h("div", { class: "stub-" + name }, slots.default?.());
      },
    });
  return { HkButton: stub("HkButton"), HkTabs: stub("HkTabs") };
});
vi.mock("@/components/base/AssetImage", () => ({
  AssetImage: defineComponent({
    name: "AssetImage",
    setup: () => () => h("span", { class: "asset-image-stub" }),
  }),
}));
vi.mock("@/components/base/NationFlag", () => ({
  default: defineComponent({
    name: "NationFlag",
    setup: () => () => h("span", { class: "nation-flag-stub" }),
  }),
}));
vi.mock("./DataObserver", () => ({
  default: defineComponent({ name: "DataObserver", setup: () => () => null }),
}));

import BuildPlanner from "./BuildPlanner";
import { emptyBuild } from "./modifierPipeline";
import type { ShipInfo } from "@/api";

enableAutoUnmount(afterEach);

const MINSK = 4077794768;
const PR_48 = 3971888592;

function minsk(): ShipInfo {
  return {
    shipId: MINSK,
    name: "Minsk",
    tier: 7,
    type: "Destroyer",
    nation: "ussr",
    isPremium: false,
    isSpecial: false,
    description: "",
    gameVersion: "",
    defaultProfile: null,
    images: { small: "", medium: "", large: "", contour: "" },
  };
}

function mountParts(ship: ShipInfo = minsk()) {
  return mount(BuildPlanner, {
    props: { ship, build: emptyBuild(), initialSection: "parts" },
  });
}

describe("BuildPlanner 装备选择 panel", () => {
  it("puts 装备选择 at the top of the rail, above 舰长技能", () => {
    const wrapper = mountParts();
    const rail = wrapper.findAll(".planner-v__rail-btn");
    expect(rail).toHaveLength(6);
    expect(rail[0].text()).toContain("ships.skills.tabParts");
    expect(rail[1].text()).toContain("ships.skills.tabSkills");
  });

  it("renders one row per slot with the stock module in the first column", () => {
    const wrapper = mountParts();
    const rows = wrapper.findAll(".planner-v__parts-row");
    expect(rows).toHaveLength(5);
    expect(rows[0].attributes("data-role")).toBe("hull");
    // Minsk: 2 + 2 + 1 + 1 + 2 modules; the stock modules carry no credits.
    expect(wrapper.findAll(".planner-v__parts-tile")).toHaveLength(8);
    const credits = wrapper.findAll(".planner-v__parts-credits");
    expect(credits).toHaveLength(3);
    // The buy-credit figures come from the server price-catalog capture: an
    // em dash until the bundle carries them, a grouped number afterwards.
    for (const credit of credits) expect(credit.text()).toMatch(/^(—|\d[\d,]*)$/);
    // The hull stock anchor is the GameParams stock module.
    const hullCells = rows[0].findAll(".planner-v__parts-cell");
    expect(hullCells[0].attributes("data-module")).toBe("PRUH603_D7_HULL_STOCK_2");
    expect(hullCells[0].find(".planner-v__parts-role").text()).toBe("ships.parts.stockHull");
  });

  it("draws centred connectors with the research-XP tooltip", () => {
    const wrapper = mountParts();
    const hits = wrapper.findAll(".planner-v__parts-edge-hit");
    expect(hits).toHaveLength(3);
    expect(hits[0].attributes("data-hint")).toBe("ships.parts.xpNeeded");
    // Square tiles (the CSS enforces the side; the DOM carries one per cell).
    expect(wrapper.find(".planner-v__parts-tile").exists()).toBe(true);
  });

  it("shows the previous-tier card on the first row and next-tier cards after unlocking rows", () => {
    const wrapper = mountParts();
    const prev = wrapper.findAll(".planner-v__parts-prev .planner-v__parts-ship");
    expect(prev).toHaveLength(1);
    expect(prev[0].find(".planner-v__parts-ship-name").text()).toBe("Pr. 6");
    // Hull -> Pr.48, torpedoes -> Pr.30: two extension cards, each after the
    // row that unlocks it.
    const cards = wrapper.findAll(".planner-v__parts-next .planner-v__parts-ship");
    expect(cards).toHaveLength(2);
    expect(cards[0].find(".planner-v__parts-ship-name").text()).toBe("Pr. 48");
    // The hover card names the click action.
    expect(cards[0].attributes("data-hint-card")).toContain("ships.parts.openShipHint");
  });

  it("emits openShip when a next-tier card is clicked", async () => {
    const wrapper = mountParts();
    const card = wrapper.findAll(".planner-v__parts-next .planner-v__parts-ship")[0];
    await card.trigger("click");
    expect(wrapper.emitted("openShip")).toEqual([[PR_48]]);
  });

  it("renders the empty state when the ship has no chain data", () => {
    const wrapper = mountParts({ ...minsk(), shipId: 123456789 });
    expect(wrapper.find(".planner-v__parts").exists()).toBe(false);
    expect(wrapper.find(".planner-v__empty").text()).toBe("ships.parts.empty");
  });
});
