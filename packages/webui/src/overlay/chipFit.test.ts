/** Tests for the overlay's chip-fit clamp (chipFit.ts). A chip anchored at
 *  the roster table's edge grows OUTWARD (allies leftward, enemies
 *  rightward) and, wider than the window's reserved side pad, used to run
 *  past the overlay window's edge and get clipped flat by the page's
 *  `overflow: hidden` — the rounded cap gone, and at worst the numbers
 *  with it (the reported "second Tab row loses its left rounding" bug).
 *
 *  happy-dom lays nothing out, so every fixture stubs
 *  getBoundingClientRect with the geometry a real chip would have: the
 *  anchored edge fixed, the free edge at numbers + whichever seals
 *  survive — re-measured live, so fitChips' remove→re-measure loop sees
 *  each removal shrink the chip exactly like a real bitmap seal would. */
import { describe, expect, it } from "vitest";

import { fitChips, refitWhenSealsSettle } from "./chipFit";

const VIEW_W = 1000;
/** Numbers + chip padding (CSS px) — every chip carries at least this. */
const NUMBERS_W = 120;
/** Seal widths by kind: the wide four-character wording (air/sub/rat) is
 *  what blows a narrow side pad. */
const SEAL_W: Record<string, number> = { miracle: 40, maggot: 40, air: 120, sub: 120, rat: 120 };

function chip(
  side: "ally" | "enemy",
  anchoredEdge: number,
  kinds: string[],
  numbersW = NUMBERS_W,
  decodeGate = false,
  /** The default seal face is a text <span>; custom user pictures keep the
   *  <img> — both must trim identically. */
  tag: "img" | "span" = "img",
): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `overlay-chip overlay-chip--${side}`;
  for (const kind of kinds) {
    const seal = document.createElement(tag);
    seal.className = "overlay-stamp";
    seal.dataset.stamp = kind;
    el.appendChild(seal);
  }
  el.getBoundingClientRect = () => {
    let w = numbersW;
    // decodeGate mimics the not-yet-decoded state the refit pass exists
    // for: the seal <img> is in the DOM but lays out at zero width until
    // the test flips data-decoded (what a real bitmap load does).
    for (const img of el.querySelectorAll("img")) {
      if (decodeGate && img.dataset.decoded !== "1") continue;
      w += SEAL_W[img.dataset.stamp ?? ""] ?? 0;
    }
    for (const span of el.querySelectorAll<HTMLElement>("span.overlay-stamp")) {
      w += SEAL_W[span.dataset.stamp ?? ""] ?? 0;
    }
    const left = side === "ally" ? anchoredEdge - w : anchoredEdge;
    return {
      left,
      right: left + w,
      width: w,
      top: 0,
      bottom: 20,
      height: 20,
      x: left,
      y: 0,
      toJSON: () => ({}),
    } as unknown as DOMRect;
  };
  return el;
}

function mounted(...els: HTMLDivElement[]): ParentNode {
  const root = document.createElement("div");
  for (const el of els) root.appendChild(el);
  return root;
}

function sealKinds(el: HTMLDivElement): string[] {
  return [...el.querySelectorAll<HTMLElement>(".overlay-stamp")].map(
    (seal) => seal.dataset.stamp ?? "",
  );
}

describe("fitChips", () => {
  it("leaves a chip that fits the side pad untouched", () => {
    const el = chip("ally", 600, ["maggot", "air"]);
    fitChips(mounted(el), VIEW_W);
    expect(sealKinds(el)).toEqual(["maggot", "air"]);
    expect(el.style.left).toBe("");
    expect(el.style.right).toBe("");
  });

  it("ignores a sub-pixel overhang (dpr rounding, not a real clip)", () => {
    const el = chip("ally", 119.5, []);
    fitChips(mounted(el), VIEW_W);
    expect(el.style.left).toBe("");
  });

  it("trims composition seals before the career verdict", () => {
    // 400px chip vs a 200px pad: dropping the two wide comp seals (120px
    // each) is enough — if the pass dropped the career verdict first the
    // maggot seal would be gone too.
    const el = chip("ally", 200, ["maggot", "air", "sub"]);
    fitChips(mounted(el), VIEW_W);
    expect(sealKinds(el)).toEqual(["maggot"]);
    expect(el.style.left).toBe("");
  });

  it("drops every seal and only then clamps the free edge to the window edge", () => {
    const el = chip("ally", 80, ["maggot"]);
    fitChips(mounted(el), VIEW_W);
    expect(sealKinds(el)).toEqual([]);
    expect(el.style.left).toBe("0px");
    expect(el.style.right).toBe("auto");
  });

  it("clamps a seal-less candidates chip straight to the window edge", () => {
    const el = chip("ally", 50, [], 300);
    fitChips(mounted(el), VIEW_W);
    expect(el.style.left).toBe("0px");
    expect(el.style.right).toBe("auto");
  });

  it("mirrors the trim for enemy chips growing rightward", () => {
    const el = chip("enemy", 800, ["air"]);
    fitChips(mounted(el), VIEW_W);
    expect(sealKinds(el)).toEqual([]);
    expect(el.style.left).toBe("");
    expect(el.style.right).toBe("");
  });

  it("trims a plain-text seal span exactly like a picture seal", () => {
    // The default seal face is now a text <span> — same data-stamp hook,
    // same trim order (comp seals before career verdicts).
    const el = chip("ally", 200, ["maggot", "air", "sub"], NUMBERS_W, false, "span");
    fitChips(mounted(el), VIEW_W);
    expect(sealKinds(el)).toEqual(["maggot"]);
    expect(el.style.left).toBe("");
  });

  it("clamps an enemy chip's free edge to the right window edge", () => {
    const el = chip("enemy", 950, []);
    fitChips(mounted(el), VIEW_W);
    expect(el.style.left).toBe("auto");
    expect(el.style.right).toBe("0px");
  });

  it.each(["load", "error"] as const)(
    "re-fits when a still-decoding seal %ss (the terminal state widens the chip)",
    (event) => {
      // Pre-settle the seal reads 0px wide and the chip (120px) fits its
      // 200px pad; the settled state widens it to 240px — the armed re-fit
      // must catch the chip going back over the edge and trim the seal.
      const el = chip("ally", 200, ["air"], NUMBERS_W, true);
      const img = el.querySelector("img");
      if (!(img instanceof HTMLImageElement)) throw new Error("fixture seal missing");
      Object.defineProperty(img, "complete", { value: false });
      const root = mounted(el);
      fitChips(root, VIEW_W);
      refitWhenSealsSettle(root, () => VIEW_W);
      expect(sealKinds(el)).toEqual(["air"]);
      img.dataset.decoded = "1";
      img.dispatchEvent(new Event(event));
      expect(sealKinds(el)).toEqual([]);
      expect(el.style.left).toBe("");
    },
  );
});
