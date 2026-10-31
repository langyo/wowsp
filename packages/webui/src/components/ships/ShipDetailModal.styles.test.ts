/**
 * Contract: the spec panel's help icons sit centered on their labels.
 *
 * Section labels ("HE Shell", "AP Shell", …) used to be plain inline spans,
 * so their inline-flex help icon sat on the text baseline — visibly low and
 * flush against the label. The label must own a centered flex row with its
 * own gap, and the icon must not re-introduce line-box baseline drift.
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
