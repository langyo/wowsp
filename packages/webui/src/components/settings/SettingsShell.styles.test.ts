// @vitest-environment node
/**
 * Contract: the DESKTOP settings window keeps ONE constant frame height —
 * hikari's shipped `--hk-settings-height` band — for every section. WoWSP
 * overrides NO shell-height rule; the single host rule it does declare (the
 * desktop body-inner unpin) exists to keep HkModal's size morph honest on a
 * WINDOW resize, never to size the shell.
 *
 * Why this test exists (2026-11-17 user direction: "我不希望这个窗口的高度
 * 再变化了，直接固定最大的那个高度算了"): the desktop modal used to stand at
 * hikari's shipped band. The 2026-11-08 fix (#1834) made it HUG the active
 * section's cards instead (shell `height: auto`, the rail taken out of the
 * intrinsic height with `contain: size`, the body-inner pin dropped) so
 * short sections had no dead band under their last card; the 2026-11-11
 * follow-up (#1940) put a `min(24rem, band)` floor under that hug because
 * the shortest sections had collapsed the window into a sliver. The
 * 2026-11-17 direction retires BOTH: a window that grows and shrinks all
 * session is worse than a static one, and the dead band under a short
 * section is the accepted price. So the frame is back to the package's,
 * and this file is the guard that keeps it there.
 *
 * Three halves, all compiled (authoring nesting cannot hide a declaration)
 * with comments stripped — the prose in these sheets deliberately NAMES the
 * selectors it explains, so a comment must never satisfy an assertion:
 *
 * 1. WoWSP's sheet (src/components/settings/SettingsShell.scss) declares
 *    NOTHING that sizes the host frame: no `.hk-settings-host .hk-settings`
 *    rule (same-selector rules in our sheet would win on load order, and
 *    SettingsShell.tsx imports hikari's sheet first), no rail size
 *    containment, and no leftover token of the retired content-fit
 *    contract. The ONE host rule it declares is the desktop body-inner
 *    unpin (`height: auto`): hikari's 100% pin makes that box track
 *    HkModal's PINNED frame, and the size morph observes exactly this box —
 *    so under the pin a WINDOW resize never reaches the morph and the frame
 *    keeps the previous viewport's band (clipped on a grow) until reopen.
 *    Auto keeps the probe on the live shell while the shell height stays
 *    hikari's.
 * 2. The INSTALLED hikari sheet still ships the constant band AND the 100%
 *    body-inner pin the desktop unpin complements. It is resolved through
 *    the same package exports map the app's sass/vite pipeline uses (so the
 *    assertions follow the version pnpm-lock pins) and compiled the way a
 *    host pipeline compiles it. A hikari bump that swaps the band for a
 *    content fit — or drops the phone sheet's 100% fill — fails here loudly
 *    instead of silently re-opening #1834.
 * 3. The desktop gate (`min-width: 768px`) holds exactly TWO rules: the
 *    body-inner unpin above (desktop only — the phone sheet keeps hikari's
 *    100% fill) and the rail-entry no-crush pair (the fixed band is shorter
 *    than the full grouped rail, so the rail must scroll its entries, never
 *    squash them). Nothing may leak outside the gate: the phone anatomy is
 *    the HTabs strip and the /settings page never wears `.hk-settings-host`.
 *
 * How to revisit DELIBERATELY: the band is hikari's. Change it in hikari
 * (or pass HkSettingsDialog's `height` prop, which writes
 * `--hk-settings-height`) — never re-add a same-selector shell override in
 * SettingsShell.scss. If a content fit ever comes back as a product
 * decision, it must land together with (a) a new docblock in the sheet,
 * (b) a rewrite of this contract, and (c) the e2e frame assertions in
 * scripts/e2e/test_settings_layout.py — not as a "small fix" here.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { compile } from "sass";
import { describe, expect, it } from "vitest";

const req = createRequire(import.meta.url);

/** Compiled sheet with comments, CRLF and the (CJK-comment) @charset
 *  prelude removed: matching against the raw output would otherwise let a
 *  docblock satisfy — or trip — an assertion meant for a declaration. */
function cleanSheet(source: string): string {
  return source
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^@charset [^\n]*\n?/, "");
}

/** Our sheet, compiled standalone: it has no @use chain, so the dart-sass
 *  Node-package importer the Sidebar contract needs is not needed here. */
const css = cleanSheet(
  compile(resolve("src/components/settings/SettingsShell.scss"), {
    style: "expanded",
  }).css,
);

/** The INSTALLED hikari settings sheet — resolved through the package
 *  exports map, exactly like playtimeHeatmap.styles.test.ts resolves its
 *  shipped sheets, so these assertions follow the lockfile's version. */
const hikariSettingsSheet = req.resolve(
  "@celestia-island/hikari/components/HkSettingsDialog.scss",
);
const hikariCss = cleanSheet(
  compile(hikariSettingsSheet, { style: "expanded" }).css,
);

/** The shared settings CONTENT sheet (imported by the modal AND the page): a
 *  reintroduced frame override could hide there instead of our shell sheet,
 *  so the shell-element absence check runs over it too. It compiles
 *  standalone (no @use chain), like our shell sheet. */
const modalSheetCss = cleanSheet(
  compile(resolve("src/components/layout/SettingsModal.scss"), {
    style: "expanded",
  }).css,
);

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

interface CompiledRule {
  /** Selector text, whitespace-normalized (so a multi-line selector list
   *  reads as one comma-separated string). */
  selector: string;
  body: string;
}

/** Every flat rule in a compiled sheet, recursing into at-rules. Selector
 *  text is normalized, which is what the exact-selector absence checks
 *  below need: a stray `.hk-settings-host .hk-settings` rule has to be
 *  visible no matter where it hides (bare, in a media block, or in a
 *  selector list). */
function compiledRules(sheet: string): CompiledRule[] {
  const out: CompiledRule[] = [];
  let i = 0;
  while (i < sheet.length) {
    const open = sheet.indexOf("{", i);
    if (open < 0) break;
    const selector = sheet.slice(i, open).replace(/\s+/g, " ").trim();
    const block = blockRange(sheet, i);
    if (!block) break;
    if (selector.startsWith("@media")) {
      out.push(...compiledRules(block.body));
    } else if (selector !== "") {
      out.push({ selector, body: block.body });
    }
    i = block.end;
  }
  return out;
}

/** Bodies of every top-level `@media <header>` block in a compiled sheet.
 *  Sass hoists a nested media query out of its owning rule (hikari's phone
 *  shell rule ends up as its own block), so at-rule bodies are located by
 *  header rather than by position inside a selector. */
function mediaBlocks(sheet: string, header: string): string[] {
  const bodies: string[] = [];
  let i = sheet.indexOf(header);
  while (i >= 0) {
    const block = blockRange(sheet, i);
    if (block) {
      bodies.push(block.body);
      i = sheet.indexOf(header, block.end);
    } else {
      break;
    }
  }
  return bodies;
}

const rules = compiledRules(css);

/** The shell element under the host class, whatever the combinator — a frame
 *  override must not return under ANY shape (descendant, child, selector
 *  list). The negative lookahead keeps `.hk-settings__pane` / `__rail` out. */
const HOST_SHELL_RULE = /\.hk-settings-host[\s>+~]+\.hk-settings(?![\w-])/;

describe("WoWSP's sheet leaves the host frame HEIGHT to hikari", () => {
  it("declares no rule on the desktop shell element", () => {
    // The shell itself (`.hk-settings-host .hk-settings`) and its state
    // variants are hikari's: a same-selector rule here would win on load
    // order and fork the frame. Both settings sheets are scanned, because a
    // future override could just as well hide in the shared content sheet.
    const sheets: Array<[string, string]> = [
      ["SettingsShell.scss", css],
      ["SettingsModal.scss", modalSheetCss],
    ];
    for (const [name, sheet] of sheets) {
      const shellRules = compiledRules(sheet).filter((rule) =>
        HOST_SHELL_RULE.test(rule.selector),
      );
      expect(shellRules.map((rule) => rule.selector), name).toEqual([]);
    }
  });

  it("unpins the modal body inner on desktop so a window resize re-measures", () => {
    // Hikari pins it at height: 100%, which ties the observed box to HkModal's
    // PINNED frame; the size morph observes THIS element, so under the pin a
    // window resize changes the shell but never the observed box — the morph
    // never fires and the frame keeps the old viewport's height (clipped on a
    // grow). Auto restores the probe. It must stay desktop-only (the gate and
    // scoping cases below) and must never become shell sizing: the shell
    // height is hikari's band.
    const innerRules = rules.filter((rule) =>
      rule.selector.includes(".hk-modal-body-inner"),
    );
    expect(innerRules.map((rule) => rule.selector)).toEqual([
      ".hk-settings-host .hk-modal-body-inner",
    ]);
    expect(innerRules[0].body).toMatch(/(?:^|\n)\s*height:\s*auto;/);
    expect(innerRules[0].body).not.toMatch(/height:\s*100%/);
  });

  it("never takes the rail out of its own height", () => {
    // `contain: size` made the rail contribute zero intrinsic height so an
    // auto shell could size from the cards. With the constant band the
    // rail's own overflow is what must stay scrollable.
    expect(css).not.toMatch(/contain:\s*size/);
  });

  it("carries no leftover of the retired content-fit contract", () => {
    // Whole-sheet text checks: the band formula, its variable and the #1940
    // floor are gone. The only `height: auto` left is the body-inner unpin
    // above (a probe fix, not shell sizing); any other auto height is the
    // 2026-11-08 hug coming back, which is exactly the review this contract
    // forces.
    expect(css).not.toContain("--hk-settings-height");
    expect(css).not.toContain("70vh - 6.5rem");
    expect(css).not.toContain("min(24rem");
    for (const rule of rules) {
      if (rule.selector.includes(".hk-modal-body-inner")) continue;
      expect(rule.body, rule.selector).not.toMatch(/(?:^|\n)\s*height:\s*auto/);
    }
  });
});

describe("the installed hikari sheet owns the constant band", () => {
  it("ships the 100% body-inner pin that the desktop unpin complements", () => {
    // The shipped pin is why the desktop unpin exists (see the sheet's
    // docblock): it ties the morph's observed box to the pinned frame. A
    // hikari bump that drops the pin makes the unpin redundant, not wrong —
    // but the pair is the contract, so both halves are asserted.
    const inner = ruleBody(
      hikariCss,
      ".hk-settings-host .hk-modal-body-inner {",
    );
    expect(inner, "hikari still pins the body inner").not.toBeNull();
    expect(inner).toMatch(/height:\s*100%;/);
  });

  it("sizes the desktop shell at the shipped band, never from content", () => {
    const shell = ruleBody(hikariCss, ".hk-settings-host .hk-settings {");
    expect(shell, "hikari still sizes the desktop shell").not.toBeNull();
    // The exact band expression the 2026-11-17 direction fixed the window
    // at: 70vh - 6.5rem (526px at the e2e's 1440x900 viewport).
    expect(shell).toMatch(
      /height:\s*var\(--hk-settings-height,\s*calc\(70vh - 6\.5rem\)\);/,
    );
    // A bump that turns the band into a content fit re-opens #1834: an
    // auto height, a floor or a cap in this rule is that regression.
    expect(shell).not.toMatch(/(?:^|\n)\s*height:\s*auto/);
    expect(shell).not.toMatch(/(?:^|\n)\s*min-height:/);
    expect(shell).not.toMatch(/(?:^|\n)\s*max-height:/);
  });

  it("keeps the phone sheet filling its docked body", () => {
    // Sass hoists the nested media query out of the owning rule, so the
    // phone half is its own block; find the one that carries the shell
    // selector and pin the 100% fill (the 2026-11-02 phone-sheet fix).
    const phoneShells = mediaBlocks(hikariCss, "@media (max-width: 767px)")
      .map((body) => ruleBody(body, ".hk-settings-host .hk-settings {"))
      .filter((body): body is string => body !== null);
    expect(
      phoneShells.length,
      "the phone shell block still exists",
    ).toBeGreaterThan(0);
    for (const phone of phoneShells) {
      expect(phone).toMatch(/height:\s*100%;/);
      // The band is desktop-only: the phone sheet must not resurrect it.
      expect(phone).not.toContain("--hk-settings-height");
    }
  });
});

describe("the desktop gate", () => {
  const gateAt = css.indexOf("@media (min-width: 768px)");
  it("exists exactly once", () => {
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(css.indexOf("@media (min-width: 768px)", gateAt + 1)).toBe(-1);
  });

  const gate = gateAt < 0 ? null : blockRange(css, gateAt);
  const gateRules = gate ? compiledRules(gate.body) : [];

  it("holds exactly the body-inner unpin and the rail-entry no-crush pair", () => {
    // The shell-height override left this block on 2026-11-17; the two rules
    // here are the desktop-only pair this sheet still owns — the unpin (a
    // size-morph probe fix, not shell sizing) and the entry rule (the rail
    // keeps its authored height and scrolls instead of crushing). Anything
    // else in this gate is a content-fit reintroduction.
    expect(gate, "the desktop gate has a body").not.toBeNull();
    expect(gateRules.map((rule) => rule.selector)).toEqual([
      ".hk-settings-host .hk-modal-body-inner",
      ".hk-settings-host .hk-settings__rail .hk-nav-item, .hk-settings-host .hk-settings__rail .hk-settings__rail-item",
    ]);
  });

  it("keeps the body-inner unpin at height: auto inside the gate", () => {
    // Desktop only: the phone sheet (≤767px) keeps hikari's 100% fill, which
    // the scoping case below asserts. Asserted INSIDE the owning rule: a
    // stray declaration elsewhere must not satisfy the contract.
    const unpin = gateRules[0];
    expect(unpin, "the body-inner unpin rule exists").toBeDefined();
    expect(unpin.body).toMatch(/(?:^|\n)\s*height:\s*auto;/);
    expect(unpin.body).not.toMatch(/height:\s*100%/);
  });

  it("keeps the rail entries at their own height inside that rule", () => {
    // The constant band is shorter than the full grouped rail, so the rail
    // scrolls; without `flex: none` the flex column crushes the entries
    // (the 2026-11-11 squashed-rows bug). Asserted INSIDE the owning rule:
    // a stray declaration elsewhere in the gate must not satisfy it.
    const entryRule = gateRules[1];
    expect(entryRule, "the rail-entry rule exists").toBeDefined();
    expect(entryRule.body).toMatch(/(?:^|\n)\s*flex:\s*none;/);
    expect(entryRule.body).toMatch(/(?:^|\n)\s*min-height:\s*2\.25rem;/);
  });

  it("scopes every host frame rule out of the phone/page sheet", () => {
    // Below 768px the grouped rail is not rendered (the phone anatomy is
    // the HTabs strip) and the /settings page never wears the host class:
    // no host-scoped rail/frame rule may live outside the gate.
    expect(gate).not.toBeNull();
    const unscoped = css.slice(0, gateAt) + css.slice(gate!.end);
    expect(unscoped).not.toContain(".hk-settings-host .hk-settings__rail");
    expect(unscoped).not.toMatch(HOST_SHELL_RULE);
    expect(unscoped).not.toContain(".hk-modal-body-inner");
  });
});
