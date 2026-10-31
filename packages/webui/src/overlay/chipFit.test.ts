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

import { fakeAs } from "@/test-utils/fakes";

import {
  alignMetricColumns,
  alignStatColumns,
  fitChips,
  refitWhenSealsSettle,
} from "./chipFit";

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
    return fakeAs<DOMRect>({
      left,
      right: left + w,
      width: w,
      top: 0,
      bottom: 20,
      height: 20,
      x: left,
      y: 0,
      toJSON: () => ({}),
    });
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

  it("clamps a seal-less wide row straight to the window edge", () => {
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

  it("keeps a rat chip's lone badge and clamps instead of shedding it", () => {
    // The rat verdict's row (rowFace's 过街老鼠 row, the overlay-chip--rat
    // marker): the verdict is that row's whole answer about the player, so
    // the stamp stays and the free edge clamps instead.
    const el = chip("ally", 80, ["rat"]);
    el.classList.add("overlay-chip--rat");
    fitChips(mounted(el), VIEW_W);
    expect(sealKinds(el)).toEqual(["rat"]);
    expect(el.style.left).toBe("0px");
    expect(el.style.right).toBe("auto");
  });

  it("clamps a rat enemy chip's free edge to the right window edge", () => {
    const el = chip("enemy", 950, ["rat"]);
    el.classList.add("overlay-chip--rat");
    fitChips(mounted(el), VIEW_W);
    expect(sealKinds(el)).toEqual(["rat"]);
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

/** A row fixture for the stat-column alignment pass: a chain of
 *  overlay-chip rows, each carrying a stat cell with a stubbed width. */
function row(side: "ally" | "enemy", statW: number, face = "44.5%"): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `overlay-chip overlay-chip--${side}`;
  const stat = document.createElement("span");
  stat.className = "overlay-chip__stat";
  stat.textContent = face;
  stat.getBoundingClientRect = () =>
    fakeAs<DOMRect>(({ width: statW, left: 0, right: statW, top: 0, bottom: 12, height: 12, x: 0, y: 0, toJSON: () => ({}) }));
  const name = document.createElement("span");
  name.className = "overlay-chip__name";
  name.textContent = "someone";
  el.append(stat, name);
  return el;
}

describe("alignStatColumns", () => {
  it("pins every stat cell of a side to the widest face on that side", () => {
    const a = row("enemy", 60, "44.5%");
    const b = row("enemy", 132, "44.5% · 1234 · 12.3k");
    const c = row("enemy", 48, "—");
    alignStatColumns(mounted(a, b, c));
    const widthOf = (el: HTMLDivElement) =>
      (el.querySelector(".overlay-chip__stat") as HTMLElement).style.width;
    expect(widthOf(a)).toBe("132px");
    expect(widthOf(b)).toBe("132px");
    expect(widthOf(c)).toBe("132px");
  });

  it("leaves placeholder (sparse) cells compact instead of stretching them", () => {
    // A hidden profile's lone red dot: its cell is marked sparse by rowFace
    // — stretching it to the figures' width would read as a hole in the
    // middle of the row, so it neither joins the measure nor gets pinned.
    const a = row("enemy", 132, "44.5% · 1234 · 12.3k");
    const b = row("enemy", 14, "●");
    (b.querySelector(".overlay-chip__stat") as HTMLElement).classList.add(
      "overlay-chip__stat--sparse",
    );
    alignStatColumns(mounted(a, b));
    const widthOf = (el: HTMLDivElement) =>
      (el.querySelector(".overlay-chip__stat") as HTMLElement).style.width;
    expect(widthOf(a)).toBe("132px");
    expect(widthOf(b)).toBe("");
  });

  it("rounds the shared width up to whole pixels", () => {
    const a = row("ally", 60.4);
    const b = row("ally", 60.1);
    alignStatColumns(mounted(a, b));
    expect((a.querySelector(".overlay-chip__stat") as HTMLElement).style.width).toBe(
      "61px",
    );
  });

  it("keeps the two sides' columns independent", () => {
    const ally = row("ally", 60);
    const enemy = row("enemy", 132);
    alignStatColumns(mounted(ally, enemy));
    expect((ally.querySelector(".overlay-chip__stat") as HTMLElement).style.width).toBe(
      "60px",
    );
    expect((enemy.querySelector(".overlay-chip__stat") as HTMLElement).style.width).toBe(
      "132px",
    );
  });

  it("skips zero-width measures (the happy-dom layout gap)", () => {
    const a = row("enemy", 0);
    alignStatColumns(mounted(a));
    expect((a.querySelector(".overlay-chip__stat") as HTMLElement).style.width).toBe("");
  });

  it("does not fail on a side with no rows", () => {
    expect(() => alignStatColumns(mounted())).not.toThrow();
  });
});

/** A metric-cell fixture for the column alignment pass: a stat cell
 *  holding one bold value keyed by data-col, with a stubbed laid-out
 *  width (happy-dom lays nothing out). */
function metricRow(
  side: "ally" | "enemy",
  cells: Array<{ col: number; w: number }>,
): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `overlay-chip overlay-chip--${side}`;
  const stat = document.createElement("span");
  stat.className = "overlay-chip__stat";
  for (const { col, w } of cells) {
    const b = document.createElement("b");
    b.dataset.col = String(col);
    b.getBoundingClientRect = () =>
      fakeAs<DOMRect>(({ width: w, left: 0, right: w, top: 0, bottom: 12, height: 12, x: 0, y: 0, toJSON: () => ({}) }));
    stat.appendChild(b);
  }
  const name = document.createElement("span");
  name.className = "overlay-chip__name";
  name.textContent = "someone";
  el.append(stat, name);
  return el;
}

describe("alignMetricColumns", () => {
  it("pins each metric column to its own widest face", () => {
    // Column 0's widest face is 56px, column 1's is 30px — each column
    // takes its OWN max, not one width for all metrics.
    const a = metricRow("ally", [
      { col: 0, w: 40 },
      { col: 1, w: 30 },
    ]);
    const b = metricRow("ally", [
      { col: 0, w: 56 },
      { col: 1, w: 24 },
    ]);
    alignMetricColumns(mounted(a, b));
    const widthOf = (row: HTMLDivElement, col: number) =>
      (row.querySelectorAll<HTMLElement>(".overlay-chip__stat b")[col]).style.width;
    expect(widthOf(a, 0)).toBe("56px");
    expect(widthOf(b, 0)).toBe("56px");
    expect(widthOf(a, 1)).toBe("30px");
    expect(widthOf(b, 1)).toBe("30px");
  });

  it("shares widths across the two sides (one mirrored table)", () => {
    // The enemy block renders its columns in reverse order but keyed by
    // the same data-col — both sides' cells must land on one width so the
    // mirrored halves stay symmetric.
    const ally = metricRow("ally", [{ col: 2, w: 40 }]);
    const enemy = metricRow("enemy", [{ col: 2, w: 61.2 }]);
    alignMetricColumns(mounted(ally, enemy));
    const widthOf = (row: HTMLDivElement) =>
      (row.querySelector(".overlay-chip__stat b") as HTMLElement).style.width;
    expect(widthOf(ally)).toBe("62px");
    expect(widthOf(enemy)).toBe("62px");
  });

  it("leaves placeholder rows alone (no data-col cells in them)", () => {
    // A loading/hidden row's stat face is a span without data-col — the
    // pass must not touch it (alignStatColumns still gives the CELL its
    // column slot).
    const row = metricRow("ally", []);
    alignMetricColumns(mounted(row));
    expect(row.querySelectorAll(".overlay-chip__stat b")).toHaveLength(0);
  });

  it("skips zero-width measures (the happy-dom layout gap)", () => {
    const row = metricRow("enemy", [{ col: 0, w: 0 }]);
    alignMetricColumns(mounted(row));
    expect((row.querySelector(".overlay-chip__stat b") as HTMLElement).style.width).toBe("");
  });

  it("does not fail on an empty root", () => {
    expect(() => alignMetricColumns(mounted())).not.toThrow();
  });
});
