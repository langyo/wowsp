/** Contract tests for the `data-hint-card` parser (hintCardFrom) and the
 *  popup placement resolver (resolveTooltipPlacement). The attribute JSON
 *  is anchor-supplied, so anything malformed or off-schema must degrade
 *  to "no card" instead of breaking the hint; the resolver must never
 *  place the popup above the window chrome line (the title bar). The
 *  line itself is DOM-measured in chromeLineTop() — the .app-titlebar
 *  wrapper is display:contents and boxless, so the measurement targets
 *  the hikari bar root — which only a browser-level check can cover;
 *  these tests pin the resolver against a caller-supplied line. */
import { describe, expect, it } from "vitest";

import { hintCardFrom, resolveTooltipPlacement } from "./globalTooltip";

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

describe("resolveTooltipPlacement", () => {
  // 1280×800 window, title bar bottom at 32px → chrome line at 40px.
  const VIEW = { width: 1280, height: 800 };
  const CHROME = 40;
  const POP = { width: 240, height: 60 };

  function rect(top: number, bottom: number, left = 600, right = 680) {
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  it("keeps top placement when the popup clears the chrome line", () => {
    const r = resolveTooltipPlacement(rect(120, 148), POP, "top", VIEW, CHROME);
    expect(r.placement).toBe("top");
    expect(r.top).toBe(120 - 8 - 60);
    expect(r.left).toBe(640 - 120);
  });

  it("pops down when the popup would reach into the title bar area", () => {
    // First-row anchor under the caption strip: the popup fits in the
    // viewport above but crosses the chrome line — flip below regardless.
    const r = resolveTooltipPlacement(rect(100, 128), POP, "top", VIEW, CHROME);
    expect(r.placement).toBe("bottom");
    expect(r.top).toBe(128 + 8);
    expect(r.top).toBeGreaterThanOrEqual(CHROME);
  });

  it("flips a default-top first-row hint below its anchor", () => {
    const r = resolveTooltipPlacement(rect(48, 76), POP, "top", VIEW, CHROME);
    expect(r.placement).toBe("bottom");
    expect(r.top).toBe(76 + 8);
  });

  it("clamps onto the chrome line when the popup fits nowhere", () => {
    const r = resolveTooltipPlacement(rect(48, 76), { width: 240, height: 200 }, "top", { width: 1280, height: 140 }, CHROME);
    expect(r.placement).toBe("bottom");
    expect(r.top).toBe(CHROME);
  });

  it("flips a bottom hint back up at the viewport bottom when the chrome line allows", () => {
    const r = resolveTooltipPlacement(rect(752, 780), POP, "bottom", VIEW, CHROME);
    expect(r.placement).toBe("top");
    expect(r.top).toBe(752 - 8 - 60);
  });

  it("keeps a bottom hint below when flipping would cross the chrome line", () => {
    // Popup overflows the viewport bottom, but above the anchor there is
    // no chrome-clearing room either — keep bottom, clamp into the gutter.
    const view = { width: 1280, height: 120 };
    const r = resolveTooltipPlacement(rect(44, 64), POP, "bottom", view, CHROME);
    expect(r.placement).toBe("bottom");
    expect(r.top).toBe(Math.max(120 - 8 - 60, CHROME));
  });

  it("clamps horizontally inside the viewport margins", () => {
    const atLeft = resolveTooltipPlacement(rect(300, 328, 4, 64), POP, "top", VIEW, CHROME);
    expect(atLeft.left).toBe(8);
    const atRight = resolveTooltipPlacement(rect(300, 328, 1216, 1276), POP, "top", VIEW, CHROME);
    expect(atRight.left).toBe(1280 - 240 - 8);
  });

  it("keeps left/right placement on its side and clamps against the chrome line", () => {
    const r = resolveTooltipPlacement(rect(20, 44, 40, 80), POP, "right", VIEW, CHROME);
    expect(r.placement).toBe("right");
    expect(r.left).toBe(80 + 8);
    expect(r.top).toBe(CHROME);
  });

  it("falls back to the bare margin as the chrome line on barless surfaces", () => {
    const r = resolveTooltipPlacement(rect(100, 128), POP, "top", VIEW, 8);
    expect(r.placement).toBe("top");
    expect(r.top).toBe(100 - 8 - 60);
    // Even then, an anchor close enough to the viewport top pops down.
    const near = resolveTooltipPlacement(rect(30, 58), POP, "top", VIEW, 8);
    expect(near.placement).toBe("bottom");
    expect(near.top).toBe(58 + 8);
  });
});
