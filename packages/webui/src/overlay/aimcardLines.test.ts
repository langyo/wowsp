/** Tests for the aim card's line builders (aimcardLines.ts) — the pure
 *  string-in/string-out half of the bare-DOM page, so the render decisions
 *  (dash degradation, the per-ship placeholder ladder, the seal merge and
 *  its kill switches) are unit-testable without a DOM, the same split
 *  rowList/chipFit give the table page. */
import { describe, expect, it } from "vitest";

import {
  aimDisplayName,
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

describe("aimDisplayName", () => {
  // The probe's bridged bot list: the game's own isBot records — the
  // event PvEvP bots that sail under NORMAL nicknames.
  const bots = new Set(["EventBot_with_a_normal_name"]);

  it("keeps a human target and an empty verdict as-is", () => {
    expect(aimDisplayName("Foe03", bots)).toBe("Foe03");
    expect(aimDisplayName("", bots)).toBe("");
  });

  it("suppresses every AI-name style without needing the bridged list", () => {
    expect(aimDisplayName(":Sturdee:", bots)).toBe("");
    expect(aimDisplayName("IDS_OP_15_DUMMY_01", new Set())).toBe("");
    expect(aimDisplayName("#Scenario", new Set())).toBe("");
  });

  it("suppresses a normal-named target the probe flagged as a bot", () => {
    expect(aimDisplayName("EventBot_with_a_normal_name", bots)).toBe("");
  });
});

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

  it("keeps the thin-sample warning on the account career count", () => {
    // 100 CAREER battles is a thin sample — the account line keeps the red
    // the per-ship line below drops (a scoped count under 200 is the norm).
    const html = careerLineHtml({ ...ok, battles: 100 }, PATTERN);
    expect(cell(html, 2)).toContain('style="color:');
  });

  it("appends the optional K/D cell only when asked for", () => {
    // Default: exactly the four fixed cells, no fifth figure.
    const plain = careerLineHtml({ ...ok, kdRatio: 2.05 }, PATTERN);
    expect(plain.match(/<b /g)?.length).toBe(4);
    expect(plain).not.toContain("2.05");
    // showKd: the fifth cell rides at the end, plain ink (no tier color —
    // there is no color band for a kills/deaths ratio).
    const withKd = careerLineHtml({ ...ok, kdRatio: 2.05 }, PATTERN, true);
    expect(withKd.match(/<b /g)?.length).toBe(5);
    expect(cell(withKd, 4)).toContain(">2.05</b>");
    expect(cell(withKd, 4)).not.toContain('style="color:');
    // A missing K/D degrades to the em dash like every other figure.
    const dashed = careerLineHtml({ ...ok, kdRatio: null }, PATTERN, true);
    expect(cell(dashed, 4)).toContain("aim-none");
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
    // 400 frags / (300 − 90 survived) = 400/210 ≈ 1.90.
    frags: 400,
    survivedBattles: 90,
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

  it("keeps the battle ship's thin battle count uncolored (no warning)", () => {
    // Under 200 battles on ONE ship is the norm — the per-ship line never
    // wears the account line's thin-sample red.
    const html = shipLineHtml(
      [{ ...row, battles: 42 }],
      row.shipId,
      "瓦尔帕莱索",
      PATTERN,
    );
    expect(html).toContain('>42<span class="aim-unit"> 场</span></b>');
    expect(cell(html, 3)).not.toContain("style=");
  });

  it("appends the optional K/D cell from the row's own counters", () => {
    // Default: four cells only.
    const plain = shipLineHtml([row], row.shipId, "瓦尔帕莱索", PATTERN);
    expect(plain.match(/<b /g)?.length).toBe(4);
    // showKd: 400 frags / (300 − 90) deaths ≈ 1.90, plain ink. The ship
    // line's split segments: [0] tag-span prefix, then winrate/PR/battles/
    // damage/K/D — the K/D cell is index 5.
    const withKd = shipLineHtml([row], row.shipId, "瓦尔帕莱索", PATTERN, 0, true);
    expect(withKd.match(/<b /g)?.length).toBe(5);
    expect(cell(withKd, 5)).toContain(">1.90</b>");
    expect(cell(withKd, 5)).not.toContain('style="color:');
    // A row that never died has no ratio — the dash, never a zero.
    const immortal = shipLineHtml(
      [{ ...row, battles: 10, survivedBattles: 10 }],
      row.shipId,
      "瓦尔帕莱索",
      PATTERN,
      0,
      true,
    );
    expect(cell(immortal, 5)).toContain("aim-none");
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
