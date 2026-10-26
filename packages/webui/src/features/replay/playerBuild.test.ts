import { beforeAll, describe, expect, it } from "vitest";

import type { PlayerBuild } from "@/api";
import { initLocaleMessages } from "@/i18n";
import {
  gameparamCode,
  joinPlayerBuild,
  learnedSkillRowIndex,
  playerBuildHasContent,
  playerBuildView,
} from "./playerBuild";

/** A real Kitakaze decode (the reference capture's recorder): 6 upgrades,
 *  4 mounted consumables and the destroyer skill row. */
const KITAKAZE: PlayerBuild = {
  entityId: 677453,
  shipParamsId: 4065212112,
  name: "Tester",
  modernization: [4280471472, 4262645680], // slot 5 first, slot 0 second
  exteriors: [4263342000, 4274876336], // PCEF030, PCEF019
  abilities: [4284653488, 0, 0],
  learnedSkills: [[], [], [], [12, 18, 20, 25, 34], [], []],
};

const viewFor = (build: PlayerBuild, shipType: string | null) =>
  playerBuildView(build, { dataLanguage: "en-US", shipType, source: "replay" });

beforeAll(async () => {
  await initLocaleMessages();
});

describe("learned-skill species rows", () => {
  // Empirically derived from 364 decoded builds over 31 local 15.9 replays
  // (see playerBuild.ts's header): the row -> class map is pinned here so a
  // future decoder change cannot silently swap two classes.
  it("maps every ship class to its wire row", () => {
    expect(learnedSkillRowIndex("AirCarrier")).toBe(0);
    expect(learnedSkillRowIndex("Battleship")).toBe(1);
    expect(learnedSkillRowIndex("Cruiser")).toBe(2);
    expect(learnedSkillRowIndex("Destroyer")).toBe(3);
    expect(learnedSkillRowIndex("Auxiliary")).toBe(4);
    expect(learnedSkillRowIndex("Submarine")).toBe(5);
  });

  it("returns no row for unknown classes", () => {
    expect(learnedSkillRowIndex(null)).toBeNull();
    expect(learnedSkillRowIndex(undefined)).toBeNull();
    expect(learnedSkillRowIndex("NotAClass")).toBeNull();
  });

  it("uses the CURRENT ship class's row only", () => {
    const dd = viewFor(KITAKAZE, "Destroyer");
    expect(dd.skills.length).toBe(5);
    expect(dd.skillPoints).toBe(14);
    expect(dd.skillBudget).toBe(21);
    expect(dd.skills.map((s) => s.code)).toContain("DetectionVisibilityRange");
    // A cruiser row is empty in this build: no skills, never another row's.
    expect(viewFor(KITAKAZE, "Cruiser").skills.length).toBe(0);
  });

  it("keeps auxiliary-row skills unplaced (no baked tree for AX)", () => {
    const ax: PlayerBuild = {
      entityId: 1,
      shipParamsId: 1,
      learnedSkills: [[], [], [], [], [1], []],
    };
    const view = viewFor(ax, "Auxiliary");
    // The row is read and priced (Auxiliary tier 3 for ordinal 1) but the
    // skill lands in the chips, not on a borrowed cruiser tree.
    expect(view.unplacedSkills.length).toBe(1);
    expect(view.skills.length).toBe(0);
    expect(view.skillPoints).toBe(3);
  });

  it("prices a submarine build off row 5", () => {
    const sub: PlayerBuild = {
      entityId: 1,
      shipParamsId: 3434526416,
      learnedSkills: [[], [], [], [], [], [75, 78]],
    };
    const view = viewFor(sub, "Submarine");
    expect(view.skills.map((s) => s.code)).toEqual([
      "SubmarineBatteryCapacity",
      "SubmarineSpeed",
    ]);
    expect(view.skillPoints).toBe(6);
  });
});

describe("build view model", () => {
  it("resolves numeric ids through the baked map", () => {
    expect(gameparamCode(4262645680)).toBe("PCM030_MainWeapon_Mod_I");
    expect(gameparamCode(4274876336)).toBe("PCEF019_JW1_SignalFlag");
    expect(gameparamCode(1)).toBeNull();
    expect(gameparamCode(null)).toBeNull();
  });

  it("orders upgrades by their in-game slot", () => {
    const view = viewFor(KITAKAZE, "Destroyer");
    expect(view.upgrades.map((u) => u.slot)).toEqual([0, 5]);
    // The catalog uses a non-breaking space before the level digit.
    const names = view.upgrades.map((u) => u.label.replace(/\u00a0/g, " "));
    expect(names).toEqual([
      "Main Armaments Modification 1",
      "Main Battery Modification 3",
    ]);
    expect(view.upgrades.every((u) => u.iconUrl.endsWith(".webp"))).toBe(true);
  });

  it("keeps only PCEF exterior ids as signal flags", () => {
    const view = viewFor(KITAKAZE, "Destroyer");
    expect(view.signals.map((s) => s.index)).toEqual(["PCEF030", "PCEF019"]);
    expect(view.signals[1].iconUrl).toContain("PCEF019_JW1_SignalFlag");
  });

  it("maps mounted AbilitySlot ids to consumable families and keys", () => {
    const view = viewFor(KITAKAZE, "Destroyer");
    expect(view.consumables.length).toBe(1);
    expect(view.consumables[0].slot).toBe(0);
    expect(view.consumables[0].key).toBe("R");
    expect(view.consumables[0].family).toBe("CrashCrew");
    expect(view.consumables[0].iconUrl).not.toBeNull();
  });

  it("places picked skills on the class tree's tier rows", () => {
    const view = viewFor(KITAKAZE, "Destroyer");
    const tier4 = view.skillRows[3];
    expect(tier4.tier).toBe(4);
    const cells = tier4.cells.filter((cell) => cell != null);
    expect(cells.length).toBe(2); // DetectionVisibilityRange + DetectionDirection
    expect(view.skillColumns).toBe(6);
  });

  it("keeps unknown skills as unplaced chips", () => {
    const build: PlayerBuild = {
      entityId: 1,
      shipParamsId: 4065212112,
      learnedSkills: [[], [], [], [999], [], []],
    };
    const view = viewFor(build, "Destroyer");
    expect(view.skills.length).toBe(0);
    expect(view.unplacedSkills.length).toBe(1);
    expect(view.skillPoints).toBe(0);
  });

  it("skips ids the bake does not know", () => {
    const build: PlayerBuild = {
      entityId: 1,
      shipParamsId: 4065212112,
      modernization: [1],
      exteriors: [2],
      abilities: [3],
    };
    const view = viewFor(build, "Destroyer");
    expect(playerBuildHasContent(view)).toBe(false);
  });

  it("reports whether the grid has content", () => {
    expect(playerBuildHasContent(null)).toBe(false);
    expect(playerBuildHasContent(viewFor(KITAKAZE, "Destroyer"))).toBe(true);
  });
});

describe("roster join", () => {
  it("prefers the named build", () => {
    const named = KITAKAZE;
    const out = joinPlayerBuild([named], "Tester", 4065212112);
    expect(out).toBe(named);
  });

  it("falls back to a unique unnamed build on the same ship", () => {
    const anonymous: PlayerBuild = { entityId: 1, shipParamsId: 4065212112 };
    expect(joinPlayerBuild([anonymous], "SomeoneElse", 4065212112)).toBe(anonymous);
  });

  it("never guesses between two unnamed builds of the same hull", () => {
    const a: PlayerBuild = { entityId: 1, shipParamsId: 4065212112 };
    const b: PlayerBuild = { entityId: 2, shipParamsId: 4065212112 };
    expect(joinPlayerBuild([a, b], "SomeoneElse", 4065212112)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(joinPlayerBuild([], "X", 1)).toBeNull();
    expect(joinPlayerBuild([KITAKAZE], "Other", 999)).toBeNull();
  });
});
