/** Unit tests for the Tab-focus gate used by the replay view's keydown. */
import { describe, expect, it } from "vitest";
import { shouldReserveTabKey } from "./tabKeyGate";

const el = (tag: string, attrs: Record<string, string> = {}): HTMLElement => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

describe("shouldReserveTabKey", () => {
  it("reserves Tab when the target is plain body", () => {
    expect(shouldReserveTabKey(document.body)).toBe(true);
  });

  it("reserves Tab when the target is a non-interactive element", () => {
    expect(shouldReserveTabKey(el("div"))).toBe(true);
    expect(shouldReserveTabKey(el("canvas"))).toBe(true);
    expect(shouldReserveTabKey(el("span"))).toBe(true);
  });

  it("reserves Tab when the target is not an Element", () => {
    expect(shouldReserveTabKey(null)).toBe(true);
    expect(shouldReserveTabKey(document)).toBe(true);
  });

  it("gives Tab back on form controls", () => {
    expect(shouldReserveTabKey(el("input"))).toBe(false);
    expect(shouldReserveTabKey(el("textarea"))).toBe(false);
    expect(shouldReserveTabKey(el("select"))).toBe(false);
    expect(shouldReserveTabKey(el("button"))).toBe(false);
  });

  it("gives Tab back on links and contenteditable hosts", () => {
    expect(shouldReserveTabKey(el("a", { href: "#" }))).toBe(false);
    expect(shouldReserveTabKey(el("div", { contenteditable: "true" }))).toBe(false);
  });

  it("gives Tab back when an interactive ancestor matches via closest()", () => {
    const input = el("input");
    const inner = el("span");
    input.appendChild(inner);
    expect(shouldReserveTabKey(inner)).toBe(false);

    const anchor = el("a", { href: "#" });
    const icon = el("i");
    anchor.appendChild(icon);
    expect(shouldReserveTabKey(icon)).toBe(false);
  });

  it("reserves Tab when no ancestor up to the root is interactive", () => {
    const outer = el("div");
    const inner = el("p");
    outer.appendChild(inner);
    document.body.appendChild(outer);
    try {
      expect(shouldReserveTabKey(inner)).toBe(true);
    } finally {
      outer.remove();
    }
  });
});
