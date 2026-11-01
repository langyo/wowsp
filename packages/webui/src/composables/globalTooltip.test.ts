/** Contract tests for the `data-hint-card` parser (hintCardFrom). The
 *  attribute JSON is anchor-supplied, so anything malformed or off-schema
 *  must degrade to "no card" instead of breaking the hint. Placement is
 *  upstream hikari's (applyTooltipPosition + popupBounds, tested there —
 *  including the device-pixel snap since hikari #1024 / 0.55.269, which
 *  retired this module's own snap post-pass); AppTitleBar declares the
 *  chrome band via popupChrome.
 *
 *  The appended describes cover the OTHER halves of the document-level hook:
 *  installGlobalTooltip also installs hikari's native-title bridge, so a
 *  plain `title=` element (hikari's own components included) renders the
 *  house `.hk-tooltip-popup` instead of the browser bubble, while
 *  `data-hint` anchors stay on the app's richer popup. */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import {
  hintCardFrom,
  installGlobalTooltip,
  touchHintTextFor,
} from "./globalTooltip";

/** Pin window.devicePixelRatio for a test (happy-dom reports a plain 1) —
 *  the snap grid is 1/DPR, so the rounding tests exercise the fractional-DPR
 *  cases (Windows 125% scale → DPR 1.25, or DPR 2) explicitly. The restore registers on the
 *  CURRENT test (onTestFinished), so a failing expect can never leak the
 *  stubbed ratio into a later test. */
function stubDevicePixelRatio(value: number): void {
  const previous = window.devicePixelRatio;
  Object.defineProperty(window, "devicePixelRatio", {
    value,
    configurable: true,
    writable: true,
  });
  onTestFinished(() => {
    Object.defineProperty(window, "devicePixelRatio", {
      value: previous,
      configurable: true,
      writable: true,
    });
  });
}

/** A DOMRect stub over one box — happy-dom has no layout engine, so
 *  placement and snapping read exactly what this answers. */
function rectAt(left: number, top: number, width: number, height: number): DOMRect {
  return {
    width,
    height,
    left,
    top,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("hintCardFrom", () => {
  it("accepts a full card and keeps every populated field", () => {
    const card = hintCardFrom({
      title: "大和",
      badge: "X",
      iconUrl: "/images/ships/icon_battleship.webp",
      subtitle: "日本 · 战列舰",
      subtitleFlagUrl: "/images/flags/japan.webp",
      rows: [{ label: "血量", value: "97,200" }],
    });
    expect(card).toEqual({
      title: "大和",
      badge: "X",
      iconUrl: "/images/ships/icon_battleship.webp",
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

describe("hintCardFrom branch-feature fields", () => {
  it("keeps a validated icons strip, note and per-row icon", () => {
    const card = hintCardFrom({
      title: "战舰特性",
      icons: ["a.png", "  ", 7, "b.png", "c.png", "d.png", "e.png", "f.png", "g.png"],
      rows: [{ label: "主炮组", value: "＋伤害较高", iconUrl: "cat.png" }],
      note: "与对应等级同类型战舰的比较差异。",
    })!;
    expect(card.icons).toEqual(["a.png", "b.png", "c.png", "d.png", "e.png", "f.png"]);
    expect(card.rows?.[0].iconUrl).toBe("cat.png");
    expect(card.note).toContain("比较差异");
  });

  it("drops blank/non-string icons, notes and row icons", () => {
    expect(hintCardFrom({ title: "T", icons: ["", "  "] })).toEqual({ title: "T" });
    expect(hintCardFrom({ title: "T", icons: "a.png" })).toEqual({ title: "T" });
    expect(hintCardFrom({ title: "T", note: "   " })).toEqual({ title: "T" });
    expect(
      hintCardFrom({ title: "T", rows: [{ label: "L", value: "V", iconUrl: 42 }] }),
    ).toEqual({ title: "T", rows: [{ label: "L", value: "V" }] });
  });
});

describe("hintCardFrom briefing paragraph", () => {
  it("keeps a trimmed body and preserves its internal newlines", () => {
    expect(hintCardFrom({ title: "潜艇", body: "  C 下潜，F 上浮。\n\n下潜会消耗电池。  " })).toEqual({
      title: "潜艇",
      body: "C 下潜，F 上浮。\n\n下潜会消耗电池。",
    });
  });

  it("drops blank and non-string bodies", () => {
    expect(hintCardFrom({ title: "潜艇", body: "   " })).toEqual({ title: "潜艇" });
    expect(hintCardFrom({ title: "潜艇", body: 42 })).toEqual({ title: "潜艇" });
    expect(hintCardFrom({ title: "潜艇", body: ["a"] })).toEqual({ title: "潜艇" });
  });

  it("keeps the white-glyph marker channel apart from the plain icon", () => {
    expect(
      hintCardFrom({ title: "潜艇", markerUrl: "/m.webp", iconUrl: "/i.webp" }),
    ).toEqual({ title: "潜艇", markerUrl: "/m.webp", iconUrl: "/i.webp" });
    expect(hintCardFrom({ title: "潜艇", markerUrl: "  " })).toEqual({ title: "潜艇" });
    expect(hintCardFrom({ title: "潜艇", markerUrl: 7 })).toEqual({ title: "潜艇" });
  });
});

describe("hintCardFrom key items", () => {
  it("keeps validated keycap entries and caps the list at eight", () => {
    const card = hintCardFrom({
      title: "潜艇",
      keys: [
        { key: "C", text: "下潜。" },
        { key: "F", text: "上浮。" },
        { key: "G", text: "解除声呐标记。" },
      ],
    });
    expect(card).toEqual({
      title: "潜艇",
      keys: [
        { key: "C", text: "下潜。" },
        { key: "F", text: "上浮。" },
        { key: "G", text: "解除声呐标记。" },
      ],
    });
    expect(
      hintCardFrom({
        title: "T",
        keys: Array.from({ length: 9 }, (_, i) => ({ key: String(i), text: "t" })),
      })?.keys,
    ).toHaveLength(8);
  });

  it("drops non-object / blank entries instead of throwing", () => {
    const card = hintCardFrom({
      title: "潜艇",
      keys: [
        null,
        42,
        "G",
        { key: "", text: "x" },
        { key: "F" },
        { key: "F", text: "   " },
        { key: "F", text: "上浮。" },
      ],
    });
    expect(card).toEqual({ title: "潜艇", keys: [{ key: "F", text: "上浮。" }] });
    expect(hintCardFrom({ title: "T", keys: "G" })).toEqual({ title: "T" });
    expect(hintCardFrom({ title: "T", keys: [{ key: "F", text: "" }] })).toEqual({ title: "T" });
  });
});

describe("hintCardFrom row chips", () => {
  it("keeps validated good/bad chips and drops the blank value", () => {
    const card = hintCardFrom({
      title: "战舰特性",
      rows: [
        {
          label: "主炮组",
          value: "   ",
          chips: [
            { text: "高爆弹伤害较高", tone: "good" },
            { text: "穿甲弹伤害较低", tone: "bad" },
            { text: "无色调", tone: "nope" },
            "junk",
          ],
        },
      ],
    })!;
    expect(card.rows?.[0].chips).toEqual([
      { text: "高爆弹伤害较高", tone: "good" },
      { text: "穿甲弹伤害较低", tone: "bad" },
    ]);
    expect(card.rows?.[0].value).toBeUndefined();
  });

  it("drops invalid chips entirely and keeps plain-value rows intact", () => {
    const card = hintCardFrom({
      title: "T",
      rows: [
        { label: "L", chips: [{ text: "x", tone: "nope" }] },
        { label: "L2", value: "V" },
      ],
    })!;
    // The row whose chips all got dropped carries nothing — removed entirely.
    expect(card.rows).toEqual([{ label: "L2", value: "V" }]);
  });
});

/** The plain-`title` half of the document hook (hikari's
 *  installHkTooltipBridge, installed by installGlobalTooltip): a native
 *  `title=` attribute is moved aside to `data-hk-title` on engage and the
 *  shared .hk-tooltip-popup.hk-tooltip-bridge shows it after the bridge
 *  delay, while `data-hint` anchors are excluded so the two popups never
 *  stack. installGlobalTooltip() is latched per document (module-level
 *  `installed`), so this describe installs ONCE in beforeAll; each test
 *  owns its host and fake timers. happy-dom has no layout engine, so anchor
 *  rects are stubbed — the hint hook's fire() rejects a zero rect. */
describe("globalTooltip native-title bridge", () => {
  let host: HTMLElement;

  beforeAll(() => {
    installGlobalTooltip();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    // Leave the shared install idle for the next test: a pointerover on the
    // non-anchor host dismisses the hint popup, and any scroll disengages a
    // still-held bridge title. Then drop this test's markup.
    host.dispatchEvent(new Event("pointerover", { bubbles: true }));
    document.dispatchEvent(new Event("scroll"));
    host.remove();
    vi.useRealTimers();
  });

  /** Zero rects would trip the hint hook's vanished-anchor guard and give
   *  the placement math nothing to chew on — give both paths a real box. */
  function withRect(el: HTMLElement): void {
    el.getBoundingClientRect = () =>
      ({
        width: 120, height: 24, left: 10, top: 10, right: 130, bottom: 34,
        x: 10, y: 10, toJSON: () => ({}),
      }) as DOMRect;
  }

  function bridgePopup(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".hk-tooltip-popup.hk-tooltip-bridge");
  }

  function bridgeShown(): boolean {
    return bridgePopup()?.classList.contains("hk-tooltip-visible") ?? false;
  }

  function hintPopup(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".hk-tooltip-popup:not(.hk-tooltip-bridge)");
  }

  it("upgrades a plain title= element through the bridge popup", () => {
    const btn = document.createElement("button");
    btn.setAttribute("title", "tip text");
    withRect(btn);
    host.appendChild(btn);

    btn.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    // Engage is synchronous: the native title is already gone, and only the
    // delayed popup show is pending.
    expect(btn.hasAttribute("title")).toBe(false);
    expect(btn.dataset.hkTitle).toBe("tip text");
    expect(bridgeShown()).toBe(false);

    vi.advanceTimersByTime(300);
    const popup = bridgePopup();
    expect(popup?.parentElement?.id).toBe("hk-overlay-root");
    expect(bridgeShown()).toBe(true);
    expect(popup?.textContent).toBe("tip text");

    btn.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
    expect(btn.getAttribute("title")).toBe("tip text");
    expect(btn.dataset.hkTitle).toBeUndefined();
    expect(bridgeShown()).toBe(false);
    btn.remove();
  });

  it("keeps a [data-hint] anchor on the richer hint popup even with a title", () => {
    const el = document.createElement("span");
    el.setAttribute("data-hint", "rich hint");
    el.setAttribute("title", "native fallback");
    withRect(el);
    host.appendChild(el);

    el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(300);

    const hint = hintPopup();
    expect(hint?.classList.contains("hk-tooltip-visible")).toBe(true);
    expect(hint?.textContent).toBe("rich hint");
    // The excluded anchor keeps its title and never engages the bridge, so
    // the richer popup is the only one on screen.
    expect(el.getAttribute("title")).toBe("native fallback");
    expect(el.hasAttribute("data-hk-title")).toBe(false);
    expect(bridgeShown()).toBe(false);
  });
});


/** place() wiring: the shared popup's FINAL written coordinates carry the
 *  snap. The anchor stub (left 10, width 120 → center 70; top 100, height
 *  24) keeps the pure top placement alive — 92px of headroom clears the
 *  popup's stubbed 40px box plus the gutter, so no flip fires — and the
 *  popup's fractional stubbed box sits fully inside the viewport gutter, so
 *  the clamp pass shifts nothing and the snap contributes the entire delta
 *  (+0.4, −0.4) at DPR 1. */
describe("globalTooltip place() snaps the shared popup onto the pixel grid", () => {
  let host: HTMLElement;

  beforeAll(() => {
    // Idempotent: the bridge describe's install may have latched already.
    installGlobalTooltip();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.dispatchEvent(new Event("pointerover", { bubbles: true }));
    document.dispatchEvent(new Event("scroll"));
    host.remove();
    vi.useRealTimers();
  });

  it("writes the snapped coordinates after the placement pass", () => {
    stubDevicePixelRatio(1);
    const el = document.createElement("span");
    el.setAttribute("data-hint", "snap me");
    el.getBoundingClientRect = () => rectAt(10, 100, 120, 24);
    host.appendChild(el);

    // The shared popup element exists from install; its box is stubbed
    // BEFORE the hover so applyTooltipPosition's measure pass and the snap
    // read the same (fractional) geometry — fractional, but well inside the
    // viewport gutter so the clamp pass writes nothing and the snap is the
    // only post-placement correction.
    const popup = document.querySelector<HTMLElement>(
      ".hk-tooltip-popup:not(.hk-tooltip-bridge)",
    )!;
    popup.getBoundingClientRect = () => rectAt(30.6, 40.4, 100, 40);

    el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(300);

    expect(popup.classList.contains("hk-tooltip-visible")).toBe(true);
    expect(popup.style.left).toBe("70.4px");
    expect(popup.style.top).toBe("91.6px");
  });
});
describe("touchHintTextFor — the touch hint bar's one-line resolver", () => {
  const el = (attrs: Record<string, string>): HTMLElement => {
    const node = document.createElement("span");
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    document.body.appendChild(node);
    onTestFinished(() => node.remove());
    return node;
  };

  it("returns the plain hint, with qualifier chips appended", () => {
    expect(touchHintTextFor(el({ "data-hint": "刷新战绩" }))).toBe("刷新战绩");
    expect(
      touchHintTextFor(
        el({
          "data-hint": "主炮组",
          "data-hint-tags": JSON.stringify([
            { text: "推荐", tone: "rec" },
            { text: "史诗", tone: "epic" },
          ]),
        }),
      ),
    ).toBe("主炮组 · 推荐 · 史诗");
  });

  it("flattens a structured card to one line (badge, keys, values, chips)", () => {
    const card = {
      title: "大和",
      badge: "X",
      keys: [{ key: "G", text: "清除声呐标记" }],
      rows: [
        { label: "生存", value: "97,100" },
        { label: "特性", chips: [{ text: "高隐蔽", tone: "good" }] },
      ],
    };
    expect(
      touchHintTextFor(el({ "data-hint-card": JSON.stringify(card) })),
    ).toBe("大和 · X · G: 清除声呐标记 · 生存: 97,100 · 特性: 高隐蔽");
  });

  it("serves the overflow text only while the holder actually clips", () => {
    const holder = el({ "data-hint-overflow": "完整的标签文本" });
    // happy-dom has no layout: nothing clips by default, so the resolver
    // must hold the hint back — the same gate the hover channel applies.
    expect(touchHintTextFor(holder)).toBeNull();
    Object.defineProperty(holder, "scrollWidth", { value: 240, configurable: true });
    Object.defineProperty(holder, "clientWidth", { value: 100, configurable: true });
    expect(touchHintTextFor(holder)).toBe("完整的标签文本");
  });

  it("falls through to the library's title chain when the app vocabulary is absent", () => {
    expect(touchHintTextFor(el({ title: "hikari markup" }))).toBeNull();
  });
});
