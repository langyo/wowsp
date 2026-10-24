/** Render tests for the structured hover card's briefing paragraph
 *  (globalTooltip's HintCard.body): the prose must land as a text-only
 *  paragraph, keep its newlines, and switch the popup to the wider reading
 *  measure — while parameter-only cards stay on the narrow one. Geometry is
 *  upstream hikari's; the anchor rect is stubbed because happy-dom has no
 *  layout engine. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installGlobalTooltip } from "./globalTooltip";

let host: HTMLElement;

function anchor(card: Record<string, unknown>): HTMLElement {
  const el = document.createElement("span");
  el.setAttribute("data-hint-card", JSON.stringify(card));
  // Zero rects would trip fire()'s vanished-anchor guard.
  el.getBoundingClientRect = () =>
    ({
      width: 120, height: 24, left: 10, top: 10, right: 130, bottom: 34,
      x: 10, y: 10, toJSON: () => ({}),
    }) as DOMRect;
  host.appendChild(el);
  return el;
}

function popup(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".hk-tooltip-popup");
}

function hover(el: HTMLElement): void {
  el.dispatchEvent(new Event("pointerover", { bubbles: true }));
  vi.advanceTimersByTime(300);
}

describe("globalTooltip briefing paragraph", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installGlobalTooltip();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.useRealTimers();
  });

  it("renders the marker plate, the paragraph and the wide-card class", () => {
    hover(
      anchor({
        title: "重型巡洋舰",
        markerUrl: "/images/ships/icon_white_cruiser.webp",
        body: "第一段。\n第二段。",
      }),
    );
    const p = popup();
    expect(p?.classList.contains("global-tooltip--paragraph")).toBe(true);
    expect(p?.querySelector(".global-tooltip__card-title")?.textContent).toBe("重型巡洋舰");
    // The white HUD glyph rides the dark plate, not the bare icon slot.
    expect(
      p?.querySelector(".global-tooltip__card-marker img")?.getAttribute("src"),
    ).toBe("/images/ships/icon_white_cruiser.webp");
    expect(p?.querySelector(".global-tooltip__card-icon")).toBeNull();
    expect(p?.querySelector(".global-tooltip__card-body")?.textContent).toBe("第一段。\n第二段。");
  });

  it("keeps parameter-only cards on the narrow measure", () => {
    hover(anchor({ title: "大和", rows: [{ label: "血量", value: "97,200" }] }));
    expect(popup()?.classList.contains("global-tooltip--paragraph")).toBe(false);
    expect(popup()?.querySelector(".global-tooltip__card-body")).toBeNull();
  });

  it("never parses anchor-supplied prose as markup", () => {
    hover(anchor({ title: "T", body: "<b>not bold</b>" }));
    const p = popup();
    expect(p?.querySelector(".global-tooltip__card-body b")).toBeNull();
    expect(p?.querySelector(".global-tooltip__card-body")?.textContent).toBe("<b>not bold</b>");
  });
});
