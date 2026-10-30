/**
 * Source contract test for the selection edge hint's painters (the
 * soft-edges follow-up: the settings rail's hint band spanned the rail's
 * full width and ended in hard vertical cuts at both inline ends). The
 * SCSS itself is asserted here — a DOM-level unit test would stay green
 * if a painter or the feather mask were deleted (the chat-settings
 * contract precedent keeps its rules checked the same way).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Vitest runs from the webui package root (CI: pnpm --filter @wowsp/webui
// test), so the stylesheet path resolves from there.
const scss = readFileSync(
  resolve(process.cwd(), "src/composables/useSelectionEdgeHint.scss"),
  "utf8",
);

/** Pull ONE rule's body out of the stylesheet: the selector must start a
 *  line (so "[data-selection-beyond]" never matches the value-qualified
 *  "[data-selection-beyond=...]" painters) and the selector group may span
 *  lines (internal whitespace is pattern-matched, so both halves of a
 *  painter group are pinned — deleting either half goes red); braces are
 *  scanned by depth (nested blocks and comments cannot fool the
 *  extraction). */
function ruleBlock(selector: string): string {
  const escaped = selector
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{`).exec(scss);
  expect(match, `rule ${selector} exists`).not.toBeNull();
  const open = match!.index + match![0].length - 1;
  let depth = 0;
  for (let i = open; i < scss.length; i += 1) {
    if (scss[i] === "{") depth += 1;
    else if (scss[i] === "}") {
      depth -= 1;
      // Strip line comments from the body before returning: SCSS `//`
      // comments are silent, so a commented-out declaration must not
      // satisfy the raw-text assertions below (the lookbehind keeps
      // `protocol://` strings intact should one ever appear here).
      return scss
        .slice(open + 1, i)
        .split("\n")
        .map((line) => line.replace(/(?<!:)\/\/.*$/g, ""))
        .join("\n");
    }
  }
  throw new Error(`unterminated rule ${selector}`);
}

/** The symmetric feather stops: transparent at both inline ends, opaque
 *  (#000) from each --selection-hint-feather inset inward. */
const FEATHER_GRADIENT =
  /linear-gradient\(to right,\s*transparent 0,\s*#000 var\(--selection-hint-feather\),\s*#000 calc\(100% - var\(--selection-hint-feather\)\),\s*transparent 100%\)/;

/** Exactly one -webkit-mask-image and one standard mask-image per painter,
 *  both carrying the symmetric feather stops. */
function expectFeatherMaskPair(block: string, label: string): void {
  const webkit = block.match(/-webkit-mask-image:[^;]+;/g) ?? [];
  expect(webkit, `${label}: exactly one -webkit-mask-image`).toHaveLength(1);
  expect(webkit[0], `${label}: -webkit-mask-image feathers both ends`).toMatch(FEATHER_GRADIENT);
  // (?<!-) keeps -webkit-mask-image: from also counting as mask-image:.
  const standard = block.match(/(?<!-)mask-image:[^;]+;/g) ?? [];
  expect(standard, `${label}: exactly one mask-image`).toHaveLength(1);
  expect(standard[0], `${label}: mask-image feathers both ends`).toMatch(FEATHER_GRADIENT);
}

describe("selection edge hint painter contract", () => {
  it("declares the size/feather custom properties with --space-24 defaults", () => {
    const host = ruleBlock("[data-selection-beyond]");
    expect(host).toMatch(/--selection-hint-size:\s*var\(--space-24\)/);
    expect(host).toMatch(/--selection-hint-feather:\s*var\(--space-24\)/);
  });

  it("feathers the top/both ::before painter's inline ends", () => {
    const block = ruleBlock(
      '[data-selection-beyond="top"]::before,\n[data-selection-beyond="both"]::before',
    );
    expectFeatherMaskPair(block, "top painter");
    // The vertical decay stays in the background gradient: 32% peak at the
    // lit edge, transparent at the inner one.
    expect(block).toMatch(
      /background:\s*linear-gradient\(to bottom, rgb\(var\(--color-primary\) \/ 32%\), transparent\)/,
    );
    expect(block).toMatch(/height:\s*var\(--selection-hint-size\)/);
  });

  it("feathers the bottom/both ::after painter's inline ends", () => {
    const block = ruleBlock(
      '[data-selection-beyond="bottom"]::after,\n[data-selection-beyond="both"]::after',
    );
    expectFeatherMaskPair(block, "bottom painter");
    expect(block).toMatch(
      /background:\s*linear-gradient\(to top, rgb\(var\(--color-primary\) \/ 32%\), transparent\)/,
    );
    expect(block).toMatch(/height:\s*var\(--selection-hint-size\)/);
  });
});
