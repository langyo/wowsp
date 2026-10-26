import { beforeAll, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import type { PlayerBuild } from "@/api";
import { initLocaleMessages, setLocale } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import PlayerBuildGrid from "./PlayerBuildGrid";
import { playerBuildView } from "./playerBuild";

const KITAKAZE: PlayerBuild = {
  entityId: 677453,
  shipParamsId: 4065212112,
  name: "Tester",
  modernization: [4280471472, 4262645680],
  exteriors: [4263342000, 4274876336],
  abilities: [4284653488, 0, 0],
  learnedSkills: [[], [], [], [12, 18, 20, 25, 34], [], []],
};

function view() {
  return playerBuildView(KITAKAZE, {
    dataLanguage: "en-US",
    shipType: "Destroyer",
    source: "replay",
  });
}

beforeAll(async () => {
  await initLocaleMessages();
  await setLocale("en-US");
  useLanguage().uiLocale.value = "en-US";
});

describe("PlayerBuildGrid", () => {
  it("renders the four sections the build carries", () => {
    const wrapper = mount(PlayerBuildGrid, { props: { view: view() } });
    expect(wrapper.find(".player-build").exists()).toBe(true);
    expect(wrapper.find(".player-build__head--replay").exists()).toBe(true);
    expect(wrapper.findAll(".player-build__section").length).toBe(4);
    expect(wrapper.text()).toContain("Captain skills");
    expect(wrapper.text()).toContain("14/21 pts");
    // Five picked skills on the class tree's four tier rows.
    expect(wrapper.findAll(".player-build__tile--picked").length).toBe(5);
    expect(wrapper.findAll(".player-build__tile--slot").length).toBe(2);
    expect(wrapper.findAll(".player-build__tile--signal").length).toBe(2);
    expect(wrapper.findAll(".player-build__tile--consumable").length).toBe(1);
    // The consumable tile carries its battle key and the signal flags their
    // hint text (the global tooltip reads data-hint).
    expect(wrapper.find(".player-build__key").text()).toBe("R");
    const hints = wrapper
      .findAll("[data-hint]")
      .map((el) => (el.attributes("data-hint") ?? "").replace(/\u00a0/g, " "));
    expect(hints.some((hint) => hint.includes("Main Armaments Modification 1"))).toBe(true);
  });

  it("marks the probe source and a retraining captain", () => {
    const probe = playerBuildView(
      { ...KITAKAZE, isInAdaptation: true },
      { dataLanguage: "en-US", shipType: "Destroyer", source: "probe" },
    );
    const wrapper = mount(PlayerBuildGrid, { props: { view: probe } });
    expect(wrapper.find(".player-build__head--probe").exists()).toBe(true);
    expect(wrapper.find(".player-build__note").exists()).toBe(true);
  });

  it("renders nothing for a build with no loadout data", () => {
    const empty = playerBuildView(
      { entityId: 1, shipParamsId: 4065212112, modernization: [1] },
      { dataLanguage: "en-US", shipType: "Destroyer", source: "replay" },
    );
    const wrapper = mount(PlayerBuildGrid, { props: { view: empty } });
    expect(wrapper.find(".player-build").exists()).toBe(false);
  });
});
