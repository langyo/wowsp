/**
 * Tests for the shared one-line pannable option strip (optionStrip):
 *  - stripWheelDelta: real horizontal deltas win, vertical notches map
 *    onto the horizontal axis, Firefox line mode normalizes to pixels;
 *  - panEngaged: the 5px threshold is met on EITHER axis.
 *
 * (The edge-fade sensing the module used to own moved into hikari's
 * HkScrollContainer with the scroll migration — data-h-overflow and the
 * mask painting are the library's contract now.)
 */
import { describe, expect, it } from "vitest";

import { panEngaged, stripWheelDelta } from "./optionStrip";

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
