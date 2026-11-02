/**
 * Contract: the spec panel's help icons sit centered on their labels, and
 * the panel delegates its waterfall layout to hikari's HkMasonry.
 *
 * Section labels ("HE Shell", "AP Shell", …) used to be plain inline spans,
 * so their inline-flex help icon sat on the text baseline — visibly low and
 * flush against the label. The label must own a centered flex row with its
 * own gap, and the icon must not re-introduce line-box baseline drift.
 *
 * The panel must also never carry a layout of its own again: CSS multicol
 * fragmented its cards and a stale balancer (older WebView2 / Android
 * WebViews) clipped them at the pre-change column bottom edge (mid-row
 * slices, 2026-11 report), and the interim grid wasted vertical space on
 * row bands. HkMasonry packs measured cards into contiguous columns; this
 * stylesheet only tunes the host (the masonry gap token and density), so
 * .specs-panel must stay token-only and the fragmentation/grid machinery
 * must never return.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** ShipDetailModal.scss with comments stripped (the prose deliberately names
 *  the selectors it pins). */
const scss = readFileSync(
  join(process.cwd(), "src", "components", "ships", "ShipDetailModal.scss"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("ShipDetailModal specs help-icon alignment", () => {

  it("keeps .specs-panel a token-only host of HkMasonry", () => {
    // The waterfall packing lives in the component; this sheet may only set
    // the density token. Any layout declaration here would fight the
    // component's own .hk-masonry rules.
    expect(scss).toMatch(
      /\.specs-panel\s*\{[^}]*--hk-masonry-gap:[^}]*\}/s,
    );
    expect(scss).not.toMatch(
      /\.specs-panel\s*\{[^}]*\n  (display|grid-template-columns|align-items|columns|gap):/s,
    );
    expect(scss).not.toMatch(/\.specs-group\s*\{[^}]*break-inside:/s);
  });

  it("centers the section label row and keeps a gap before the icon", () => {
    expect(scss).toMatch(
      /&__section-label\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*gap:\s*0\.25rem;/s,
    );
  });

  it("keeps the help icon out of the text baseline", () => {
    // line-height: 0 collapses the inline-flex icon box's own line box, so
    // the icon centers on the label instead of hanging below it.
    expect(scss).toMatch(/&__hint\s*\{[^}]*line-height:\s*0;/s);
  });
});
