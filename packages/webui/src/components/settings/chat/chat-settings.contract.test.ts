/**
 * Contract test for the chat windows' compact numeric fields (the settings
 * review caught the line-cap number stretching across the whole card). The
 * components wear the "chat-settings__number" class and the stylesheet must
 * keep pinning them — a className-only unit test would stay green even if
 * this rule were deleted, so the CSS itself is asserted here (the hikari
 * component-source contract precedent keeps its rules checked the same way).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Vitest runs from the webui package root (CI: pnpm --filter webui test), so
// the stylesheet path resolves from there.
const scss = readFileSync(
  resolve(process.cwd(), "src/components/settings/chat/chat-settings.scss"),
  "utf8",
);

/** Pull ONE rule's body out of the stylesheet: the selector must start a
 *  line (so ".chat-settings__param" never matches ".chat-settings__param-row")
 *  and braces are scanned by depth (nested blocks and comments cannot fool
 *  the extraction). */
function ruleBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{`).exec(scss);
  expect(match, `rule ${selector} exists`).not.toBeNull();
  const open = match!.index + match![0].length - 1;
  let depth = 0;
  for (let i = open; i < scss.length; i += 1) {
    if (scss[i] === "{") depth += 1;
    else if (scss[i] === "}") {
      depth -= 1;
      if (depth === 0) return scss.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated rule ${selector}`);
}

describe("chat settings numeric-field contract", () => {
  it("pins .hk-number-input.chat-settings__number to a compact width", () => {
    const block = ruleBlock(".hk-number-input.chat-settings__number");
    expect(block).toMatch(/flex:\s*0 1 7rem/);
    expect(block).toMatch(/width:\s*7rem/);
    expect(block).toMatch(/min-width:\s*4\.5rem/);
  });

  it("keeps the advanced-parameter row inset and wrapping", () => {
    const row = ruleBlock(".chat-settings__param-row");
    expect(row).toMatch(/display:\s*flex/);
    expect(row).toMatch(/flex-wrap:\s*wrap/);
    // The panel body inset (the MD3 header's 12px) keeps the row aligned
    // with the title instead of hugging the frame.
    expect(row).toMatch(/padding:\s*0\.35rem 0\.75rem 0\.35rem/);
    // The PARAM block itself must wrap too — the row does not inherit this
    // (the earlier selector lookup matched the ROW's substring and went
    // green even with flex-wrap deleted here; this test now pins the real
    // block).
    const param = ruleBlock(".chat-settings__param");
    expect(param).toMatch(/flex-wrap:\s*wrap/);
  });
});
