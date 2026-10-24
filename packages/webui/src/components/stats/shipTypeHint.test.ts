/** Contract tests for the water-table ship-class hover cards
 *  (components/stats/shipTypeHint.ts): the badge code picks the card, the
 *  minimap marker is the neutral white art, and the briefing carries the
 *  gameplay substance the popup exists for (submarine controls among them),
 *  and rides the marker channel so the white glyph gets its dark plate.
 *  The zh-CN assertions pin that locale; setLocale loads its bundle lazily,
 *  so the switch is awaited first (same pattern as consumables.test.ts). */
import { beforeAll, describe, expect, it } from "vitest";

import { hintCardFrom } from "@/composables/globalTooltip";
import { setLocale } from "@/i18n";
import { shipTypeHintCard, shipTypeHintCardOf } from "./shipTypeHint";

beforeAll(async () => {
  await setLocale("zh-CN");
});

describe("shipTypeHintCardOf", () => {
  it("titles each badge with the class the row actually draws", () => {
    expect(shipTypeHintCardOf("BB")?.title).toBe("战列舰");
    expect(shipTypeHintCardOf("CV")?.title).toBe("航空母舰");
    expect(shipTypeHintCardOf("CA")?.title).toBe("重型巡洋舰");
    expect(shipTypeHintCardOf("CL")?.title).toBe("轻型巡洋舰");
    expect(shipTypeHintCardOf("CA/CL")?.title).toBe("巡洋舰");
    expect(shipTypeHintCardOf("DD")?.title).toBe("驱逐舰");
    expect(shipTypeHintCardOf("SS")?.title).toBe("潜艇");
  });

  it("uses the game's neutral (white, right-facing) minimap marker", () => {
    for (const code of ["BB", "CV", "CA", "CL", "CA/CL", "DD", "SS"]) {
      const markerUrl = shipTypeHintCardOf(code)?.markerUrl ?? "";
      expect(markerUrl).toMatch(/icon_white_(battleship|aircarrier|cruiser|destroyer|submarine)\.webp$/);
    }
    expect(shipTypeHintCardOf("CA")?.markerUrl).toMatch(/icon_white_cruiser\.webp$/);
    expect(shipTypeHintCardOf("CL")?.markerUrl).toMatch(/icon_white_cruiser\.webp$/);
    expect(shipTypeHintCardOf("SS")?.markerUrl).toMatch(/icon_white_submarine\.webp$/);
    // The white art must ride the marker channel (dark plate), never the
    // plain icon channel — a white glyph on the white popup is invisible.
    expect(shipTypeHintCardOf("BB")?.iconUrl).toBeUndefined();
  });

  it("briefs the submarine's weapons, depth keys and what depth costs", () => {
    const body = shipTypeHintCardOf("SS")?.body ?? "";
    // Attack method + how it is aimed.
    expect(body).toContain("鱼雷");
    expect(body).toContain("声呐");
    // The dive/surface keys the request calls out explicitly.
    expect(body).toContain("C 下潜");
    expect(body).toContain("F 上浮");
    // Concealment / armament change per depth band.
    expect(body).toContain("潜望镜深度");
    expect(body).toContain("最大深度");
    expect(body).toContain("甲板炮");
    // Battery and the fuel-leak tell.
    expect(body).toContain("电池");
    expect(body).toContain("漏油");
  });

  it("briefs the carrier's squadron controls and the gun calibres of the cruisers", () => {
    const cv = shipTypeHintCardOf("CV")?.body ?? "";
    expect(cv).toContain("1/2/3");
    expect(cv).toContain("F 召回");
    expect(shipTypeHintCardOf("CA")?.body).toContain("203 mm");
    expect(shipTypeHintCardOf("CL")?.body).toContain("152 mm");
  });

  it("has no card for unknown / absent badge codes", () => {
    expect(shipTypeHintCardOf("?")).toBeNull();
    expect(shipTypeHintCardOf("AX")).toBeNull();
    expect(shipTypeHintCardOf("")).toBeNull();
    expect(shipTypeHintCardOf(null)).toBeNull();
    expect(shipTypeHintCardOf(undefined)).toBeNull();
    expect(shipTypeHintCard("?")).toBeUndefined();
  });

  it("serializes to the data-hint-card contract the tooltip parses back", () => {
    const raw = shipTypeHintCard("DD");
    expect(raw).toBeTypeOf("string");
    const parsed = hintCardFrom(JSON.parse(raw!));
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe("驱逐舰");
    expect(parsed!.body).toBe(shipTypeHintCardOf("DD")!.body);
    expect(parsed!.markerUrl).toBe(shipTypeHintCardOf("DD")!.markerUrl);
  });

  it("follows the active locale", async () => {
    await setLocale("en-US");
    expect(shipTypeHintCardOf("CA")?.title).toBe("Heavy Cruiser");
    expect(shipTypeHintCardOf("SS")?.body).toContain("C dives");
    expect(shipTypeHintCardOf("SS")?.body).toContain("periscope depth");
    await setLocale("zh-CN");
  });
});
