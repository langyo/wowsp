// @vitest-environment node
/**
 * Stylesheet contract of the desktop settings window's content-fit frame
 * (2026-11-08) — same conventions as Sidebar.rail.styles.test.ts /
 * waterTables.styles.test.ts: assertions run on the COMPILED sheet
 * (authoring nesting cannot hide a declaration) and every declaration is
 * asserted INSIDE the rule that owns it, never just somewhere in the file.
 * The sheet has no @use chain, so it compiles standalone and the dart-sass
 * Node-package importer used by the Sidebar contract is not needed here.
 *
 * What is pinned — the three load-bearing halves of the frame fix:
 *
 * 1. The modal host's body-inner goes `height: auto`. Hikari's
 *    HkSettingsDialog.scss pins it at 100%; with an auto shell that pin
 *    feeds the OLD body height back into HkModal's useSizeMorph content
 *    probe, so a released frame measures its own previous height and the
 *    window can never shrink (the 2026-11-04 phone-sheet freeze class).
 * 2. The shell sizes from the active section's cards (`height: auto`)
 *    between a presentable floor and hikari's old frame formula as the cap
 *    (min-height: min(24rem, band) / max-height: band) — short sections
 *    never collapse the window into a sliver (2026-11-11 user report),
 *    long sections keep the capped frame and the pane stays the sole
 *    scroller.
 * 3. The rail — a HkScrollContainer whose intrinsic height is its (long)
 *    nav list — stops driving the shell height via `contain: size`; the
 *    flex stretch then sizes it from the pane.
 * 4. All three live under the desktop-only `@media (min-width: 768px)`
 *    gate: phones keep hikari's docked-sheet contract and the /settings
 *    page never carries `.hk-settings-host`, so nothing content-fit may
 *    leak into the un-scoped part of the sheet.
 */
import { resolve } from "node:path";

import { compile } from "sass";
import { describe, expect, it } from "vitest";

/** The compiled sheet, comments stripped: the prose above deliberately
 *  NAMES the selectors it explains, so matching against the raw output
 *  would pass on comments alone. */
const css = compile(resolve("src/components/settings/SettingsShell.scss"), {
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

/** Body of the first rule whose selector text matches exactly (the
 *  trailing brace is part of the probe, so ".hk-settings" cannot match
 *  ".hk-settings__pane" — the scoping helper hikari's own style tests
 *  use, adapted to brace matching for at-rule bodies). */
function ruleBody(source: string, selector: string): string | null {
  const at = source.indexOf(selector);
  return at < 0 ? null : (blockRange(source, at)?.body ?? null);
}

const mediaAt = css.indexOf("@media (min-width: 768px)");
if (mediaAt < 0) throw new Error("desktop media gate missing from compiled sheet");
const desktopBlock = blockRange(css, mediaAt);
if (!desktopBlock) throw new Error("desktop media gate has no body");
const desktop = desktopBlock.body;
/** The sheet minus the desktop gate's body: the phone/page path. */
const unscoped = css.slice(0, mediaAt) + css.slice(desktopBlock.end);

describe("settings content-fit stylesheet contract", () => {
  it("scopes the whole contract to ONE desktop-only media gate", () => {
    // A second desktop block would split the contract (and could drift).
    expect(css.indexOf("@media (min-width: 768px)", mediaAt + 1)).toBe(-1);
    // ...and nothing content-fit may reach the un-scoped phone/page sheet.
    expect(unscoped).not.toContain(".hk-settings-host .hk-modal-body-inner");
    expect(unscoped).not.toContain(".hk-settings-host .hk-settings__rail");
    expect(unscoped).not.toMatch(/\.hk-settings-host \.hk-settings\s*\{/);
  });

  it("unpins the body inner so HkModal's morph can measure a shrink", () => {
    const inner = ruleBody(desktop, ".hk-settings-host .hk-modal-body-inner {");
    expect(inner, "the body-inner override exists").not.toBeNull();
    expect(inner).toMatch(/height:\s*auto;/);
    // Hikari's 100% pin is exactly the shape that freezes the frame.
    expect(inner).not.toMatch(/height:\s*100%/);
  });

  it("sizes the shell from content and keeps the old frame as the cap only", () => {
    const shell = ruleBody(desktop, ".hk-settings-host .hk-settings {");
    expect(shell, "the shell override exists").not.toBeNull();
    expect(shell).toMatch(/height:\s*auto;/);
    // The old frame formula survives as the cap, so long sections keep the
    // capped shell (and the pane's edge bar remains the only scrollbar).
    expect(shell).toMatch(
      /max-height:\s*var\(--hk-settings-height,\s*calc\(70vh - 6\.5rem\)\);/,
    );
    // The pre-fix pin (hikari's unconditional height: var(...)) must not
    // remain: the cap lives on max-height, never on height. Anchored to a
    // declaration's line start so "max-height:" cannot satisfy it.
    expect(shell).not.toMatch(/(?:^|\n)\s*height:\s*var\(--hk-settings-height/);
  });

  it("keeps a presentable floor under short sections, clamped to the cap", () => {
    const shell = ruleBody(desktop, ".hk-settings-host .hk-settings {");
    expect(shell, "the shell override exists").not.toBeNull();
    // The full hug let the shortest sections (语言's single card) collapse
    // the window into a sliver (2026-11-11 user report): the floor keeps a
    // presentable frame.
    expect(shell).toMatch(
      /min-height:\s*min\(24rem,\s*var\(--hk-settings-height,\s*calc\(70vh - 6\.5rem\)\)\);/,
    );
    // min-height wins over max-height in CSS, so an unclamped floor would
    // push the shell past the cap (overflowing the modal scroller) on
    // short viewports: the floor must ride the band clamp, never stand
    // alone.
    expect(shell).not.toMatch(/min-height:\s*24rem;/);
  });

  it("takes the rail out of the shell's intrinsic height", () => {
    const rail = ruleBody(
      desktop,
      ".hk-settings-host .hk-settings__rail.hk-scroll-container {",
    );
    expect(rail, "the rail containment rule exists").not.toBeNull();
    expect(rail).toMatch(/contain:\s*size;/);
    // Containment is the whole rail change: geometry (width, flex, the
    // scroll-container anatomy) stays owned by hikari's shell rule.
    expect(rail).not.toMatch(/width:/);
    expect(rail).not.toMatch(/height:/);
  });
});
