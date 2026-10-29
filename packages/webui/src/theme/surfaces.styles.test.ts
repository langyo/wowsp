/**
 * Contract: the app ships OPAQUE surfaces by default, and every glass fill is
 * driven by ONE dial.
 *
 * theme/surfaces.scss is the single place that restates hikari's hardcoded
 * translucent fills (`.hk-tabs-list` 60%, `.hk-input-box` 55%, the floating
 * layers, …), so the shipped look is fully opaque and the UI-surface-opacity
 * preference (`--ui-opacity`, written by theme/uiOpacityPreference.ts) is the
 * only way to reintroduce glass:
 *
 *     alpha(B) = B + (100 - B) * var(--ui-opacity, 1)
 *
 * This file pins the model so it cannot rot:
 *  1. each LIVE hikari surface the app mounts has BOTH an opaque fallback and
 *     a per-selector dial block (deleting one dial block must fail here);
 *  2. the stylesheet default is solidity 1;
 *  3. no app stylesheet uses any other way of feeding the dial into a fill —
 *     the old `calc(B% * var(--ui-opacity))` multiplier (which would invert the
 *     dial) and its decimal / reordered spellings are all rejected;
 *  4. the wallpaper carrier band is deliberately NOT a dial surface.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** Strip CSS comments — the prose names the library classes and the old
 *  formula on purpose, only real declarations/selectors may be asserted. */
function code(scss: string): string {
  return scss.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const surfaces = code(readFileSync(join(SRC, "theme", "surfaces.scss"), "utf8"));

/** Every rule (selector + body) whose selector mentions `selector` (escaped
 *  literal, with a boundary guard so `.hk-minimap` does not match
 *  `.hk-minimap--collapsed`). */
function rulesFor(css: string, selector: string): { selector: string; body: string }[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`([^{}]*${escaped}(?![-\\w])[^{}]*)\\{([^}]*)\\}`, "g");
  const out: { selector: string; body: string }[] = [];
  for (const match of css.matchAll(re)) out.push({ selector: match[1], body: match[2] });
  return out;
}

/** A rule is a STATE rule when its selector adds a pseudo-class/attribute or a
 *  compound after the class (e.g. `:focus-within`, `[data-state="open"]`,
 *  `button.`). The opaque FALLBACK must be a plain base rule: a state face
 *  cannot stand in for it. */
function isStateRule(selector: string): boolean {
  // Only interaction/state markers count — the captured chunk may also carry
  // an @supports header (with colons of its own), so a bare `:` is too broad.
  return /(:focus|:hover|:active|:disabled|:checked|\[data-state|\[data-active)/.test(selector);
}

/** Balanced-paren `calc(...)` expressions containing the dial — greedy regexes
 *  would let a second (bad) calc in the same declaration slip through. */
function dialCalcs(css: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < css.length; i++) {
    if (!css.startsWith("calc(", i)) continue;
    let depth = 0;
    let end = -1;
    for (let j = i + 4; j < css.length; j++) {
      if (css[j] === "(") depth++;
      else if (css[j] === ")") {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) continue;
    const expr = css.slice(i, end + 1);
    if (expr.includes("var(--ui-opacity")) out.push(expr);
  }
  return out;
}

/** Every SCSS file under src (the app's own stylesheets). */
function allScss(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allScss(full));
    else if (entry.name.endsWith(".scss")) out.push(full);
  }
  return out;
}

/** The surfaces the layer restates as "live" — hikari chrome the app mounts
 *  (directly or through shared hosts); each must carry a base fallback and a
 *  dial. The upstream admin/legacy classes are intentionally not pinned; the
 *  --hi-color-bg-subtle tint family (tables, grids, HkDraggableList) is a tint,
 *  not glass, and stays outside by design. */
const LIVE_SURFACES = [
  ".hk-tabs-list",
  ".hk-settings-group",
  ".hk-pill-group",
  ".hk-tag-default",
  ".hk-input-box",
  ".hk-select-trigger",
  ".hk-select-popout",
  ".hk-popup-select-trigger",
  ".hk-dp-trigger",
  ".hk-dp-native",
  ".hk-scroll-container-autotag",
  ".hk-fab-mini",
  ".hk-markdown-overlay",
  ".hk-icon-group",
  ".hk-minimap",
  ".hk-persistent-toast",
];

describe("opaque-default surface layer", () => {
  it("gives every live hikari surface an opaque BASE fallback AND its own dial block", () => {
    const missing: string[] = [];
    for (const selector of LIVE_SURFACES) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const own = new RegExp(`${escaped}(?![-\\w])`);
      const rules = rulesFor(surfaces, selector);
      // A rule's selector chunk may be a whole group list; judge only the
      // segments that actually carry THIS selector.
      const segments = (chunk: string) =>
        chunk
          .split(",")
          .map((part) => part.trim())
          .filter((part) => own.test(part));
      // 1) the opaque fallback must be a BASE segment (no :state / [attr] face
      //    may stand in for it);
      const hasOpaqueBase = rules.some(
        (rule) =>
          segments(rule.selector).some((seg) => !isStateRule(seg)) &&
          /background:\s*rgb\(var\(--color-(surface|background)\)\)/.test(rule.body),
      );
      // 2) the dial must live in a rule of THIS selector — a rule elsewhere in
      //    the file must not satisfy the check.
      const hasDial = rules.some(
        (rule) =>
          segments(rule.selector).length > 0 && rule.body.includes("var(--ui-opacity, 1)"),
      );
      if (!hasOpaqueBase || !hasDial) missing.push(selector);
    }
    expect(missing).toEqual([]);
  });

  it("keeps the icon-group's frameless variants out of the layer", () => {
    // The plain/slider variants paint transparent on purpose; the :root prefix
    // would otherwise outrank them, so NO un-guarded .hk-icon-group selector
    // may exist anywhere in the layer.
    const rules = rulesFor(surfaces, ".hk-icon-group");
    expect(rules.length).toBeGreaterThan(0);
    expect(surfaces).toContain(
      ":root .hk-icon-group:not(.hk-icon-group-plain):not(.hk-icon-group-slider)",
    );
    expect(surfaces).not.toMatch(/:root \.hk-icon-group(?!:not\()/);
  });

  it("ships solidity 1 as the stylesheet default", () => {
    const theme = code(readFileSync(join(SRC, "theme", "theme.scss"), "utf8"));
    expect(theme).toMatch(/--ui-opacity:\s*1;/);
  });

  it("only ever feeds the dial through the documented lerp", () => {
    // Accept `calc(<B>% + <100-B>% * var(--ui-opacity, 1))` — nothing else.
    const lerp =
      /^calc\(\s*\d+(?:\.\d+)?%\s*\+\s*\d+(?:\.\d+)?%\s*\*\s*var\(--ui-opacity,\s*1\)\s*\)$/;
    const offenders: string[] = [];
    for (const file of allScss(SRC)) {
      const text = code(readFileSync(file, "utf8"));
      for (const expr of dialCalcs(text)) {
        if (!lerp.test(expr)) offenders.push(`${file.replace(SRC, "src")}: ${expr}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the wallpaper carrier band outside the dial", () => {
    // The shell's content band is the page canvas, not a surface: it must not
    // be driven by the dial, or the wallpaper feature would be dead at the
    // opaque default.
    const shell = code(readFileSync(join(SRC, "components", "layout", "AppShell.scss"), "utf8"));
    const band = shell.slice(shell.indexOf("&__main"), shell.indexOf("&__scroll"));
    expect(band).toContain("html[data-wallpaper-art=\"true\"] &");
    expect(band).not.toContain("var(--ui-opacity");
  });
});
