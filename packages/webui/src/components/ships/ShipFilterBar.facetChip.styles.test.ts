/**
 * Stylesheet contract of the ShipFilterBar facet-chip chrome — the three
 * pure facets (type/nation/mode) render hikari HkFilterChip outright, and
 * two bar-side rules in ShipFilterBar.scss dress its library chrome to
 * match the bespoke chips beside it:
 *
 * 1. The library caret glyph is suppressed — the bespoke chips carry no
 *    affordance arrow (theirs mark an ENGAGED sort and render only while
 *    sorting), so the strip reads as one family. Scoped to the bar, so a
 *    future HkFilterChip consumer elsewhere keeps the library default.
 * 2. The facet popover rides the lg pad step — HkFilterChip passes no
 *    `padding` prop to its own HkPopover, so the panel would keep the
 *    glass chrome's 4px menu inset while every bespoke panel beside it
 *    rides `padding="lg"`. The rule feeds the shared --hk-pad token
 *    (runtime/containerPad) through a `:has()` on the body-teleported
 *    panel; the phone sheet reads the same token for its header/bottom
 *    geometry, so both form factors land on the bespoke panels' inset.
 *
 * Assertions run on the raw sheet with comments stripped (the surfaces
 * convention): both rules are flat top-level blocks, no nesting can hide
 * them. The DOM side is pinned by ShipFilterBar.test — it keeps asserting
 * `.hk-filter-chip-caret` exists in the markup — so a hikari class rename
 * fails there and a rule removal fails here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Strip CSS comments — the prose names the library classes on purpose,
 *  only real declarations/selectors may be asserted. */
const scss = readFileSync(
  join(process.cwd(), "src", "components", "ships", "ShipFilterBar.scss"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("ShipFilterBar facet-chip chrome contract", () => {
  it("suppresses the HkFilterChip caret inside the bar", () => {
    expect(scss).toMatch(/\.ship-filter-bar \.hk-filter-chip-caret\s*\{\s*display:\s*none;\s*\}/);
  });

  it("rides the facet popovers onto the lg pad step via --hk-pad", () => {
    expect(scss).toMatch(
      /\.hk-popover-panel:has\(\.hk-filter-chip-body\)\s*\{\s*--hk-pad:\s*var\(--space-16, 1rem\);\s*\}/,
    );
  });
});
