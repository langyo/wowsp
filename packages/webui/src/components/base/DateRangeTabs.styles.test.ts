/**
 * Contract: DateRangeTabs does not re-paint hikari's segmented-track chrome.
 *
 * hikari ships `.hk-tabs-list` as 60% surface glass with naked triggers and a
 * primary/12% sliding indicator (HkTabs.scss); its facet chips are the solid
 * counterpart (HkFilterChip.scss). wowsp keeps that shipped look — the
 * sibling shittim-chest project has no track fill rule at all (it does keep
 * a few LAYOUT tweaks on hikari chrome, but never re-paints it) — and wowsp's
 * only global layer on top is the UI-surface-opacity dial SCALING the same
 * 60% base in theme.scss.
 *
 * A host-local fill/border on the track silently forks this strip from every
 * other tab strip in the app and from upstream — which is exactly the
 * regression this file guards. The popup panel's INNER content is the
 * component's own layout and stays fair game.
 *
 * Scope: this pins the COMPONENT's stylesheet. The theme-level dial rule in
 * theme.scss is a deliberate, separate decision (it rescales hikari's base
 * alpha rather than substituting a new look), so it is not asserted here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** The component's stylesheet, comments stripped: the prose here and in the
 *  SCSS deliberately NAME the library classes it does not touch, so both
 *  comment forms are removed before matching selectors. */
const css = readFileSync(
  join(process.cwd(), "src", "components", "base", "DateRangeTabs.scss"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("DateRangeTabs stylesheet contract", () => {
  it("never restyles hikari's tab-strip chrome", () => {
    // Matches the class NAME anywhere in the rule text, so attribute-selector
    // escapes ([class~="hk-tabs-list"]) cannot slip through either.
    expect(css).not.toMatch(/hk-tabs-(list|trigger|indicator)/);
  });

  it("still owns its own layout and popup content", () => {
    // Sanity: the file is not empty/vacuous — the wrapper and the picker
    // panel's inner content are the component's own surfaces.
    expect(css).toMatch(/\.date-range-tabs\b/);
    expect(css).toMatch(/\.date-range-pop\b/);
  });
});
