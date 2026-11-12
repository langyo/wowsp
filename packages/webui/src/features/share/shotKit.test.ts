import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { fakeAs } from "@/test-utils/fakes";

import { FONT_STACK, MONO_STACK, statCellOrigins } from "./shotKit";

/** A canvas stand-in whose measureText is deterministic: every glyph is
 *  6px wide. Only measureText is on statCellOrigins' critical path. */
const fakeCtx = fakeAs<CanvasRenderingContext2D>({
  measureText: (s: string) => fakeAs<TextMetrics>({ width: s.length * 6 }),
});

/** Column widths implied by the fake measure for a cell matrix. */
function colWidths(cells: string[][]): number[] {
  const widths: number[] = [];
  for (let i = 0; i < Math.max(0, ...cells.map((c) => c.length)); i++) {
    widths.push(Math.max(...cells.map((row) => (row[i] ?? "").length)) * 6);
  }
  return widths;
}

describe("statCellOrigins", () => {
  // The stats card's real-world failure shape: a narrow battles column
  // under a wide winrate column ("3" vs "100.0%").
  const CELLS = [
    ["3", "100.0%", "1234", "1.23"],
    ["12", "48.2%", "98,432", "0.98"],
  ];
  const GAP = 10;

  it("returns each column's RIGHT edge, so right-aligned cells never overlap", () => {
    const origins = statCellOrigins(fakeCtx, CELLS, GAP);
    const widths = colWidths(CELLS);
    expect(origins).toEqual([12, 58, 104, 138]);
    // Non-overlap invariant: every column's left edge clears the previous
    // column's right edge by at least the gap — the exact property whose
    // absence made the poster's battles and winrate columns print on top
    // of each other.
    for (let i = 1; i < origins.length; i++) {
      expect(origins[i] - widths[i]).toBeGreaterThanOrEqual(origins[i - 1] + GAP);
    }
  });

  it("ends at the whole block's width (the callers' trailing-space base)", () => {
    const origins = statCellOrigins(fakeCtx, CELLS, GAP);
    const widths = colWidths(CELLS);
    const total = widths.reduce((s, w) => s + w, 0) + GAP * (widths.length - 1);
    expect(origins[origins.length - 1]).toBe(total);
  });

  it("keeps ragged rows (short rows miss trailing cells) and empty input", () => {
    expect(statCellOrigins(fakeCtx, [["3", "100.0%"], ["12"]], GAP)).toEqual([12, 58]);
    expect(statCellOrigins(fakeCtx, [], GAP)).toEqual([]);
  });
});

/** The canvas typography is the APP typography: FONT_STACK / MONO_STACK
 *  mirror theme.scss's --font-sans / --font-mono verbatim, because the
 *  DOM-captured AI report long image inherits those very tokens. When the
 *  two drift, the stats cards and the AI report render different faces
 *  (the 2026-11-08 review's "the two share shots use different fonts").
 *  The guard diffs the token lines out of the real theme sheet, so a
 *  future token edit that forgets the mirror fails here, not in a chat
 *  screenshot comparison. */
function themeFontVar(name: string): string {
  // happy-dom hands import.meta.url an http scheme, so the sheet resolves
  // from the process cwd instead — the package root (pnpm -C packages/webui)
  // or the workspace root, whichever the runner started in.
  const candidates = [
    resolve(process.cwd(), "src/theme/theme.scss"),
    resolve(process.cwd(), "packages/webui/src/theme/theme.scss"),
  ];
  const sheetPath = candidates.find((p) => existsSync(p));
  if (!sheetPath) throw new Error("theme.scss not found from cwd " + process.cwd());
  const sheet = readFileSync(sheetPath, "utf8");
  const line = sheet.split("\n").find((l) => l.trim().startsWith(name + ":"));
  if (!line) throw new Error("theme.scss lost the " + name + " token");
  return line.slice(line.indexOf(":") + 1).replace(/;.*$/s, "").trim();
}

describe("shot font stacks mirror the theme tokens", () => {
  it("FONT_STACK equals theme.scss --font-sans", () => {
    expect(FONT_STACK).toBe(themeFontVar("--font-sans"));
  });

  it("MONO_STACK equals theme.scss --font-mono", () => {
    expect(MONO_STACK).toBe(themeFontVar("--font-mono"));
  });
});
