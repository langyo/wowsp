// @vitest-environment node
/**
 * Stylesheet contract of the resource inventory's N/A placeholder chip.
 *
 * 2026-11-10 user report: the placeholder was authored with only muted ink
 * and a faint border, and the theme's own default-chip surface pass
 * (`:root .hk-tag-default`, 0,2,0, emitted AFTER this chunk in the bundle)
 * repainted its fill white — the chip stopped reading as grey at all.
 *
 * What is pinned here (assertions run on the COMPILED sheet, authoring
 * nesting cannot hide a declaration, and every declaration is asserted
 * INSIDE the rule that owns it — the same conventions as
 * SettingsShell.styles.test.ts / Sidebar.rail.styles.test.ts):
 *
 * 1. The placeholder rule out-ranks the theme's default-chip surface. Three
 *    class selectors (0,3,0) beat `:root .hk-tag-default` (0,2,0) no matter
 *    which chunk's CSS lands later, so the grey fill cannot be washed out
 *    again by load order or by the lowered UI-opacity dial.
 * 2. The grey vocabulary itself: a muted translucent fill, muted ink and a
 *    slightly stronger muted border — the three declarations a future theme
 *    edit must keep.
 * 3. The phone layout keeps hiding the placeholder cells: the N/A chip is a
 *    desktop-table affordance, and the stacked row must show only real facts.
 */
import { resolve } from "node:path";

import { compile } from "sass";
import { describe, expect, it } from "vitest";

/** The compiled sheet, comments stripped: the prose above deliberately NAMES
 *  the selectors it explains, so matching the raw output would pass on
 *  comments alone. */
const css = compile(resolve("src/components/layout/SettingsModal.scss"), {
  style: "expanded",
})
  .css.replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Brace-matched block opened at/after `from`: a nested at-rule or rule
 *  stays part of the body instead of truncating it at its first "}". */
function blockRange(
  source: string,
  from: number,
): { body: string; end: number } | null {
  const open = source.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { body: source.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Body of the first rule whose selector text matches exactly (the trailing
 *  brace is part of the probe, so a longer selector cannot match a prefix). */
function ruleBody(source: string, selector: string): string | null {
  const at = source.indexOf(selector);
  return at < 0 ? null : (blockRange(source, at)?.body ?? null);
}

const NA_RULE = ".settings-modal__res-inv-cell--na .settings-modal__res-inv-tag-na.hk-tag {";

describe("resource inventory N/A placeholder stylesheet contract", () => {
  it("out-ranks the theme's default-chip surface with three class selectors", () => {
    // The selector exists exactly as authored: the cell ancestor leaves three
    // class tokens (0,3,0), which beats BOTH the plain hikari
    // `.hk-tag-default` (0,1,0) and the theme's `:root .hk-tag-default`
    // restatement (0,2,0). A weaker selector would silently repaint the chip
    // with the default surface fill again — exactly the reported defect.
    expect(ruleBody(css, NA_RULE), "the N/A placeholder rule exists").not.toBeNull();
    const selector = NA_RULE.slice(0, -2);
    const classes = selector.match(/\.[^\s.:>+~]+/g) ?? [];
    expect(classes.length, "three class tokens keep the (0,3,0) rank").toBe(3);
    expect(classes).toContain(".hk-tag");
  });

  it("keeps the placeholder visibly grey (muted fill, ink and border)", () => {
    const body = ruleBody(css, NA_RULE);
    expect(body, "the N/A placeholder rule exists").not.toBeNull();
    // A translucent muted fill is what makes the chip read as grey; the
    // default-chip surface (opaque) is precisely what used to win.
    expect(body).toMatch(/background:\s*rgb\(var\(--color-muted\)\s*\/\s*15%\)/);
    expect(body).toMatch(/color:\s*rgb\(var\(--color-muted\)\)/);
    expect(body).toMatch(/border-color:\s*rgb\(var\(--color-muted\)\s*\/\s*25%\)/);
  });

  it("hides the placeholder cells in the phone layout", () => {
    const mediaAt = css.indexOf("@media (max-width: 767px)");
    expect(mediaAt, "the phone media block exists").toBeGreaterThan(-1);
    const media = blockRange(css, mediaAt);
    expect(media, "the phone media block has a body").not.toBeNull();
    // The N/A placeholder is a desktop-table affordance: the stacked row
    // shows only real facts, so its cells drop out entirely.
    const naCell = ruleBody(
      media!.body,
      ".settings-modal__res-inv-cell--na {",
    );
    expect(naCell, "the phone N/A cell rule exists").not.toBeNull();
    expect(naCell).toMatch(/display:\s*none/);
  });
});
