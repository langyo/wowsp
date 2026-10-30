/** Contract tests for the water-table ship-class hover cards
 *  (components/stats/shipTypeHint.ts): the badge code picks the card, the
 *  minimap marker is the neutral outline line art, and the briefing carries the
 *  gameplay substance the popup exists for — control-heavy classes ride
 *  the itemized keys list ("press X to do Y") plus a muted mechanics note
 *  instead of one long paragraph. The zh-CN assertions pin that locale;
 *  setLocale loads its bundle lazily, so the switch is awaited first (same
 *  pattern as consumables.test.ts). */
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

  it("uses the neutral (right-facing) minimap marker as outline line art", () => {
    for (const code of ["BB", "CV", "CA", "CL", "CA/CL", "DD", "SS"]) {
      const markerUrl = shipTypeHintCardOf(code)?.markerUrl ?? "";
      expect(markerUrl).toMatch(/icon_outline_(battleship|aircarrier|cruiser|destroyer|submarine)\.webp$/);
    }
    expect(shipTypeHintCardOf("CA")?.markerUrl).toMatch(/icon_outline_cruiser\.webp$/);
    expect(shipTypeHintCardOf("CL")?.markerUrl).toMatch(/icon_outline_cruiser\.webp$/);
    expect(shipTypeHintCardOf("SS")?.markerUrl).toMatch(/icon_outline_submarine\.webp$/);
    // The plate-free art must ride the marker channel (CSS-tinted ink), never
    // the plain icon channel: tinting the plate-included white art would
    // collapse the glyph into one solid silhouette at the card's 20 px.
    expect(shipTypeHintCardOf("BB")?.iconUrl).toBeUndefined();
  });

  it("briefs the submarine as intro + itemized keys + a mechanics note", () => {
    const ss = shipTypeHintCardOf("SS")!;
    // The intro keeps the attack method; the depth-band prose moved into
    // the key items, so the body stays one short paragraph.
    expect(ss.body).toContain("鱼雷");
    expect(ss.body).toContain("声呐");
    expect(ss.body!.length).toBeLessThan(160);
    // The dive/surface/mark keys, each carrying its depth-band consequence.
    expect(ss.keys?.map((k) => k.key)).toEqual(["C", "F", "G"]);
    expect(ss.keys?.[0]?.text).toContain("下潜");
    expect(ss.keys?.[0]?.text).toContain("最大深度");
    expect(ss.keys?.[1]?.text).toContain("上浮");
    expect(ss.keys?.[1]?.text).toContain("甲板炮");
    expect(ss.keys?.[2]?.text).toContain("声呐");
    // Battery and the fuel-leak tell live in the muted note.
    expect(ss.note).toContain("电池");
    expect(ss.note).toContain("漏油");
  });

  it("itemizes the carrier's squadron controls; gun classes stay prose-only", () => {
    const cv = shipTypeHintCardOf("CV")!;
    expect(cv.keys?.map((k) => k.key)).toEqual(["数字键", "左键", "W", "F"]);
    // The cap reads as a key group; the action text names no aircraft types —
    // carriers field different loadouts, so it only says the digits pick the
    // type and a double-tap launches.
    expect(cv.keys?.[0]?.text).toContain("不同数字");
    expect(cv.keys?.[0]?.text).toContain("双击");
    expect(cv.keys?.[0]?.text).not.toMatch(/攻击机|鱼雷机|轰炸机/);
    expect(cv.keys?.[3]?.text).toContain("召回");
    expect(shipTypeHintCardOf("CA")?.body).toContain("203 mm");
    expect(shipTypeHintCardOf("CL")?.body).toContain("152 mm");
    expect(shipTypeHintCardOf("BB")?.keys).toBeUndefined();
    expect(shipTypeHintCardOf("DD")?.note).toBeUndefined();
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
    // The full SS card survives the round trip: keys list and note intact.
    const ss = hintCardFrom(JSON.parse(shipTypeHintCard("SS")!));
    expect(ss!.keys).toEqual(shipTypeHintCardOf("SS")!.keys);
    expect(ss!.note).toBe(shipTypeHintCardOf("SS")!.note);
  });

  it("follows the active locale", async () => {
    await setLocale("en-US");
    expect(shipTypeHintCardOf("CA")?.title).toBe("Heavy Cruiser");
    const ss = shipTypeHintCardOf("SS")!;
    expect(ss.keys?.map((k) => k.key)).toEqual(["C", "F", "G"]);
    expect(ss.keys?.[0]?.text).toContain("maximum depth");
    expect(ss.keys?.[1]?.text).toContain("periscope depth");
    await setLocale("zh-CN");
  });
});
