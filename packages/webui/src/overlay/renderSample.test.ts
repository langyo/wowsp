/**
 * Sample-frame renderer for the Tab overlay's chip design: drives the real
 * main.ts bootstrap with a settled battle (every stat landed, seals on,
 * team averages on, one hidden profile) and serializes the live DOM into a
 * self-contained HTML file — `dist/overlay-sample.html` (gitignored), the
 * page's own overlay.scss inlined — so the chip typography can be SCREENSHOT
 * and reviewed (the mono number faces, the split battles-count unit, the
 * two-column lean). The assertions pin the markup contract the picture
 * depends on; the picture itself is the deliverable (open the file, or
 * photograph it in a browser).
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
// figures align across rows of different magnitudes.
const ROSTER = [
  { name: "[HERO]wersskysks", relation: 1, winrate: 54.3, pr: 1604, battles: 2391, dmg: 56000 },
  { name: "langyo", relation: 0, winrate: 56.8, pr: 1715, battles: 14800, dmg: 91000 },
  { name: "[GHOST]mkwp22", relation: 1, winrate: 42.2, pr: 499, battles: 595, dmg: 30500 },
  { name: "korea4950", relation: 2, winrate: 45.4, pr: 649, battles: 2895, dmg: 40300 },
  { name: "ByakuyaWN", relation: 2, winrate: 52.5, pr: 1424, battles: 10200, dmg: 74600 },
  // A hidden profile: the red-dot face, no numbers.
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
    (el) => !el.classList.contains("overlay-chip--intel"),
  );

beforeAll(async () => {
  history.replaceState(null, "", "?realm=ru&locale=zh-CN");
  localStorage.setItem(
    STATS_PREFS_STORAGE_KEY,
    JSON.stringify({
      overlayTeamAvg: { winrate: true, pr: true, damage: true },
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
    // the four mono figures (winrate / PR / battles / damage), every
    // battles count carries the split unit word, the hidden row carries
    // the red dot, and both average lines settled into numbers.
    const numbered = rowChips().filter((c) => c.querySelector(".overlay-chip__stat b"));
    expect(numbered).toHaveLength(5);
    for (const chip of numbered) {
      // Four figures, each in its own fixed-width column cell.
      expect(chip.querySelectorAll(".overlay-chip__stat b")).toHaveLength(4);
      for (const cls of ["n-wr", "n-pr", "n-battles", "n-dmg"]) {
        expect(chip.querySelectorAll(`.overlay-num.${cls}`)).toHaveLength(1);
      }
    }
    expect(document.querySelectorAll(".overlay-chip__stat .overlay-unit")).toHaveLength(5);
    expect(document.querySelector(".overlay-chip__stat .hidden")).not.toBeNull();
    const avgLines = [
      ...document.querySelectorAll<HTMLElement>(".overlay-intel-line--avg"),
    ];
    expect(avgLines).toHaveLength(2);
    for (const line of avgLines) {
      expect(line.querySelector("b")).not.toBeNull();
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
      // The static fixture carries no layout passes (alignStatColumns needs
      // a real browser measure); mirror its column pin here so the sample
      // shows the production two-column contract — a hidden-profile row's
      // dot cell is pinned to the side's widest face exactly like every
      // numbered row, keeping the nickname on the shared column edge.
      `<script>\n// Mirror of overlay/chipFit.ts alignStatColumns: pin each side's stat\n` +
      `// cells to the widest face so this static sample shows the production\n` +
      `// two-column contract (hidden-profile dot cells included).\n` +
      `for (const side of ["ally", "enemy"]) {\n` +
      `  const cells = [...document.querySelectorAll(\`.overlay-chip--\${side} .overlay-chip__stat\`)];\n` +
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
