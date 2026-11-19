/**
 * Stylesheet contract of the ShipFilterBar facet-chip chrome — ALL six
 * categories render hikari HkFilterChip outright (hikari 0.55.431), and
 * this sheet dresses only what the host owns on top of the library
 * chrome:
 *
 * 1. The intermediate 全部…-sort state. A chip sorting from its 全部…
 *    state filters nothing but still orders the list — quieter than the
 *    picked --on face (text ink stays, a faint primary tint marks the
 *    engagement, the direction arrow carries the primary ink). The class
 *    arrives through HkFilterChip's attrs fallthrough (the library paints
 *    --on itself from the selection; the tier corridor counts as one and
 *    passes it through attrs).
 *
 * The library defaults carry the rest since 0.55.431, so this sheet pins
 * NO override anymore: the trigger renders no caret and the popup rides
 * the lg pad step (the shared --hk-pad token) straight from the library.
 * Assertions run on the raw sheet with comments stripped (the surfaces
 * convention): the rule is a flat top-level block, no nesting can hide
 * it. The DOM side is pinned by ShipFilterBar.test — it keeps asserting
 * the --sort class lands on the trigger while an all-sort is engaged.
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
  it("dresses the attrs-carried --sort state quieter than --on", () => {
    const rule = scss.match(
      /\.ship-filter-bar \.hk-filter-chip--sort\s*\{(?:[^{}]|\{[^{}]*\})*\}/,
    );
    expect(rule, "the --sort dress rule must exist").toBeTruthy();
    // The recipe: text ink (not primary), a 6% primary mix on the solid
    // surface, the primary border — and the direction arrow in primary.
    expect(rule![0]).toContain("color: rgb(var(--color-text))");
    expect(rule![0]).toContain(
      "background: color-mix(in srgb, rgb(var(--color-primary)) 6%, rgb(var(--color-surface)))",
    );
    expect(rule![0]).toContain(".ship-filter-bar__dir");
  });
});
