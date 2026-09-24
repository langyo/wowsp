/** Tests for the baked live-stats accessors. The assertions pin the values
 *  for a handful of well-known ships (numbers come from the WG encyclopedia /
 *  GameParams via scripts/extract_ship_live_stats.py) so a rebake that drifts
 *  or an i18n key rename fails loudly here. */
import { describe, expect, it } from "vitest";

import { setLocale } from "@/i18n";
import {
  formatShipParams,
  formatShipSpecGroups,
  hasShipLiveStats,
  isBadgeConsumable,
  isKnownConsumable,
  shipConsumableLabel,
  shipLiveStats,
  shipTypeShort,
  shipUpgradeLabel,
  tierRoman,
} from "./shipLiveStats";

// The label/format assertions below pin the zh-CN strings.
setLocale("zh-CN");

// Montana, Shimakaze, U-2501, Yamato — game-numeric shipIds.
const MONTANA = "4277090288";
const SHIMAKAZE = "4282267344";
const U2501 = "4074157872";

describe("shipLiveStats", () => {
  it("serves the baked records", () => {
    const montana = shipLiveStats(MONTANA);
    expect(montana).not.toBeNull();
    expect(montana!.main).toBeCloseTo(23.6, 1);
    expect(montana!.sec).toBeCloseTo(7.3, 1);
    expect(montana!.hp).toBe(96300);
    expect(montana!.spd).toBeCloseTo(30, 1);
    expect(montana!.det).toBeCloseTo(17.3, 1);
    expect(montana!.flags).toBe(8);
    expect(montana!.load).toContain("CrashCrew");
    expect(montana!.aa?.far?.r).toBeGreaterThan(5);
  });

  it("returns null for unknown ships and nullish ids", () => {
    expect(shipLiveStats("9999999999")).toBeNull();
    expect(shipLiveStats(undefined)).toBeNull();
    expect(shipLiveStats(null)).toBeNull();
    expect(hasShipLiveStats(MONTANA)).toBe(true);
    expect(hasShipLiveStats("9999999999")).toBe(false);
  });

  it("keeps torpedo data where the ship has it", () => {
    expect(shipLiveStats(SHIMAKAZE)!.torp).toBeCloseTo(20, 1);
    expect(shipLiveStats(MONTANA)!.torp).toBeUndefined();
  });

  it("formats the row strip chips in display order", () => {
    const chips = formatShipParams(shipLiveStats(MONTANA)!);
    const labels = chips.map((c) => c.label);
    // Display order: main, secondary, airstrike, AA, concealment, speed —
    // torpedo skipped (Montana carries none).
    expect(labels).toEqual(["主炮", "副炮", "空袭", "防空", "隐蔽", "航速"]);
    const main = chips[0];
    expect(main.value).toBe("23.6km");
    expect(main.hint).toContain("主炮射程");
  });

  it("skips chips the ship has no data for", () => {
    const chips = formatShipParams(shipLiveStats(SHIMAKAZE)!);
    const labels = chips.map((c) => c.label);
    expect(labels).toContain("鱼雷");
    expect(labels).not.toContain("副炮");
    expect(labels).not.toContain("空袭");
  });

  it("groups the hover-card specs", () => {
    const groups = formatShipSpecGroups(shipLiveStats(U2501)!);
    const names = groups.map(([g]) => g);
    expect(names).toContain("存活性");
    expect(names).toContain("鱼雷");
    // A submarine has no artillery group (no main-gun row baked).
    expect(names).not.toContain("主炮组");
    // Submarines carry no ASW airstrike — that group belongs to surfaces.
    expect(names).not.toContain("反潜");
    const yamato = formatShipSpecGroups(shipLiveStats("4276041424")!);
    expect(yamato.map(([g]) => g)).toContain("反潜");
  });

  it("maps consumable families to localized labels", () => {
    expect(shipConsumableLabel("SonarSearch")).toBe("水听器");
    expect(shipConsumableLabel("RLSSearch")).toBe("雷达");
    expect(shipConsumableLabel("AuxiliaryTorpedoArmamentBooster")).toBe("防空弹幕");
    expect(isKnownConsumable("CrashCrew")).toBe(true);
    expect(shipConsumableLabel("CrashCrew")).toBe("损管小组");
    // The damage-control party is universal, so it never earns a row badge.
    expect(isBadgeConsumable("CrashCrew")).toBe(false);
    expect(isBadgeConsumable("SonarSearch")).toBe(true);
    expect(isKnownConsumable("MindControl")).toBe(false);
    expect(isBadgeConsumable("MindControl")).toBe(false);
    // Unknown families fall back to a spaced-out raw name.
    expect(shipConsumableLabel("MindControl")).toBe("Mind Control");
  });

  it("labels researchable module kinds", () => {
    expect(shipUpgradeLabel("fireControl")).toBe("射击系统");
    expect(shipUpgradeLabel("hull")).toBe("船体");
  });

  it("renders roman tiers", () => {
    expect(tierRoman(10)).toBe("X");
    expect(tierRoman(11)).toBe("★");
    expect(tierRoman(null)).toBeNull();
  });

  it("shorts the WG ship types", () => {
    expect(shipTypeShort("Battleship")).toBe("BB");
    expect(shipTypeShort("AirCarrier")).toBe("CV");
    expect(shipTypeShort("Submarine")).toBe("SS");
    expect(shipTypeShort("Cruiser")).toBe("CA");
    expect(shipTypeShort("Destroyer")).toBe("DD");
    expect(shipTypeShort(null)).toBeNull();
  });
});
