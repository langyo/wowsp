/**
 * Sample-frame renderer for the Tab overlay's chip design: drives the real
 * main.ts bootstrap with a settled battle (every stat landed, seals on,
 * team averages on, one hidden profile) and serializes the live DOM into a
 * self-contained HTML file — `dist/overlay-sample.html` (gitignored), the
 * page's own overlay.scss inlined — so the chip typography can be SCREENSHOT
 * and reviewed (the mono number faces, the split battles-count unit, the
 * scope-tagged solo column, the drawn absence dashes, the two-column lean).
 * The assertions pin the markup contract the picture depends on; the
 * picture itself is the deliverable (open the file, or photograph it in a
 * browser).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { STATS_PREFS_STORAGE_KEY } from "../stores/statsPrefs";

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

let resolveBatch: ((rows: unknown[]) => void) | null = null;
let batchNames: string[] = [];
let batchCalls = 0;

// Varied digit counts on purpose — the sample must show how the mono
// figures align across rows of different magnitudes. `solo` is the career
// solo split: langyo's EQUALS his battles count (the mirrored-split shape
// soloSplitReliable rejects — his solo cell must show the drawn dash, not
// the career winrate wearing a 单排 tag) and korea4950 carries none (the
// plain absence dash), the other three carry real minority splits.
const ROSTER = [
  { name: "[HERO]wersskysks", relation: 1, winrate: 54.3, pr: 1604, battles: 2391, dmg: 56000, soloWr: 51.2, soloBattles: 1502 },
  { name: "langyo", relation: 0, winrate: 56.8, pr: 1715, battles: 14800, dmg: 91000, soloWr: 55.9, soloBattles: 14800 },
  // mkwp22 also misses the damage figure (the plain per-cell absence dash
  // beside his numbers).
  { name: "[GHOST]mkwp22", relation: 1, winrate: 42.2, pr: 499, battles: 595, dmg: null, soloWr: 40.1, soloBattles: 380 },
  // korea4950 carries no solo split at all (the absence dash in the solo
  // cell).
  { name: "korea4950", relation: 2, winrate: 45.4, pr: 649, battles: 2895, dmg: 40300 },
  { name: "ByakuyaWN", relation: 2, winrate: 52.5, pr: 1424, battles: 10200, dmg: 74600, soloWr: 53.3, soloBattles: 6110 },
  // A hidden profile: the rat verdict badge + the red dot stat face, no numbers.
  { name: "CT_RSE", relation: 2, winrate: null, pr: null, battles: null, dmg: null, hidden: true },
];

const arena = {
  matchGroup: "pvp",
  dateTime: "20261013_sample_frame",
  scenario: null,
  eventType: null,
  vehicles: ROSTER.map((p, i) => ({
    id: i + 1,
    name: p.name,
    relation: p.relation,
    shipId: i + 1,
  })),
};

// Sized so the side pads hold the widest chip (seals + name + the four
// column cells) the way the real overlay's do — pad ≈ 520 CSS px against a
// 15 px row font, table centered between them; three ally rows and three
// enemy rows, the summary cards one pitch under the blocks.
const anchor = {
  gameRect: { x: 0, y: 0, width: 1600, height: 480 },
  overlayRect: { x: 0, y: 0, width: 1600, height: 480 },
  rosterRect: { x: 520, y: 10, width: 560, height: 380 },
  rowCenters: [50, 92, 134, 50, 92, 134],
  teamSplit: 0.5,
  tableDetected: true,
  rowAlive: Array(6).fill(true),
  rosterMode: "passive",
};

const rowChips = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>(".overlay-chip")].filter(
    (el) =>
      !el.classList.contains("overlay-chip--intel") &&
      !el.classList.contains("overlay-chip--head"),
  );

beforeAll(async () => {
  history.replaceState(null, "", "?realm=ru&locale=zh-CN");
  localStorage.setItem(
    STATS_PREFS_STORAGE_KEY,
    JSON.stringify({
      // Five columns including a scope-tagged SOLO winrate — the sample
      // then shows the 单排 tag's vertical centering and its gap to the
      // figure, plus the dash faces a rejected (mirrored) split and a
      // missing figure render in their cells.
      overlayColumns: [
        { scope: "global", metric: "winrate" },
        { scope: "global", metric: "pr" },
        { scope: "solo", metric: "winrate" },
        { scope: "global", metric: "battles" },
        { scope: "global", metric: "damage" },
      ],
      teamAvgEnabled: true,
      sealsEnabled: true,
    }),
  );
  vi.stubGlobal("__TAURI__", {
    core: {
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "lookup_players_stats_batch") {
          batchCalls += 1;
          batchNames = (args?.names as string[]) ?? [];
          return new Promise((resolve) => {
            resolveBatch = resolve as (rows: unknown[]) => void;
          });
        }
        if (cmd === "lookup_players_composition") {
          // A pair of composition seals so the sample shows the trim
          // targets too (空中小人 on the first name, 水下小人 on langyo).
          const comps: Record<string, unknown> = {
            "[HERO]wersskysks": { air: true, sub: false, airVeteran: false, subVeteran: false },
            langyo: { air: false, sub: true, airVeteran: false, subVeteran: false },
          };
          return ((args?.names as string[]) ?? []).map((n) => comps[n] ?? null);
        }
        if (cmd === "read_temp_arena_info") return null;
        if (cmd.startsWith("lookup_")) return [];
        return null;
      }),
    },
    event: {
      listen: vi.fn(async (ev: string, h: Handler) => {
        handlers.set(ev, h);
        return () => handlers.delete(ev);
      }),
    },
  });
  await import("./main");
  await vi.waitFor(() => expect(handlers.has("wowsp://overlay-anchor")).toBe(true));
});

describe("overlay sample frame", () => {
  it("renders a settled battle and writes the reviewable sample HTML", async () => {
    handlers.get("wowsp://arena-info")!({ payload: arena });
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(rowChips().length).toBe(6));
    await vi.waitFor(() => expect(batchCalls).toBe(1));
    resolveBatch!(
      batchNames.map((name) => {
        const p = ROSTER.find((r) => r.name === name)!;
        return {
          accountId: 1,
          winrate: p.winrate,
          avgDamage: p.dmg,
          pr: p.pr,
          battles: p.battles,
          soloWr: p.soloWr ?? null,
          soloBattles: p.soloBattles ?? null,
          rankedWinrate: null,
          rankedPr: null,
          rankedBattles: null,
          rankedAvgDamage: null,
          globalWinrate: null,
          globalPr: null,
          globalBattles: null,
          globalAvgDamage: null,
          clanId: null,
          clanTag: null,
          realm: "ru",
          hidden: p.hidden ?? false,
          name,
        };
      }),
    );

    // Settled: no loading dots anywhere, and the composition-seal batch
    // (a 250 ms timer behind the stats) has landed its verdicts too.
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".overlay-dots").length).toBe(0),
    );
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.overlay-stamp[data-stamp="air"]').length).toBe(1),
    );

    // The markup contract the picture depends on: five numbered rows carry
    // the five mono figures (winrate / PR / solo winrate / battles /
    // damage — the solo cell included on the dash rows), every battles
    // count carries the split unit word, no cell carries a scope tag (the
    // head row below says which column is which), the hidden profile row
    // is the rat verdict badge + the red dot stat face, and both average
    // lines settled into numbers.
    const numbered = rowChips().filter((c) => c.querySelector(".overlay-chip__stat b"));
    expect(numbered).toHaveLength(5);
    for (const chip of numbered) {
      // Five figures, each in its own fixed-width column cell (the solo
      // winrate reuses the n-wr face inside its own data-col cell).
      expect(chip.querySelectorAll(".overlay-chip__stat b")).toHaveLength(5);
      for (const [cls, n] of [
        ["n-wr", 2],
        ["n-pr", 1],
        ["n-battles", 1],
        ["n-dmg", 1],
      ] as const) {
        expect(chip.querySelectorAll(`.overlay-num.${cls}`)).toHaveLength(n);
      }
    }
    expect(document.querySelectorAll(".overlay-scope")).toHaveLength(0);
    // The per-side COLUMN HEAD rows: one per side, each a muted word per
    // column riding the same data-col cells as the figures — 胜率 / PR /
    // 单排胜率 / 场次 / 场均 (zh join is empty), the ENEMY head mirroring
    // the column order like the rows do.
    const heads = [
      ...document.querySelectorAll<HTMLElement>(".overlay-chip--head"),
    ];
    expect(heads).toHaveLength(2);
    const headLabels = (side: string) =>
      [
        ...document.querySelectorAll<HTMLSpanElement>(
          `.overlay-chip--head.overlay-chip--${side} .overlay-chip__stat b`,
        ),
      ].map((b) => ({ col: b.dataset.col, text: b.textContent }));
    expect(headLabels("ally")).toEqual([
      { col: "0", text: "胜率" },
      { col: "1", text: "PR" },
      { col: "2", text: "单排胜率" },
      { col: "3", text: "场次" },
      { col: "4", text: "场均" },
    ]);
    expect(headLabels("enemy").map((c) => c.col)).toEqual(["4", "3", "2", "1", "0"]);
    expect(headLabels("enemy")[2]).toEqual({ col: "2", text: "单排胜率" });
    expect(document.querySelectorAll(".overlay-chip__stat .overlay-unit")).toHaveLength(5);
    // The drawn dashes: langyo's mirrored solo split (rejected by
    // soloSplitReliable — never rendered as a figure), korea4950's absent
    // solo split, and his missing damage figure. Three dashes, each a
    // painted .overlay-dash inside its measured column cell — the stat
    // cells carry no "—" glyph anywhere.
    const dashes = document.querySelectorAll(".overlay-chip__stat .overlay-dash");
    expect(dashes).toHaveLength(3);
    for (const cell of document.querySelectorAll(".overlay-chip__stat")) {
      expect(cell.textContent).not.toContain("—");
    }
    // The solo cells (data-col 2) split three figures (wersskysks /
    // mkwp22 / ByakuyaWN — the honest splits) against two dashes (the
    // mirrored and the absent ones); the heads' own data-col-2 cell is
    // excluded — it names the column, it is not one of its faces.
    const soloCellText = [
      ...document.querySelectorAll<HTMLSpanElement>(
        ".overlay-chip:not(.overlay-chip--head) .overlay-chip__stat b[data-col='2']",
      ),
    ].map((cell) => cell.textContent ?? "");
    expect(soloCellText).toHaveLength(5);
    expect(soloCellText.filter((t) => t.includes("%"))).toHaveLength(3);
    expect(soloCellText.filter((t) => !t.includes("%"))).toHaveLength(2);
    // The rat verdict: the hidden profile renders the 过街老鼠 badge in
    // the seals flank beside the pinned stat cell's red dot, the fallback
    // name cell outside the stat cell, and on the enemy block the badge
    // outermost (last child).
    const ratChips = rowChips().filter((c) => c.classList.contains("overlay-chip--rat"));
    expect(ratChips).toHaveLength(1);
    expect(ratChips[0]!.querySelector('.overlay-stamp[data-stamp="rat"]')).not.toBeNull();
    expect(ratChips[0]!.querySelectorAll(".overlay-stamp")).toHaveLength(1);
    expect(ratChips[0]!.querySelector(".overlay-chip__stat .hidden")).not.toBeNull();
    // The lone red dot rides a SPARSE stat cell — compact, exempt from the
    // side's pinned figure width, so the row clusters [dot][name][badge]
    // instead of showing a hole where the figures would sit.
    expect(
      ratChips[0]!.querySelector(".overlay-chip__stat")!.classList.contains(
        "overlay-chip__stat--sparse",
      ),
    ).toBe(true);
    expect(ratChips[0]!.querySelector(".overlay-chip__name")).not.toBeNull();
    expect(ratChips[0]!.lastElementChild!.classList.contains("overlay-stamp")).toBe(true);
    const avgLines = [
      ...document.querySelectorAll<HTMLElement>(".overlay-intel-line--avg"),
    ];
    expect(avgLines).toHaveLength(2);
    for (const line of avgLines) {
      expect(line.querySelector("b")).not.toBeNull();
    }
    // The comparative tones: the ally side's settled means beat the enemy
    // side's on all three metrics (winrate ~51.1 vs ~49.0, PR ~1273 vs
    // ~1037, damage ~73.5k vs ~57.5k — mkwp22's missing damage and the
    // hidden profile excluded from their sides' means), so the ally card's
    // three figures all carry the hi tone and the enemy card's the lo one.
    const intelCard = (side: string) =>
      document.querySelector<HTMLElement>(
        `.overlay-chip--${side}.overlay-chip--intel`,
      )!;
    for (const side of ["ally", "enemy"] as const) {
      expect(
        intelCard(side)!.querySelectorAll(".overlay-intel-line--avg b"),
      ).toHaveLength(3);
    }
    for (const b of intelCard("ally")!.querySelectorAll(".overlay-intel-line--avg b")) {
      expect(b.classList.contains("overlay-intel-b--hi")).toBe(true);
      expect(b.classList.contains("overlay-intel-b--lo")).toBe(false);
    }
    for (const b of intelCard("enemy")!.querySelectorAll(".overlay-intel-line--avg b")) {
      expect(b.classList.contains("overlay-intel-b--lo")).toBe(true);
      expect(b.classList.contains("overlay-intel-b--hi")).toBe(false);
    }

    // Serialize the live DOM with the page's own stylesheet inlined so the
    // file renders exactly what the overlay window would. (vitest runs
    // with the package dir as cwd.)
    const css = readFileSync(join(process.cwd(), "src", "overlay", "overlay.scss"), "utf8");
    const stage = document.body.innerHTML;
    const html =
      `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n` +
      `<title>overlay sample frame</title>\n<style>\n${css}\n` +
      `/* sample-only backdrop (the real page is transparent over the game) */\n` +
      `html,body{width:auto;height:auto;background:#2a3648}\n` +
      `.sample-stage{position:relative;width:1600px;height:480px;margin:24px auto;` +
      `overflow:hidden;border-radius:8px}\n` +
      `</style>\n</head>\n<body>\n<div class="sample-stage">\n${stage}\n</div>\n` +
      // The static fixture carries no layout passes (the alignment passes
      // need a real browser measure); mirror chipFit's two column pins
      // here, in production call order — each data-col metric column to
      // its widest face across both sides, then each side's stat cell
      // around those sums (the sparse placeholder cells exempt, exactly
      // like alignStatColumns) — so the sample shows the production
      // column contract: evenly separated metric columns on one
      // alignment line, nickname on the shared edge, the rat row's red
      // dot staying compact instead of stretched to the figures' width.
      `<script>\n// Mirror of overlay/chipFit.ts alignMetricColumns + alignStatColumns:\n` +
      `// pin each data-col metric column to its widest laid-out face across\n` +
      `// both sides, then pin each side's stat cells around those sums,\n` +
      `// SKIPPING the sparse placeholder cells (the rat row's red dot stays\n` +
      `// compact — the production exemption).\n` +
      `const groups = new Map();\n` +
      `for (const b of document.querySelectorAll(".overlay-chip__stat b[data-col]")) {\n` +
      `  const k = b.dataset.col || "";\n` +
      `  if (!groups.has(k)) groups.set(k, []);\n` +
      `  groups.get(k).push(b);\n` +
      `}\n` +
      `for (const cells of groups.values()) {\n` +
      `  const w = Math.max(0, ...cells.map((c) => c.getBoundingClientRect().width));\n` +
      `  if (w > 0) for (const c of cells) c.style.width = Math.ceil(w) + "px";\n` +
      `}\n` +
      `for (const side of ["ally", "enemy"]) {\n` +
      `  const cells = [...document.querySelectorAll(\`.overlay-chip--\${side} .overlay-chip__stat\`)]\n` +
      `    .filter((c) => !c.classList.contains("overlay-chip__stat--sparse"));\n` +
      `  const w = Math.max(0, ...cells.map((c) => c.getBoundingClientRect().width));\n` +
      `  for (const c of cells) c.style.width = Math.ceil(w) + "px";\n` +
      `}\n</script>\n</body>\n</html>\n`;
    // dist/ is gitignored — an artifact path, never a tracked file.
    const out = join(process.cwd(), "dist", "overlay-sample.html");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html, "utf8");
    console.info(`overlay sample written: ${out}`);
    expect(html.length).toBeGreaterThan(2000);
  });
});
