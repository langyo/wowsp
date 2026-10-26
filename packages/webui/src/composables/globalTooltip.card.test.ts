/** Render tests for the structured hover card's briefing paragraph and
 *  itemized key lines (globalTooltip's HintCard.body / HintCard.keys): the
 *  prose must land as a text-only paragraph, keep its newlines, and switch
 *  the popup to the wider reading measure — while parameter-only cards
 *  stay on the narrow one; key entries render as keycap chips leading
 *  their action text. Geometry is upstream hikari's; the anchor rect is
 *  stubbed because happy-dom has no layout engine. */
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

  it("renders the tinted marker, the paragraph and the wide-card class", () => {
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
    // The white HUD glyph renders as a bare image — no plate span behind
    // it; the CSS filter tint carries the contrast instead (see
    // globalTooltip.scss).
    const marker = p?.querySelector(".global-tooltip__card-marker");
    expect(marker?.tagName).toBe("IMG");
    expect(marker?.getAttribute("src")).toBe("/images/ships/icon_white_cruiser.webp");
    expect(p?.querySelector(".global-tooltip__card-icon")).toBeNull();
    expect(p?.querySelector(".global-tooltip__card-body")?.textContent).toBe("第一段。\n第二段。");
  });

  it("keeps parameter-only cards on the narrow measure", () => {
    hover(anchor({ title: "大和", rows: [{ label: "血量", value: "97,200" }] }));
    expect(popup()?.classList.contains("global-tooltip--paragraph")).toBe(false);
    expect(popup()?.querySelector(".global-tooltip__card-body")).toBeNull();
  });

  it("renders the itemized keys as keycap chips leading their action text", () => {
    hover(
      anchor({
        title: "潜艇",
        body: "水下刺客。",
        keys: [
          { key: "C", text: "下潜。" },
          { key: "F", text: "上浮。" },
          { key: "", text: "整条被校验丢弃。" },
        ],
      }),
    );
    const p = popup();
    // Keycap chips are <kbd> elements; the blank-key entry never lands.
    const caps = [...p!.querySelectorAll(".global-tooltip__key-cap")].map((el) => el.textContent);
    expect(caps).toEqual(["C", "F"]);
    const lines = [...p!.querySelectorAll(".global-tooltip__card-key")].map(
      (el) => el.querySelector(".global-tooltip__card-key-text")?.textContent,
    );
    expect(lines).toEqual(["下潜。", "上浮。"]);
  });

  it("never parses anchor-supplied prose as markup", () => {
    hover(anchor({ title: "T", body: "<b>not bold</b>" }));
    const p = popup();
    expect(p?.querySelector(".global-tooltip__card-body b")).toBeNull();
    expect(p?.querySelector(".global-tooltip__card-body")?.textContent).toBe("<b>not bold</b>");
  });
});
