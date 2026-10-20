/** Tests for the aim card's line builders (aimcardLines.ts) — the pure
 *  string-in/string-out half of the bare-DOM page, so the render decisions
 *  (dash degradation, the per-ship placeholder ladder, the seal merge and
 *  its kill switches) are unit-testable without a DOM, the same split
 *  rowList/chipFit give the table page. */
import { describe, expect, it } from "vitest";

import {
  battlesText,
  careerLineHtml,
  sealLineHtml,
  shipLineHtml,
  stampNode,
  type AimShipRow,
  type BatchStat,
} from "./aimcardLines";

const PATTERN = "{n} 场";

const ok: BatchStat = {
  winrate: 47.2,
  avgDamage: 26500,
  pr: 777,
  battles: 1929,
  hidden: false,
};

function cell(html: string, index: number): string {
  return html.split(/(?=<b )/)[index] ?? "";
}

describe("careerLineHtml", () => {
  it("renders the four tier-colored figures for a landed row", () => {
    const html = careerLineHtml(ok, PATTERN);
    expect(html).toContain(">47.2%</b>");
    expect(html).toContain(">777</b>");
    // The battles count AND its unit word ride inside ONE bold cell (the
    // figure grid counts cells, not runs); 1929 is below the k floor.
    expect(html).toContain('>1929<span class="aim-unit"> 场</span></b>');
    expect(html).toContain(">26.5k</b>");
    // No muted dash faces anywhere.
    expect(html).not.toContain("aim-none");
    // Exactly four cells.
    expect(html.match(/<b /g)?.length).toBe(4);
  });

  it("degrades every figure to the em dash when nothing landed", () => {
    const html = careerLineHtml(null, PATTERN);
    expect(html.match(/aim-none/g)?.length).toBe(4);
    expect(html).toContain(">—</b>");
  });

  it("renders the same dashes for a hidden profile (never a zero)", () => {
    const html = careerLineHtml({ ...ok, hidden: true }, PATTERN);
    expect(html.match(/aim-none/g)?.length).toBe(4);
    expect(html).not.toContain("47.2");
  });

  it("keeps the battles count bare when the locale pattern has no {n}", () => {
    const html = careerLineHtml(ok, "battles");
    expect(html).toContain(">1929</b>");
    expect(html).not.toContain("aim-unit");
  });
});

describe("battlesText", () => {
  it("splits around {n} keeping the number on the mono face in ONE cell", () => {
    expect(battlesText(15000, PATTERN)).toBe(
      '<b class="aim-num">15.0k<span class="aim-unit"> 场</span></b>',
    );
  });

  it("colors the figure when a color rides in", () => {
    expect(battlesText(100, PATTERN, "rgb(1 2 3)")).toBe(
      '<b class="aim-num" style="color:rgb(1 2 3)">100<span class="aim-unit"> 场</span></b>',
    );
  });
});

describe("shipLineHtml", () => {
  const row: AimShipRow = {
    shipId: 4263669888,
    name: "瓦尔帕莱索",
    winrate: 52.1,
    avgDamage: 31200,
    battles: 300,
    pr: 1100,
  };

  it("renders the chasing dots while the list is still owed", () => {
    const html = shipLineHtml(undefined, row.shipId, "瓦尔帕莱索", PATTERN, 0);
    expect(html).toContain("aim-dots");
    expect(html.match(/<i /g)?.length).toBe(3);
    // Phase-locked delays arrive inline so rebuilds never restart the chase.
    expect(html).toContain("animation-delay:0.000s");
    expect(html).toContain("animation-delay:-0.400s");
  });

  it("renders the battle ship's own figures with its name as the tag", () => {
    const html = shipLineHtml([row], row.shipId, "瓦尔帕莱索", PATTERN);
    expect(html).toContain('<span class="aim-ship-tag">瓦尔帕莱索</span>');
    expect(html).toContain(">52.1%</b>");
    expect(html).toContain(">1100</b>");
    expect(html).toContain('>300<span class="aim-unit"> 场</span></b>');
    expect(html).toContain(">31.2k</b>");
  });

  it("renders dashes for a landed list without the battle ship's row", () => {
    const html = shipLineHtml([row], 12345, "罗恩", PATTERN);
    expect(html).toContain('<span class="aim-ship-tag">罗恩</span>');
    expect(html.match(/aim-none/g)?.length).toBe(4);
  });

  it("renders the same dashes for a failed list", () => {
    const html = shipLineHtml(null, row.shipId, "罗恩", PATTERN);
    expect(html.match(/aim-none/g)?.length).toBe(4);
  });

  it("drops the PR cell to a dash when the row carries none", () => {
    const html = shipLineHtml([{ ...row, pr: null }], row.shipId, "瓦尔帕莱索", PATTERN);
    expect(html).toContain(">52.1%</b>");
    // Cells: [0] label [1] winrate [2] PR [3] battles [4] damage.
    expect(cell(html, 2)).toContain("aim-none");
  });
});

describe("sealLineHtml", () => {
  it("renders nothing when no verdict and no composition applies", () => {
    expect(
      sealLineHtml(null, null, { disabled: new Set(), custom: {} }),
    ).toBe("");
  });

  it("lets the rat verdict stand alone (composition is unknowable)", () => {
    const html = sealLineHtml("rat", { air: true, sub: true, airVeteran: false, subVeteran: false }, {
      disabled: new Set(),
      custom: {},
    });
    expect(html).toBe('<span class="aim-stamp" data-stamp="rat" title="过街老鼠">过街老鼠</span>');
  });

  it("merges a miracle career with a sub composition into the merged seal", () => {
    const html = sealLineHtml("miracle", { air: false, sub: true, airVeteran: false, subVeteran: false }, {
      disabled: new Set(),
      custom: {},
    });
    expect(html).toContain('data-stamp="subMiracle"');
    expect(html).toContain("水下神人");
  });

  it("suppresses a kill-switched kind", () => {
    const html = sealLineHtml("maggot", null, {
      disabled: new Set(["maggot"]),
      custom: {},
    });
    expect(html).toBe("");
  });

  it("renders a custom picture over the text face", () => {
    const html = stampNode("ape", {
      disabled: new Set(),
      custom: { ape: "asset://stamps/ape.webp" },
    });
    expect(html).toBe(
      '<img class="aim-stamp" data-stamp="ape" src="asset://stamps/ape.webp" alt="猴" title="猴">',
    );
  });
});
