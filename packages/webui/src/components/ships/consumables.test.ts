/** Tests for the consumables card extraction: the GameParams ShipAbilities
 *  slot layout joined with the baked ability-entity dictionary
 *  (data/consumable_details.json). Fixtures reference REAL baked entities so
 *  a rebake that drifts (family normalization, charges semantics, auto
 *  flag) fails loudly; the slot layout itself is inline minimal. */
import { beforeAll, describe, expect, it } from "vitest";

import { setLocale } from "@/i18n";
import {
  SLOT_KEYS,
  buildConsumableSlots,
  consumableHintCard,
  consumableTone,
  dataCodeOf,
} from "./consumables";

// The hint-card assertions pin the zh-CN strings. setLocale is async (the
// zh-CN bundle loads lazily), so the switch must be awaited first.
beforeAll(async () => {
  await setLocale("zh-CN");
});

// Yamato-shaped: slot 0 DCP (unlimited on the tree variant), slot 1 empty,
// slot 2 a spotter/fighter switch group, slot 3 empty, plus the special
// slot the game marks isSpecial — which must never surface.
const yamatoAbilities = {
  AbilitySlot0: {
    abils: [["PCY009_CrashCrewPremium", "B_Gold"]],
    isSpecial: false,
    slot: 0,
  },
  AbilitySlot1: { abils: [], isSpecial: false, slot: 1 },
  AbilitySlot2: {
    abils: [
      ["PCY013_SpotterPremium", "Default"],
      ["PCY012_FighterPremium", "Fighter_1"],
    ],
    isSpecial: false,
    slot: 2,
  },
  AbilitySlot3: { abils: [], isSpecial: false, slot: 3 },
  AbilitySpecial: { abils: [], isSpecial: true, slot: 4 },
};

// CV-shaped: the auto damage control (defaultActivationMode AUTO in
// GameParams) — the slot carries no manual battle key.
const cvAbilities = {
  AbilitySlot0: { abils: [["PCY037_CrashCrewAuto", "CV"]], isSpecial: false, slot: 0 },
};

// Range-bearing families: hydro quotes ship AND torpedo detection, radar
// quotes a single distance, smoke quotes its screen radius (bake metres).
const hydroAbilities = {
  AbilitySlot1: {
    abils: [["PCY008_SonarSearch", "Blue_Aster"]],
    isSpecial: false,
    slot: 1,
  },
};
const radarAbilities = {
  AbilitySlot2: {
    abils: [["PCY019_RLSSearch", "Default"]],
    isSpecial: false,
    slot: 2,
  },
};
const smokeAbilities = {
  AbilitySlot3: {
    abils: [["PCY006_SmokeGenerator", "Cruiser"]],
    isSpecial: false,
    slot: 3,
  },
};

describe("dataCodeOf", () => {
  it("maps the 素材翻译 locales onto the baked short codes", () => {
    expect(dataCodeOf("zh-CN")).toBe("zh");
    expect(dataCodeOf("zh-SG")).toBe("zh");
    expect(dataCodeOf("zh-TW")).toBe("tw");
    expect(dataCodeOf("ja-JP")).toBe("ja");
    expect(dataCodeOf("en-US")).toBe("en");
    // Data languages without a baked dict (ko/ru/fr/es) fall back to English.
    expect(dataCodeOf("ru-RU")).toBe("en");
  });
});

describe("consumableTone", () => {
  it("colors by purpose prefix, so family clones inherit the tint", () => {
    expect(consumableTone("CrashCrew")).toBe("danger");
    expect(consumableTone("CrashCrewAuto")).toBe("danger");
    expect(consumableTone("RegenCrew")).toBe("success");
    expect(consumableTone("RLSSearch")).toBe("warning");
    expect(consumableTone("SonarSearch")).toBe("info");
    expect(consumableTone("SmokeGenerator")).toBe("default");
    // Suffixed clones ride their family's rule.
    expect(consumableTone("SmokeGeneratorPremium_TimeBased")).toBe("default");
    expect(consumableTone("SpeedBooster_FA2022")).toBe("primary");
    // Unknown (event/PVP) families stay neutral.
    expect(consumableTone("MindControl")).toBe("default");
  });
});

describe("buildConsumableSlots", () => {
  it("returns nothing without a ShipAbilities block", () => {
    expect(buildConsumableSlots(null, "zh-CN")).toEqual([]);
    expect(buildConsumableSlots({}, "zh-CN")).toEqual([]);
    expect(buildConsumableSlots({ ShipAbilities: {} }, "zh-CN")).toEqual([]);
  });

  it("joins slots with the baked entities in slot order", () => {
    const groups = buildConsumableSlots(
      { ShipAbilities: yamatoAbilities },
      "zh-CN",
    );
    // Empty slots (1, 3) and the isSpecial slot drop out.
    expect(groups.map((g) => g.slot)).toEqual([0, 2]);
    const dcp = groups[0]!.entries[0]!;
    expect(dcp.entity).toBe("PCY009_CrashCrewPremium");
    expect(dcp.family).toBe("CrashCrew");
    // The tree DCP variant is unlimited with an 80 s cooldown.
    expect(dcp.charges).toBe(-1);
    expect(dcp.reload).toBe(80);
    expect(dcp.tone).toBe("danger");
    expect(dcp.iconUrl).toBeTruthy();
    // Names follow the data language (zh-CN), descriptions ride along.
    expect(dcp.name).toBe("伤害控制小组");
    expect(dcp.desc).toContain("扑灭起火");
  });

  it("keys slots by SLOT INDEX, not render order (empty slots keep theirs)", () => {
    const groups = buildConsumableSlots(
      { ShipAbilities: yamatoAbilities },
      "zh-CN",
    );
    expect(SLOT_KEYS).toEqual(["R", "T", "Y", "U", "I"]);
    expect(groups[0]!.key).toBe("R");
    expect(groups[1]!.key).toBe("Y"); // slot 2 — the empty slot 1 keeps T
  });

  it("keeps the switch-group alternatives of one slot together", () => {
    const groups = buildConsumableSlots(
      { ShipAbilities: yamatoAbilities },
      "zh-CN",
    );
    const slot = groups[1]!;
    expect(slot.entries.map((e) => e.family)).toEqual(["Spotter", "Fighter"]);
    // Spotter Default: 4 charges / 100 s / 240 s cooldown.
    expect(slot.entries[0]!.charges).toBe(4);
    expect(slot.entries[0]!.work).toBe(100);
  });

  it("withholds the battle key when every alternative auto-triggers", () => {
    const groups = buildConsumableSlots({ ShipAbilities: cvAbilities }, "zh-CN");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBeNull();
    expect(groups[0]!.entries[0]!.auto).toBe(true);
  });

  it("drops unresolvable entity/variant pairs instead of lying", () => {
    const groups = buildConsumableSlots(
      {
        ShipAbilities: {
          AbilitySlot0: {
            abils: [
              ["PCY009_CrashCrewPremium", "B_Gold"],
              ["PCY999_NotBakedAnywhere", "Default"],
              ["PCY013_SpotterPremium", "VariantTheBakeNeverSaw"],
            ],
            isSpecial: false,
            slot: 0,
          },
        },
      },
      "zh-CN",
    );
    expect(groups[0]!.entries).toHaveLength(1);
  });
});

describe("consumableHintCard", () => {
  it("builds the structured hover card (badge, charges, timings, desc)", () => {
    const [group] = buildConsumableSlots(
      { ShipAbilities: yamatoAbilities },
      "zh-CN",
    )!;
    const card = consumableHintCard(group!.entries[0]!, group!);
    expect(card.title).toBe("伤害控制小组");
    expect(card.badge).toBe("R");
    expect(card.iconUrl).toBeTruthy();
    expect(card.subtitle).toContain("第 1 槽");
    expect(card.rows![0]).toEqual({ label: "数量", value: "不限量" });
    expect(card.rows).toContainEqual({ label: "装填时间", value: "80 s" });
    expect(card.note).toContain("扑灭起火");
  });

  it("counts limited charges and skips absent timings", () => {
    const groups = buildConsumableSlots(
      { ShipAbilities: yamatoAbilities },
      "zh-CN",
    );
    const slot = groups[1]!; // slot 2 — the spotter/fighter switch group
    const spotter = slot.entries[0]!;
    const card = consumableHintCard(spotter, slot);
    expect(card.rows![0]).toEqual({ label: "数量", value: "× 4" });
    expect(card.rows!.map((r) => r.label)).toEqual(["数量", "作用时间", "装填时间"]);

    // The same-slot fighter: its logic.radius is the PATROL radius, so the
    // row carries the fighter label, never the smoke-screen one.
    const fighterCard = consumableHintCard(slot.entries[1]!, slot);
    expect(fighterCard.rows).toContainEqual({ label: "巡逻半径", value: "3 km" });
    expect(fighterCard.rows!.map((r) => r.label)).not.toContain("烟幕半径");
  });

  it("quotes hydro's ship and torpedo detection as a range pair", () => {
    const [group] = buildConsumableSlots(
      { ShipAbilities: hydroAbilities },
      "zh-CN",
    )!;
    const card = consumableHintCard(group!.entries[0]!, group!);
    // Blue_Aster hydro: 6000 m ship / 4000 m torpedo (BW units × 30 at bake).
    expect(card.rows).toContainEqual({ label: "对舰生效距离", value: "6 km" });
    expect(card.rows).toContainEqual({ label: "对鱼雷生效距离", value: "4 km" });
    expect(card.rows!.map((r) => r.label)).toEqual([
      "数量",
      "作用时间",
      "对舰生效距离",
      "对鱼雷生效距离",
      "装填时间",
    ]);
  });

  it("quotes radar's single distance and smoke's screen radius", () => {
    const [radar] = buildConsumableSlots(
      { ShipAbilities: radarAbilities },
      "zh-CN",
    )!;
    const radarCard = consumableHintCard(radar!.entries[0]!, radar!);
    expect(radarCard.rows).toContainEqual({ label: "生效距离", value: "8.1 km" });

    const [smoke] = buildConsumableSlots(
      { ShipAbilities: smokeAbilities },
      "zh-CN",
    )!;
    const smokeCard = consumableHintCard(smoke!.entries[0]!, smoke!);
    expect(smokeCard.rows).toContainEqual({ label: "烟幕半径", value: "0.5 km" });
    expect(smokeCard.rows!.map((r) => r.label)).toEqual([
      "数量",
      "作用时间",
      "烟幕半径",
      "装填时间",
    ]);
  });
});
