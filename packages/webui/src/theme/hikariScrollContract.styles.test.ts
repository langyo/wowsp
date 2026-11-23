// @vitest-environment node
/**
 * Contract: no WoWSP sheet may paint a PLATFORM (native) scrollbar.
 *
 * theme.scss's "=== Scrollbars ===" note is the policy this file enforces
 * mechanically. Every content scroll region renders through hikari's
 * HkScrollContainer: the container's viewport keeps the native scrolling
 * MECHANICS (wheel/touch/keyboard) but hides the platform chrome
 * (scrollbar-width: none + ::-webkit-scrollbar { display: none } inside
 * hikari's own HkScrollContainer.scss), while the shared overlay engine
 * draws the bar the reader actually sees (.hk-scrollbar-track /
 * .hk-scrollbar-thumb in hikari's styles/theme/scrollbar.scss). A WoWSP
 * rule that declares "overflow: auto|scroll" on its own element therefore
 * re-introduces the exact native bar the policy retired - the class of
 * defect behind the 2026-11-08 battle-heatmap report (a native horizontal
 * bar under a chart) and the ModConflictToast details-modal screenshot.
 *
 * Only two shapes are allowed, and this test accepts exactly those two:
 *
 *   1. NO native overflow in the rule at all - the element lives inside an
 *      HkScrollContainer viewport, or the rule merely CLIPS
 *      (overflow: hidden / visible / clip are not scrolling);
 *   2. hikari's sanctioned SUPPRESSION PAIR: the rule that declares native
 *      scrolling ALSO declares "scrollbar-width: none" in its own direct
 *      declarations, and - only if the legacy WebKit half is wanted - a
 *      nested "&::-webkit-scrollbar { display: none }" rule inside that
 *      same owner. The pair is the container's own shape; anything else
 *      that seeds ::-webkit-scrollbar (thumb/track/corner/width/colour)
 *      is styling a bar the policy says may never paint.
 *
 * The pair is checked against the rule's DIRECT declarations, never its
 * rendered block text: a suppression nested under a modifier class
 * ("&.scrollbar-hidden { scrollbar-width: none }") hides the bar only in
 * that state, so it must not green the base scroller. Textareas are exempt
 * from the policy itself (native input chrome), and they need no overflow
 * declaration to keep that chrome - so the strict rule above does not
 * conflict with the exemption.
 *
 * Why static: vitest stubs CSS and jsdom/happy-dom do no layout, so a real
 * scrollbar never materialises in a test DOM. The enforcement mechanism is
 * a STATIC source contract over the shipped sheets - the same approach as
 * hikari's own nativeScrollbar.contract.test.ts, and the sibling
 * views/playtimeHeatmap.styles.test.ts (which pins the heatmap's hikari
 * scroll chrome from the installed package side).
 *
 * The ModConflictToast half is the screenshot offender's regression pin:
 * that modal's problem list is the region whose native bar was reported, so
 * it must keep mounting HkScrollContainer - with the height cap on the
 * container root and the row layout on an inner wrapper, because a host
 * rule re-adding overflow (or moving the cap onto the viewport content)
 * would resurrect the native bar underneath the overlay track.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** This test lives at <pkg>/src/theme, so the source root is its parent. */
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, "..");

/** A native scrolling declaration (the shape that can paint a platform bar).
 *  "overlay" is the deprecated Chromium alias for the same native track. */
const NATIVE_OVERFLOW = /^overflow(?:-(?:x|y|block|inline))?\s*:\s*(?:auto|scroll|overlay)\b/i;
/** The Firefox half of hikari's sanctioned suppression pair. */
const SUPPRESSION = /^scrollbar-width\s*:\s*none\b/i;
/** The WebKit half's selector, as written nested in the owning rule. */
const WEBKIT_SUPPRESSION_SELECTOR = /^&?::-webkit-scrollbar$/;
/** The WebKit half's only allowed declaration. */
const DISPLAY_NONE = /^display\s*:\s*none\b/i;

interface RuleBlock {
  /** Offset of the rule's opening brace. */
  open: number;
  /** Offset of the rule's closing brace. */
  close: number;
  /** Offset of the rule's prelude (selector / at-rule) first character. */
  selectorOffset: number;
  /** The rule's prelude, whitespace-collapsed. */
  selector: string;
  /** Offset of the enclosing rule's opening brace, null at sheet top level. */
  parentOpen: number | null;
}

interface Declaration {
  /** The declaration as written, whitespace-collapsed (overflow-y: auto). */
  text: string;
  /** Offset of the declaration's first character (line numbers come from it). */
  offset: number;
}

interface Sheet {
  /** Source-tree-relative path, forward slashes (also the message prefix). */
  file: string;
  source: string;
}

interface Violation {
  kind: "native" | "webkit";
  file: string;
  line: number;
  selector: string;
  /** What is wrong, spelled out for the failure message. */
  detail: string;
}

interface Audit {
  violations: Violation[];
  /** Rules the brace-aware parser recovered - the anti-green-hole count. */
  blocks: number;
}

/**
 * Blank SCSS comments while keeping every offset and line break stable
 * (length-preserving), so declaration line numbers and brace spans still
 * point at the real source. A commented-out "overflow: auto" is prose, not
 * a scroll region, and commented-out suppression (a real failure mode: the
 * theme partials document the pair in comments) must never count. Strings
 * are preserved verbatim - quoted url() values may contain double slashes.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1] ?? "";
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < source.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Whitespace-collapse a prelude/declaration for stable comparisons. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The prelude before an opening brace - the text since the previous rule
 *  boundary. selectorOffset is the prelude's first non-blank character. */
function preludeAt(cleaned: string, open: number): { selector: string; selectorOffset: number } {
  let start = open - 1;
  while (
    start >= 0
    && cleaned[start] !== "}"
    && cleaned[start] !== "{"
    && cleaned[start] !== ";"
  ) {
    start -= 1;
  }
  let offset = start + 1;
  while (offset < open && /\s/.test(cleaned[offset] as string)) offset += 1;
  return { selector: collapse(cleaned.slice(start + 1, open)), selectorOffset: offset };
}

/**
 * Every balanced brace block in the comment-blanked sheet, with its prelude
 * and its enclosing block. Quote-aware, so a content string carrying a
 * brace (none in these sheets today, but an off-by-one here would hollow
 * the contract) cannot corrupt the matching.
 */
function ruleBlocks(cleaned: string): RuleBlock[] {
  const blocks: RuleBlock[] = [];
  const stack: number[] = [];
  let quote: string | null = null;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i] as string;
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      stack.push(i);
      continue;
    }
    if (ch === "}") {
      const open = stack.pop();
      if (open === undefined) continue;
      const { selector, selectorOffset } = preludeAt(cleaned, open);
      blocks.push({
        open,
        close: i,
        selector,
        selectorOffset,
        parentOpen: stack.length > 0 ? (stack[stack.length - 1] as number) : null,
      });
    }
  }
  return blocks;
}

/**
 * A rule's DIRECT declarations only: child rule bodies are cut out, so a
 * suppression living under a modifier class cannot green the base scroller
 * (see the header's "direct declarations" note).
 */
function directDeclarations(
  cleaned: string,
  block: RuleBlock,
  blockByOpen: Map<number, RuleBlock>,
): Declaration[] {
  const declarations: Declaration[] = [];
  let quote: string | null = null;
  let start = -1;
  let i = block.open + 1;
  const push = (end: number): void => {
    const text = collapse(cleaned.slice(start, end));
    if (text.length > 0 && start >= 0) declarations.push({ text, offset: start });
    start = -1;
  };
  while (i < block.close) {
    const ch = cleaned[i] as string;
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      if (start < 0) start = i;
      i += 1;
      continue;
    }
    if (ch === "{") {
      // The text before a child rule is the child's prelude, not ours.
      start = -1;
      const child = blockByOpen.get(i);
      i = child ? child.close + 1 : i + 1;
      continue;
    }
    if (ch === ";") {
      if (start >= 0) push(i);
      i += 1;
      continue;
    }
    if (start < 0 && ch.trim().length > 0) start = i;
    i += 1;
  }
  if (start >= 0) push(block.close);
  return declarations;
}

/** 1-based line of an offset (comment blanking preserves line breaks). */
function lineAt(cleaned: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < cleaned.length; i += 1) {
    if (cleaned[i] === "\n") line += 1;
  }
  return line;
}

/**
 * The whole contract for one sheet: unsanctioned native overflow, plus any
 * ::-webkit-scrollbar styling that is not the suppression pair's
 * "display: none". Pure over (file, source) so the checker itself is
 * unit-tested with inline fixtures below - a silent parser regression
 * cannot leave the repo suite green-but-blind.
 */
function auditSheet(sheet: Sheet): Audit {
  const cleaned = stripComments(sheet.source);
  const blocks = ruleBlocks(cleaned);
  const blockByOpen = new Map(blocks.map((block): [number, RuleBlock] => [block.open, block]));
  const declarations = new Map(blocks.map((block): [number, Declaration[]] => [
    block.open,
    directDeclarations(cleaned, block, blockByOpen),
  ]));
  const violations: Violation[] = [];

  for (const block of blocks) {
    const own = declarations.get(block.open) ?? [];
    const native = own.filter((decl) => NATIVE_OVERFLOW.test(decl.text));
    const suppressed = own.some((decl) => SUPPRESSION.test(decl.text));

    if (native.length > 0 && !suppressed) {
      for (const decl of native) {
        violations.push({
          kind: "native",
          file: sheet.file,
          line: lineAt(cleaned, decl.offset),
          selector: block.selector,
          detail: "declares " + decl.text + " without the sanctioned suppression pair in the same rule",
        });
      }
    }

    if (block.selector.includes("::-webkit-scrollbar")) {
      const parent = block.parentOpen === null ? undefined : blockByOpen.get(block.parentOpen);
      const parentOwn = parent ? (declarations.get(parent.open) ?? []) : [];
      const parentSanctioned =
        parentOwn.some((decl) => NATIVE_OVERFLOW.test(decl.text))
        && parentOwn.some((decl) => SUPPRESSION.test(decl.text));
      const pairShaped = WEBKIT_SUPPRESSION_SELECTOR.test(block.selector);
      const displayOnly = own.length > 0 && own.every((decl) => DISPLAY_NONE.test(decl.text));
      if (!(parentSanctioned && pairShaped && displayOnly)) {
        violations.push({
          kind: "webkit",
          file: sheet.file,
          line: lineAt(cleaned, block.selectorOffset),
          selector: block.selector,
          detail:
            "styles ::-webkit-scrollbar chrome; the only allowed WebKit use is the "
            + "suppression pair's nested '&::-webkit-scrollbar { display: none }' inside "
            + "a rule that itself declares native overflow + 'scrollbar-width: none'",
        });
      }
    }
  }

  return { violations, blocks: blocks.length };
}

/** Every .scss under the webui source tree (the policy's scope). */
function collectScss(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectScss(full, out);
    else if (entry.name.endsWith(".scss")) out.push(full);
  }
  return out;
}

/** Actionable one-liner: the exact file:line, the owner rule and the fix. */
function formatViolation(violation: Violation): string {
  const fix = violation.kind === "native"
    ? "fix: mount hikari's <HkScrollContainer> for this region (theme.scss "
      + "'=== Scrollbars ===') instead of giving the sheet its own overflow, "
      + "or keep the region native by adding the sanctioned pair "
      + "('scrollbar-width: none' + nested '&::-webkit-scrollbar { display: none }') "
      + "to this rule"
    : "fix: delete the WebKit chrome; the overlay bar is hikari's "
      + "(.hk-scrollbar-track/.hk-scrollbar-thumb), so a sheet never styles it";
  return violation.file + ":" + violation.line + " - '" + violation.selector + "' "
    + violation.detail + ". " + fix + ".";
}

/** Load the shipped sheets once, in the parsed form the audit consumes. */
function loadSheets(): Sheet[] {
  return collectScss(SRC_ROOT).map((file) => ({
    file: relative(SRC_ROOT, file).replace(/\\/g, "/"),
    source: readFileSync(file, "utf8"),
  }));
}

describe("webui sheets never paint a platform scrollbar", () => {
  const sheets = loadSheets();
  const audits = sheets.map((sheet) => ({ sheet, audit: auditSheet(sheet) }));
  const violations = audits.flatMap(({ audit }) => audit.violations);
  const nativeViolations = violations.filter((v) => v.kind === "native").map(formatViolation);
  const webkitViolations = violations.filter((v) => v.kind === "webkit").map(formatViolation);

  it("scans the whole source tree with a brace-aware parser", () => {
    // Anti-green-hole floors: the collection and the parser must actually see
    // the sheets. 147 sheets / 4300+ rules at the time of writing; if either
    // number collapses, the contracts below would pass vacuously.
    expect(sheets.length, "every packages/webui/src/**/*.scss was read").toBeGreaterThan(50);
    const blocks = audits.reduce((total, { audit }) => total + audit.blocks, 0);
    expect(blocks, "the brace-aware parser recovered the sheets' rule blocks").toBeGreaterThan(500);
    // Positive control on the parser's discrimination: clipping rules exist in
    // these sheets (hikari-host cancellations, truncation) and must never be
    // read as native scrollers - counted over the same collected sheets.
    expect(
      sheets.some((sheet) => /overflow\s*:\s*hidden/.test(sheet.source)),
      "the tree still carries overflow: hidden rules (a scanned-sheet control)",
    ).toBe(true);
  });

  it("every native overflow declaration carries the sanctioned suppression pair", () => {
    expect(
      nativeViolations,
      "A sheet has claimed native scrolling without hikari's chrome. theme.scss "
        + "('=== Scrollbars ===') retires platform bars: content scroll regions render "
        + "through hikari's HkScrollContainer, so a sheet must not own 'overflow: "
        + "auto|scroll'. Every entry below is file:line plus the offending rule.",
    ).toEqual([]);
  });

  it("no ::-webkit-scrollbar styling exists beyond the suppression pair's display: none", () => {
    expect(
      webkitViolations,
      "A sheet styles the platform scrollbar directly. The only allowed WebKit use is "
        + "the suppression pair's nested '&::-webkit-scrollbar { display: none }' inside "
        + "the rule that declares native overflow + 'scrollbar-width: none'; the visible "
        + "bar is hikari's overlay chrome.",
    ).toEqual([]);
  });
});

describe("the contract checker itself", () => {
  const audit = (source: string): Violation[] =>
    auditSheet({ file: "fixture.scss", source }).violations;

  it("accepts the sanctioned pair", () => {
    expect(
      audit(".pane {\n  overflow-y: auto;\n  scrollbar-width: none;\n\n  &::-webkit-scrollbar {\n    display: none;\n  }\n}\n"),
    ).toEqual([]);
  });

  it("rejects a bare native scroller", () => {
    const violations = audit(".list {\n  overflow-x: auto;\n}\n");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("native");
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.detail).toContain("overflow-x: auto");
  });

  it("never flags clipping words", () => {
    expect(audit(".clip {\n  overflow: hidden;\n  overflow-x: visible;\n}\n")).toEqual([]);
  });

  it("does not let a state-scoped suppression green the base rule", () => {
    const violations = audit(
      ".scroller {\n  overflow: auto;\n\n  &.scrollbar-hidden {\n    scrollbar-width: none;\n  }\n}\n",
    );
    expect(violations.map((v) => v.kind)).toEqual(["native"]);
  });

  it("rejects WebKit chrome beyond the suppression pair", () => {
    const striped = audit(
      ".pane {\n  overflow-y: auto;\n  scrollbar-width: none;\n\n  &::-webkit-scrollbar-thumb {\n    background: red;\n  }\n}\n",
    );
    expect(striped.map((v) => v.kind)).toEqual(["webkit"]);
    const alone = audit("::-webkit-scrollbar {\n  width: 6px;\n}\n");
    expect(alone.map((v) => v.kind)).toEqual(["webkit"]);
    // The pair's own display:none is the one allowed form.
    expect(
      audit(".pane {\n  overflow: auto;\n  scrollbar-width: none;\n\n  &::-webkit-scrollbar {\n    display: none;\n  }\n}\n"),
    ).toEqual([]);
  });

  it("ignores commented-out declarations", () => {
    expect(audit("/* overflow: auto; */\n.pane {\n  // overflow-y: scroll;\n  color: red;\n}\n")).toEqual([]);
  });
});

describe("ModConflictToast mounts its problem list on HkScrollContainer", () => {
  const toastDir = join(SRC_ROOT, "components", "layout");
  const toastTsx = readFileSync(join(toastDir, "ModConflictToast.tsx"), "utf8");
  const toastScss = readFileSync(join(toastDir, "ModConflictToast.scss"), "utf8");

  it("imports the container from hikari and renders it inside the modal", () => {
    expect(
      toastTsx,
      "ModConflictToast must import HkScrollContainer from @celestia-island/hikari",
    ).toMatch(
      /import\s*\{[\s\S]*?\bHkScrollContainer\b[\s\S]*?\}\s*from\s*["']@celestia-island\/hikari["']/,
    );
    expect(toastTsx, "the details surface is hikari's HkModal").toContain("<HkModal");
    const containerTags = toastTsx.match(/<HkScrollContainer\b[^>]*>/g) ?? [];
    expect(containerTags.length, "the modal's problem list is an HkScrollContainer").toBeGreaterThan(0);
    expect(
      containerTags.find((tag) => tag.includes("mod-conflict-modal__list")),
      "the capped list host itself rides the container (not a wrapper around it)",
    ).toBeDefined();
  });

  it("keeps the row layout on an inner wrapper inside the viewport", () => {
    const listIndex = toastTsx.indexOf("mod-conflict-modal__list");
    expect(listIndex, "the list host class is rendered").toBeGreaterThan(-1);
    const afterList = toastTsx.slice(listIndex);
    const rowsIndex = afterList.indexOf("mod-conflict-modal__rows");
    const closeIndex = afterList.indexOf("</HkScrollContainer>");
    expect(rowsIndex, "the row wrapper still exists").toBeGreaterThan(-1);
    expect(
      closeIndex,
      "the row wrapper sits INSIDE the container (the viewport owns the scrollport)",
    ).toBeGreaterThan(rowsIndex);
  });

  it("keeps the height cap on the container root and no overflow on the host rule", () => {
    const cleaned = stripComments(toastScss);
    const blocks = ruleBlocks(cleaned);
    const blockByOpen = new Map(blocks.map((candidate): [number, RuleBlock] => [candidate.open, candidate]));
    const block = blocks.find((candidate) => candidate.selector === ".mod-conflict-modal__list");
    expect(block, "the .mod-conflict-modal__list rule exists").toBeDefined();
    if (!block) return;
    const declarations = directDeclarations(cleaned, block, blockByOpen);
    expect(
      declarations.some((decl) => /^max-height\s*:/.test(decl.text)),
      "the cap parks on the container root",
    ).toBe(true);
    expect(
      declarations.some((decl) => /^overflow(?:-[a-z]+)?\s*:/.test(decl.text)),
      "the host rule must not re-own scrolling (hikari's viewport does)",
    ).toBe(false);
    expect(
      auditSheet({ file: "components/layout/ModConflictToast.scss", source: toastScss }).violations,
      "the scss audit sees no violation in the toast sheet (a control on this fixture set)",
    ).toEqual([]);
  });
});
