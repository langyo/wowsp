// @vitest-environment node
/**
 * Contract: every WoWSP window rides hikari's DEFAULT desktop open/close
 * choreography — one compositor-only whole-window
 * `translateY(10px) scale(0.97)` + fade (hikari #1149, shipped in 0.55.311),
 * NOT the retired 0.55.307–310 layout-height ride and NOT the earlier
 * content-region scale / clip grammar.
 *
 * Why this test exists: the motion lives entirely in the installed hikari
 * sheet, so a version bump can silently change how every window arrives and
 * leaves without touching a single WoWSP file. The first half compiles the
 * INSTALLED package sheet and pins the mechanism: the frame keeps its
 * centring transform prefix (the shift tokens included), the desktop
 * enter/leave legs only move opacity + transform, and the layout-animating
 * ride left nothing behind. The second half keeps WoWSP's own sheets OFF
 * the frame's motion axes: token and sizing overrides are fine (the report
 * window's content-sized frame, the wizard tint, the confirm-dialog width
 * hatch), but a host transform / transition / will-change on
 * `.hk-modal-content` would fight the mechanism the same way a host rule
 * rewriting the old grammar did.
 *
 * The sheet is COMPILED from the package (not a vendored copy), so these
 * assertions follow the release pnpm-lock actually pins. Revisit this file
 * deliberately whenever the window choreography is re-chosen upstream.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

import { compile } from "sass";
import { describe, expect, it } from "vitest";

const req = createRequire(import.meta.url);

/** The installed package sheet, compiled through the same exports-aware
 *  resolution the app's own sass pipeline uses. HkModal imports its family
 *  sheets relatively, so a direct file compile needs no custom importer. */
const css = compile(
  req.resolve("@celestia-island/hikari/components/HkModal.scss"),
  { style: "expanded" },
).css.replace(/\r\n/g, "\n");

/** The component source next to the sheet: the retired desktop ride was a
 *  component-level binding only then, so its absence belongs in this
 *  contract too (the sheet alone cannot show it). */
const modalTsx = readFileSync(
  req.resolve("@celestia-island/hikari/components/HkModal.tsx"),
  "utf8",
);

/** Body of the first rule whose selector is exactly `selector` (optional
 *  whitespace before the brace) — never a prefix, so `.hk-modal-content`
 *  cannot read the `-enter-active` state rule. Declarations are asserted
 *  INSIDE their rule, never anywhere in the sheet (the scoping rule
 *  hikari's and WoWSP's style tests use). */
function ruleBody(sheet: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(escaped + "\\s*\\{").exec(sheet);
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  const close = sheet.indexOf("}", open);
  return close < 0 ? null : sheet.slice(open + 1, close);
}

/** The body of the first `@media <query>` block, with nested braces
 *  balanced so the desktop gate's own closing brace ends it. */
function mediaBlock(sheet: string, query: string): string | null {
  const at = sheet.indexOf(`@media ${query}`);
  if (at < 0) return null;
  const open = sheet.indexOf("{", at);
  let depth = 1;
  let cursor = open + 1;
  while (cursor < sheet.length && depth > 0) {
    if (sheet[cursor] === "{") depth += 1;
    else if (sheet[cursor] === "}") depth -= 1;
    cursor += 1;
  }
  return sheet.slice(open + 1, cursor - 1);
}

const desktop = mediaBlock(css, "(min-width: 768px)");

describe("hikari's whole-window open/close choreography", () => {
  it("keeps the centred frame's permanent transform prefix", () => {
    const frame = ruleBody(css, ".hk-modal-content");
    expect(frame, "the frame rule exists").not.toBeNull();
    // The centring translate is the frame's transform in EVERY state (the
    // dragged-window shift included); the zoom appends to it rather than
    // replacing it, so the zoom can never re-seat a window.
    expect(frame).toContain(
      "transform: translate(calc(-50% + var(--hk-modal-shift-x, 0px)), calc(-50% + var(--hk-modal-shift-y, 0px)))",
    );
  });

  it("animates ONLY opacity and transform on the desktop enter/leave legs", () => {
    expect(desktop, "the choreography is gated to desktop (min-width: 768px)").not.toBeNull();
    for (const selector of [
      ".hk-modal-content-enter-active",
      ".hk-modal-content-leave-active",
    ]) {
      const body = ruleBody(desktop!, selector);
      expect(body, `${selector} exists`).not.toBeNull();
      expect(body).toContain("will-change: opacity, transform;");
      const transition = body!.match(/transition:\s*([^;]+);/)?.[1] ?? "";
      expect(transition).toContain("opacity");
      expect(transition).toContain("transform");
      expect(transition, "the retired height ride never returns").not.toContain("height");
    }
    // No layout property moves during the flight: that was the whole reason
    // the height ride was retired (it reflowed content-heavy windows).
    expect(desktop!).not.toMatch(
      /(^|\n)\s*(height|max-height|min-height|width|margin|padding|top|left|inset)\s*:/,
    );
  });

  it("starts 10px low at 97% and lands at rest, symmetric on close", () => {
    const from =
      desktop!.match(
        /\.hk-modal-content-enter-from,\s*\.hk-modal-content-leave-to\s*\{([^}]*)\}/,
      )?.[1] ?? "";
    expect(from).toContain("opacity: 0;");
    expect(from).toContain("translateY(10px) scale(0.97)");
    const to =
      desktop!.match(
        /\.hk-modal-content-enter-to,\s*\.hk-modal-content-leave-from\s*\{([^}]*)\}/,
      )?.[1] ?? "";
    expect(to).toContain("opacity: 1;");
    expect(to).toContain("translateY(0) scale(1)");
    // Both ends keep the centring prefix (dragged windows included).
    for (const body of [from, to]) {
      expect(body).toContain("var(--hk-modal-shift-x, 0px)");
      expect(body).toContain("var(--hk-modal-shift-y, 0px)");
    }
  });

  it("retired the content-region compression and the height ride", () => {
    // The 0.55.307–310 grammar compressed the content region and animated
    // the frame's layout height; the 0.55.293–302 grammar scaled/revealed
    // the content. Neither may come back without a deliberate rewrite here.
    // The MODAL sheet must stay free of the ride's scale/height grammar (the
    // inert HkRideBox family sheet still ships through the component's
    // side-effect import, but no consumer binds its .hk-ride classes).
    expect(css).not.toContain("scaleY(");
    expect(css).not.toContain("interpolate-size");
    // The ride half that never reached the sheet: 0.55.310's HkModal.tsx
    // imported useHeightRide and stamped the frame with data-hk-ride-ready.
    // The remaining "ride" names (collectRide / RideEntry) are the
    // sheet-sweep morph riders, which predate and outlive the retired
    // desktop grammar.
    expect(modalTsx).not.toContain("useHeightRide");
    expect(modalTsx).not.toContain("data-hk-ride-ready");
    // The enter/leave legs never reach into the body's own transform.
    expect(css).not.toMatch(
      /\.hk-modal-content-(enter|leave)-(active|from|to)\s+\.hk-modal-body/,
    );
  });
});

describe("WoWSP's modal hosts stay off the frame's motion axes", () => {
  /** Collect the app's stylesheets. */
  function sheets(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) sheets(path, out);
      else if (entry.name.endsWith(".scss")) out.push(path);
    }
    return out;
  }

  /** Every rule whose selector targets the modal FRAME itself: the bare
   *  `.hk-modal-content` box plus its host compounds / :has scopes. Comments
   *  and SCSS interpolation are stripped first so braces inside either can
   *  never fool the walker. */
  function frameRules(src: string): { selector: string; body: string }[] {
    const clean = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/#\{[^{}]*\}/g, "interpolated");
    const rules: { selector: string; body: string }[] = [];
    const re = /\.hk-modal-content(?![\w-])/g;
    for (let match = re.exec(clean); match; match = re.exec(clean)) {
      let start = match.index;
      while (start > 0 && !"{};".includes(clean[start - 1])) start -= 1;
      const open = clean.indexOf("{", match.index);
      if (open < 0) break;
      let depth = 1;
      let cursor = open + 1;
      while (cursor < clean.length && depth > 0) {
        if (clean[cursor] === "{") depth += 1;
        else if (clean[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      rules.push({
        selector: clean.slice(start, open).replace(/\s+/g, " ").trim(),
        body: clean.slice(open + 1, cursor - 1),
      });
      re.lastIndex = open;
    }
    return rules;
  }

  /** The frame itself inside a selector list. Parenthesised :has()/:not()
   *  internals are dropped, then any comma-separated part whose FINAL
   *  compound is the bare .hk-modal-content box counts — an ancestor prefix
   *  (a route host, a wrapped root) is still the same frame, while the state
   *  classes (-enter-active etc.) and descendants are not. Frame references
   *  INSIDE a function pseudo (:is/:deep) are out of scope; no host sheet
   *  uses that shape today. */
  function frameSelectorParts(selector: string): string[] {
    return selector
      .replace(/\([^()]*\)/g, "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => {
        const last = part.split(/[\s>+~]+/).filter(Boolean).pop() ?? "";
        return /^\.hk-modal-content(?![\w-])/.test(last);
      });
  }

  /** Properties that would take the frame off hikari's compositor-owned
   *  motion axes. Layout sizing (height / max-height / padding) is NOT here:
   *  content-sized hosts are legitimate, the morph pins inline. */
  const MOTION =
    /(?:^|[;{])\s*(transform|translate|scale|rotate|will-change|perspective|filter|backdrop-filter|opacity|animation|transition|clip-path)\s*:/m;

  it("keeps the theme-retint blanket off the window's motion classes", () => {
    // A palette switch lands `s-theme-transitioning` on <html> for ~300 ms
    // and the app-wide retint blanket then rewrites `transition` on every
    // element; its (0,1,1) weight beats hikari's (0,1,0) enter/leave classes,
    // so without the exemption a window open/close inside that window loses
    // the transform leg (and the scrim is left with the blanket's 240 ms
    // opacity fade instead of its own 320/420 ms one). The exemptions must
    // stay zero-specificity (:where): a plain :not(...) would lift the
    // blanket to (0,2,1) and re-rank every component transition it covers
    // (the HkInput autofill re-arm at (0,2,2) would still win, but the
    // blanket's original (0,1,1) weight is the contract it was tuned to).
    const theme = readFileSync(join(process.cwd(), "src", "theme", "theme.scss"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const blanket = theme.match(/html\.s-theme-transitioning[\s\S]*?\{[^}]*\}/)?.[0] ?? "";
    const selector = blanket.slice(0, blanket.indexOf("{"));
    expect(selector, "the blanket rule survived the scan").not.toBe("");
    for (const cls of [
      ".hk-modal-content-enter-active",
      ".hk-modal-content-leave-active",
      ".hk-modal-overlay-enter-active",
      ".hk-modal-overlay-leave-active",
    ]) {
      expect(selector, `the blanket exempts ${cls}`).toContain(cls);
    }
    expect(selector, "the exemption rides :not(:where(...))").toMatch(
      /:not\(\s*:where\(/,
    );
    // Only the pseudo-element selectors may keep the bare universal; the
    // element blanket itself must be the :not()-scoped one.
    expect(selector.match(/\*/g) ?? []).toHaveLength(2);
  });

  it("no host sheet sets a motion property on .hk-modal-content", () => {
    const frames = sheets(join(process.cwd(), "src")).flatMap((file) =>
      frameRules(readFileSync(file, "utf8"))
        .filter((rule) => frameSelectorParts(rule.selector).length > 0)
        .map((rule) => ({ file: relative(process.cwd(), file), ...rule })),
    );
    // Sanity: hosts DO restyle the frame (tint, content-sized report frame,
    // confirm-dialog width hatch) — the scan must not silently see nothing.
    expect(frames.length).toBeGreaterThan(0);
    const offenders = frames.filter((rule) => MOTION.test(rule.body));
    expect(
      offenders,
      "host sheets must leave .hk-modal-content's motion to hikari",
    ).toEqual([]);
  });
});