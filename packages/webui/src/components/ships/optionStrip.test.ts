/**
 * Tests for the shared one-line pannable option strip (optionStrip):
 *  - stripWheelDelta: real horizontal deltas win, vertical notches map
 *    onto the horizontal axis, Firefox line mode normalizes to pixels;
 *  - panEngaged: the 5px threshold is met on EITHER axis;
 *  - overflowSides: the hikari data-h-overflow contract — which inline
 *    edges still hide content, with sub-pixel offsets counting as
 *    resting at the edge and no overflow reading "none".
 *
 * Pure DOM/DOMRect-free helpers only — jsdom's layout is zero-sized, so
 * the overflow probe runs against stubbed scroll geometry.
 */
import { describe, expect, it } from "vitest";

import { overflowSides, panEngaged, stripWheelDelta } from "./optionStrip";

function stripStub(scrollWidth: number, clientWidth: number, scrollLeft: number): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperties(el, {
    scrollWidth: { value: scrollWidth, configurable: true },
    clientWidth: { value: clientWidth, configurable: true },
    scrollLeft: { value: scrollLeft, configurable: true },
  });
  return el;
}

describe("stripWheelDelta", () => {
  it("pixel mode: a horizontal delta wins over the vertical one", () => {
    expect(stripWheelDelta(0, 0, 120)).toBe(120);
    expect(stripWheelDelta(0, -60, 120)).toBe(-60);
    expect(stripWheelDelta(0, 15, -90)).toBe(15);
    expect(stripWheelDelta(0, 0, 0)).toBe(0);
  });

  it("line mode (Firefox) normalizes lines to pixels", () => {
    expect(stripWheelDelta(1, 0, 3)).toBe(120);
    expect(stripWheelDelta(1, 0, -1)).toBe(-40);
    expect(stripWheelDelta(1, -2, 0)).toBe(-80);
  });

  it("page mode passes through raw", () => {
    expect(stripWheelDelta(2, 0, 1)).toBe(1);
  });
});

describe("panEngaged", () => {
  it("arms past the threshold on either axis only", () => {
    expect(panEngaged(0, 0, 5)).toBe(false);
    expect(panEngaged(4, 4, 5)).toBe(false);
    expect(panEngaged(-4, 3, 5)).toBe(false);
    expect(panEngaged(5, 0, 5)).toBe(true);
    expect(panEngaged(0, -5, 5)).toBe(true);
    expect(panEngaged(-9, 3, 5)).toBe(true);
  });
});

describe("overflowSides", () => {
  it("no overflow reads none regardless of the (zero) offset", () => {
    expect(overflowSides(stripStub(400, 400, 0))).toBe("none");
  });

  it("resting at the start hides the end only", () => {
    expect(overflowSides(stripStub(1000, 400, 0))).toBe("end");
  });

  it("scrolled to the end hides the start only", () => {
    expect(overflowSides(stripStub(1000, 400, 600))).toBe("start");
  });

  it("mid-scroll hides both edges", () => {
    expect(overflowSides(stripStub(1000, 400, 300))).toBe("both");
  });

  it("sub-pixel offsets still count as resting at the edge", () => {
    expect(overflowSides(stripStub(1000, 400, 0.5))).toBe("end");
    expect(overflowSides(stripStub(1000, 400, 599.5))).toBe("start");
  });
});
