// @vitest-environment node
/**
 * Stylesheet contract of the bottom-left player HUD's shared block width.
 *
 * 2026-11-11 user report (replay playback HUD): the hull plaque row and the
 * playback bar under it did not share a width — the bar's right edge sat
 * ~58px short of the stats strip's right edge (circled in the report), and
 * the plaque row was shrink-to-fit while the bar sized itself from its
 * controls, so no CSS declaration connected the two. The fix locks ONE
 * width for the block: the plaque (16rem) + row gap (10px) + stats strip
 * (16rem) fill both the shipcard row and the playback bar's box, so the
 * plaque's left edge lands on the bar's left edge and the stats strip's
 * right edge lands on the bar's right edge at every width.
 *
 * What is pinned here (compiled sheets, so authoring nesting cannot hide a
 * declaration; every assertion is scoped INSIDE the rule that owns it, the
 * same conventions as SettingsShell.styles.test.ts /
 * SettingsModal.resInvNa.styles.test.ts):
 *
 * 1. The block width contract itself: the custom properties exist and the
 *    playback bar is sized by them (not by its content).
 * 2. The row spans the bar's box (width: 100%), keeps the SAME
 *    minimap-clearance clamp the bar uses, and the stats strip is pinned to
 *    the other half of the block with its right edge on the block's right
 *    edge (`margin-left: auto`).
 * 3. The arithmetic agrees with the parts it is made of — plaque width from
 *    the @wowsp/holo package + the row gap + the strip width == the block
 *    width (which is the bar's border box). A future edit to any one of
 *    those values fails here instead of silently re-opening the
 *    misalignment.
 * 4. The two degradation regimes keep the contract: narrow map panes drop
 *    the width lock so the transport controls cannot paint outside the
 *    bar's glass, and the phone layout re-claims its full-bleed two-line
 *    bar (the fixed block is a desktop contract).
 */
import { resolve } from "node:path";

import { compile } from "sass";
import { describe, expect, it } from "vitest";

/** Compiled HUD sheet, comments stripped: the prose above deliberately
 *  NAMES selectors, so matching the raw output would pass on comments
 *  alone. */
const css = compile(
  resolve("src/features/holographic/HolographicMap.scss"),
  { style: "expanded" },
)
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

/** Number of `rem` units in a declaration value, e.g. `33.25rem` → 33.25. */
function remOf(body: string | null, declaration: string): number {
  const m = body?.match(new RegExp(declaration + ":\\s*([\\d.]+)rem"));
  expect(m, declaration + " is a rem value").not.toBeNull();
  return Number(m![1]);
}

/** Line-anchored selector probes: several rules restate these exact
 *  selectors (the light-mode root override, the grouped hint/controls
 *  rule), and an unanchored indexOf would grab the first one and pin the
 *  WRONG declarations. The compiled sheet puts every standalone rule at
 *  the start of a line. */
const ROOT_RULE = "\n.holo-map {";
const CONTROLS_RULE = "\n.holo-map__controls {";
const SHIPCARD_RULE = "\n.holo-map__shipcard {";
const STATS_RULE = "\n.holo-map__selfstats {";

describe("bottom-left player HUD block width contract", () => {
  it("declares the block width and the shared horizontal padding token", () => {
    const root = ruleBody(css, ROOT_RULE);
    expect(root, "the .holo-map root rule exists").not.toBeNull();
    // The gap stays a PIXEL token: a root-font change must scale the cards
    // (16rem each), never turn the 10px row gap into a rem value.
    expect(root).toMatch(/--holo-hud-block-w:\s*calc\(32rem \+ 10px\)/);
    expect(root).toMatch(/--holo-hud-pad-x:\s*10px/);
  });

  it("sizes the playback bar from the block contract, not from its content", () => {
    const controls = ruleBody(css, CONTROLS_RULE);
    expect(controls, "the playback bar rule exists").not.toBeNull();
    // Sass folds `calc(100cqw - 192px)` into the bare subtraction inside
    // min(), so accept either spelling of the SAME clamp expression.
    expect(controls).toMatch(/width:\s*min\(var\(--holo-hud-block-w\),\s*(calc\()?100cqw - 192px/);
    expect(controls).toMatch(/padding:\s*6px var\(--holo-hud-pad-x\)/);
  });

  it("spans the shipcard row across the bar's box and clamps it to the same band", () => {
    const shipcard = ruleBody(css, SHIPCARD_RULE);
    expect(shipcard, "the shipcard row rule exists").not.toBeNull();
    expect(shipcard).toMatch(/width:\s*100%/);
    // The SAME minimap-clearance reserve as the controls clamp: a row that
    // clamps at a different width would re-open the right-edge gap on
    // narrow maps.
    expect(shipcard).toMatch(/max-width:\s*calc\(100cqw - 192px\)/);
  });

  it("pins the stats strip to the other half, right edge on the block's edge", () => {
    const stats = ruleBody(css, STATS_RULE);
    expect(stats, "the stats strip rule exists").not.toBeNull();
    expect(stats).toMatch(/flex:\s*0 1 16rem/);
    expect(stats).toMatch(/width:\s*16rem/);
    expect(stats).toMatch(/margin-left:\s*auto/);
    // A wrapped phone line must never spill out of the row.
    expect(stats).toMatch(/max-width:\s*100%/);
  });

  it("keeps the parts in arithmetic agreement with the block width", () => {
    const root = ruleBody(css, ROOT_RULE);
    const blockRem = Number(root?.match(/calc\((\d+)rem \+ \d+px\)/)![1]);
    const holoCss = compile(resolve("../holo/src/HoloShipCard.scss"), {
      style: "expanded",
    })
      .css.replace(/\r\n/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const plaqueRem = remOf(ruleBody(holoCss, "\n.holo-ship-card {"), "width");
    const shipcard = ruleBody(css, SHIPCARD_RULE);
    const stats = ruleBody(css, STATS_RULE);
    // The row's gap is the flex gap on the shipcard rule (10px).
    const gapPx = Number(shipcard?.match(/gap:\s*(\d+)px/)![1]);
    const statsRem = remOf(stats, "width");
    // The bar draws no border, so its box === the row's box; both must be
    // exactly plaque + gap + strip, or the pinned right edge drifts.
    const blockPx = blockRem * 16 + Number(root?.match(/calc\(32rem \+ (\d+)px\)/)![1]);
    const rowPx = plaqueRem * 16 + gapPx + statsRem * 16;
    expect(blockPx, "block width = plaque + gap + stats strip").toBe(rowPx);
  });

  it("lets the phone layout reclaim the full-bleed bar", () => {
    const mediaAt = css.indexOf("@media (max-width: 767px)");
    expect(mediaAt, "the phone media block exists").toBeGreaterThan(-1);
    const media = blockRange(css, mediaAt);
    expect(media, "the phone media block has a body").not.toBeNull();
    const phoneControls = ruleBody(media!.body, ".holo-map__controls {");
    expect(phoneControls, "the phone playback bar rule exists").not.toBeNull();
    expect(phoneControls).toMatch(/right:\s*12px/);
    expect(phoneControls).toMatch(/width:\s*auto/);
    // The one-line phone padding replaces the desktop `6px var(...)`; the
    // block width token must NOT leak into the phone line.
    expect(phoneControls).toMatch(/padding:\s*8px/);
    expect(phoneControls).not.toMatch(/--holo-hud-block-w/);
  });

  it("wraps the transport inside the locked width on narrow map panes", () => {
    const narrowAt = css.indexOf("@container (max-width: 600px)");
    expect(narrowAt, "the narrow-container fallback exists").toBeGreaterThan(-1);
    const narrow = blockRange(css, narrowAt);
    expect(narrow, "the narrow-container fallback has a body").not.toBeNull();
    const bar = ruleBody(narrow!.body, ".holo-map__controls {");
    expect(bar, "the fallback bar rule exists").not.toBeNull();
    // The width lock STAYS (a width release let the row overlap the
    // minimap thumb); only the flex line re-flows.
    expect(bar).toMatch(/flex-wrap:\s*wrap/);
    expect(bar).not.toMatch(/width:\s*auto/);
    expect(bar).not.toMatch(/max-width/);
    // ...and the row must keep its 192px minimap clearance.
    expect(narrow!.body).not.toContain(".holo-map__shipcard {");
  });

  it("lets the 2x2 stats grid fill its wrapped line", () => {
    const gridAt = css.indexOf("@container (max-width: 500px)");
    expect(gridAt, "the 2x2 stats-grid degradation exists").toBeGreaterThan(-1);
    const grid = blockRange(css, gridAt);
    const stats = ruleBody(grid!.body, ".holo-map__selfstats {");
    expect(stats, "the 2x2 grid rule exists").not.toBeNull();
    // Without this reset the auto margin above swallows the free space the
    // grid's flex-grow needs, and the wrapped strip re-hugs right instead of
    // filling the row's second line.
    expect(stats).toMatch(/margin-left:\s*0/);
    expect(stats).toMatch(/flex-grow:\s*1/);
  });
});
