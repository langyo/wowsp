/** Unit tests for the Tab-claim gate used by the replay view's keydown. */
import { describe, expect, it } from "vitest";
import { shouldReserveTabKey } from "./tabKeyGate";

const el = (tag: string, attrs: Record<string, string> = {}): HTMLElement => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

/** Put `child` under `parent` and return the child (ancestor lookups). */
const nested = (parent: HTMLElement, child: HTMLElement): HTMLElement => {
  parent.appendChild(child);
  return child;
};

describe("shouldReserveTabKey", () => {
  it("claims Tab on plain chrome", () => {
    expect(shouldReserveTabKey(document.body)).toBe(true);
    expect(shouldReserveTabKey(el("div"))).toBe(true);
    expect(shouldReserveTabKey(el("canvas"))).toBe(true);
    expect(shouldReserveTabKey(el("span"))).toBe(true);
  });

  it("claims Tab on non-Element targets", () => {
    expect(shouldReserveTabKey(null)).toBe(true);
    expect(shouldReserveTabKey(document)).toBe(true);
  });

  it("claims Tab on buttons, links and selects", () => {
    // The old gate bailed out on every focusable element; the unified hold
    // claims them all so Tab never moves the app's focus ring.
    expect(shouldReserveTabKey(el("button"))).toBe(true);
    expect(shouldReserveTabKey(el("select"))).toBe(true);
    expect(shouldReserveTabKey(el("a", { href: "#" }))).toBe(true);
  });

  it("claims Tab on click-like inputs", () => {
    for (const type of ["checkbox", "radio", "button", "submit", "reset", "range", "file", "color", "image"]) {
      expect(shouldReserveTabKey(el("input", { type }))).toBe(true);
    }
  });

  it("gives Tab back to text-like inputs", () => {
    // No type attribute = type text (the browser default).
    expect(shouldReserveTabKey(el("input"))).toBe(false);
    for (const type of ["text", "search", "email", "url", "tel", "password", "number"]) {
      expect(shouldReserveTabKey(el("input", { type }))).toBe(false);
    }
  });

  it("gives Tab back inside textareas", () => {
    expect(shouldReserveTabKey(el("textarea"))).toBe(false);
    // closest() reaches the field through inner markup / label wrappers.
    const ta = el("textarea");
    expect(shouldReserveTabKey(nested(ta, el("span")))).toBe(false);
  });

  it("gives Tab back inside contenteditable hosts", () => {
    expect(shouldReserveTabKey(el("div", { contenteditable: "true" }))).toBe(false);
    // An empty attribute is the spec's "true" spelling.
    expect(shouldReserveTabKey(el("div", { contenteditable: "" }))).toBe(false);
    const host = el("div", { contenteditable: "true" });
    expect(shouldReserveTabKey(nested(host, el("p")))).toBe(false);
  });

  it("claims Tab again under contenteditable=false hosts", () => {
    expect(shouldReserveTabKey(el("div", { contenteditable: "false" }))).toBe(true);
    const host = el("div", { contenteditable: "false" });
    expect(shouldReserveTabKey(nested(host, el("em")))).toBe(true);
  });

  it("claims Tab through focusable chrome wrappers", () => {
    // Buttons did NOT bail out of the claim even before this change — an
    // icon inside one resolves to the button (a click target).
    const button = el("button");
    expect(shouldReserveTabKey(nested(button, el("i")))).toBe(true);
    const anchor = el("a", { href: "#" });
    expect(shouldReserveTabKey(nested(anchor, el("span")))).toBe(true);
  });

  it("claims Tab when no descendant/ancestor is a typing surface", () => {
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
