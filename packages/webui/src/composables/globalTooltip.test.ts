/** Contract tests for the `data-hint-card` parser (hintCardFrom). The
 *  attribute JSON is anchor-supplied, so anything malformed or off-schema
 *  must degrade to "no card" instead of breaking the hint. Popup geometry
 *  itself is upstream hikari's now (applyTooltipPosition + popupBounds,
 *  tested there); AppTitleBar declares the chrome band via popupChrome. */
import { describe, expect, it } from "vitest";

import { hintCardFrom } from "./globalTooltip";

describe("hintCardFrom", () => {
  it("accepts a full card and keeps every populated field", () => {
    const card = hintCardFrom({
      title: "大和",
      badge: "X",
      iconUrl: "/images/ships/icon_battleship.png",
      subtitle: "日本 · 战列舰",
      subtitleFlagUrl: "/images/flags/japan.webp",
      rows: [{ label: "血量", value: "97,200" }],
    });
    expect(card).toEqual({
      title: "大和",
      badge: "X",
      iconUrl: "/images/ships/icon_battleship.png",
      subtitle: "日本 · 战列舰",
      subtitleFlagUrl: "/images/flags/japan.webp",
      rows: [{ label: "血量", value: "97,200" }],
    });
  });

  it("accepts a title-only card", () => {
    expect(hintCardFrom({ title: "Yamato" })).toEqual({ title: "Yamato" });
  });

  it("drops blank optional strings and blank rows", () => {
    const card = hintCardFrom({
      title: "Gearing",
      badge: "   ",
      iconUrl: "",
      subtitle: "  ",
      subtitleFlagUrl: "",
      rows: [
        { label: "", value: "1" },
        { label: "血量", value: "   " },
        { label: "血量", value: "16,300" },
      ],
    });
    expect(card).toEqual({
      title: "Gearing",
      rows: [{ label: "血量", value: "16,300" }],
    });
  });

  it("omits rows entirely when none survive validation", () => {
    const card = hintCardFrom({ title: "Yamato", rows: [{ label: "血量", value: "" }] });
    expect(card).toEqual({ title: "Yamato" });
    expect(hintCardFrom({ title: "Yamato", rows: "nope" })).toEqual({ title: "Yamato" });
  });

  it("filters non-object row entries instead of throwing", () => {
    const card = hintCardFrom({
      title: "Yamato",
      rows: [null, 42, "hp", { label: "血量", value: "97,200" }],
    });
    expect(card).toEqual({ title: "Yamato", rows: [{ label: "血量", value: "97,200" }] });
  });

  it("keeps the subtitle when only its flag URL is blank (event ships)", () => {
    const card = hintCardFrom({
      title: "黑暗领域",
      subtitle: "战列舰",
      subtitleFlagUrl: "",
      rows: [],
    });
    expect(card).toEqual({ title: "黑暗领域", subtitle: "战列舰" });
  });

  it("returns null for a missing / blank / non-string title", () => {
    expect(hintCardFrom(null)).toBeNull();
    expect(hintCardFrom("text")).toBeNull();
    expect(hintCardFrom({})).toBeNull();
    expect(hintCardFrom({ title: "   " })).toBeNull();
    expect(hintCardFrom({ title: 42 })).toBeNull();
  });

  it("round-trips through JSON exactly like the DOM attribute path", () => {
    const raw = JSON.stringify({
      title: "蒙大拿",
      badge: "X",
      subtitle: "美国 · 战列舰",
      rows: [{ label: "血量", value: "96,300" }],
    });
    expect(hintCardFrom(JSON.parse(raw))).toEqual({
      title: "蒙大拿",
      badge: "X",
      subtitle: "美国 · 战列舰",
      rows: [{ label: "血量", value: "96,300" }],
    });
  });
});
