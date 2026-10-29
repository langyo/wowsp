/**
 * Contract: DateRangeTabs does not re-paint hikari's segmented-track chrome.
 *
 * hikari paints the segmented track, the naked triggers and the primary/12%
 * indicator (HkTabs.scss); the app restates that one track fill in its
 * surface layer (theme/surfaces.scss — opaque by default, dial-driven), and
 * every other tab strip in the app gets the same treatment. A host-local
 * fill/border here would make this strip the odd member of that family and
 * fork it from the library for no API reason — exactly the regression this
 * file guards. The popup panel's INNER content is the component's own
 * layout and stays fair game.
 *
 * Scope: this pins the COMPONENT's stylesheet only. The track fill lives in
 * the single surface layer by design, so its opaque default is asserted
 * there (theme/surfaces.styles.test.ts), not here.
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
