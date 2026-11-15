/**
 * Contract: the 全员/我的 viewswitch segment presses the SAME 18px face as
 * the AppTag chips beside it in the share toolbar.
 *
 * The reported regression (2026-11-16, "这标签不标准，和别人高度不一样"):
 * the segment was hand-rolled at line-height 1.5 + 0.1rem vertical padding
 * inside its 1px track = 20.5px, so it floated ~2.5px proud of every
 * HkTag-sm chip in the same row. AppTag's HkTag-sm face is the row
 * standard: 10px text × 1.4 line (14px) + 2×1px padding + 2×1px border =
 * 18px. A style edit that leaves this rung must fail here, not in a
 * screenshot review.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** The sheet, comments stripped: the prose above and in the SCSS names the
 *  retired rung on purpose, so both comment forms are removed first. */
const css = readFileSync(
  join(process.cwd(), "src", "features", "replay", "PostBattlePanel.scss"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The segment's top-level declarations (the nested & + & divider follows
 *  them, so the first closing brace after the selector is enough). */
const segment = css.match(/\.replay-view__postbattle-viewswitch-btn\s*\{([\s\S]*?)\}/)?.[1] ?? "";
const track = css.match(/\.replay-view__postbattle-viewswitch\s*\{([\s\S]*?)\}/)?.[1] ?? "";

describe("post-battle viewswitch face", () => {
  it("keeps the HkTag-sm rung's line-height and vertical padding", () => {
    expect(segment).not.toBe("");
    expect(track).not.toBe("");
    expect(segment).toMatch(/font-size:\s*var\(--text-2xs\)/);
    expect(segment).toMatch(/line-height:\s*1\.4/);
    expect(segment).toMatch(/padding:\s*1px\b/);
    // The track's 1px border is part of the 18px total: 14 + 2 + 2.
    expect(track).toMatch(/border:\s*1px solid/);
  });

  it("never drifts back to the taller hand-rolled rung", () => {
    expect(segment).not.toMatch(/line-height:\s*1\.5/);
    expect(segment).not.toMatch(/padding:\s*0?\.1rem/);
  });
});
