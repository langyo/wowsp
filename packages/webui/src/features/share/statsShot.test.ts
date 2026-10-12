import { beforeAll, describe, expect, it, vi } from "vitest";

import { initLocaleMessages } from "@/i18n";

import { FOOT_H, PAD } from "./shotKit";
import type { StatsShotModel } from "./statsShot";
import { renderStatsShot } from "./statsShot";

/** The bottom edge of every content draw op, so the tests can measure the
 *  air between the last block and the footer band (the 0-battle regression). */
const mocks = vi.hoisted(() => ({
  ops: [] as number[],
  heights: [] as number[],
}));

// The kit's browser plumbing (canvas backing store, image loads, PNG encode,
// footer width probe) is irrelevant to the layout math here; keep every real
// constant, and swap in a recording 2d context whose canvas carries the
// height renderStatsShot asked for — that is what the footer band anchors
// to. The footer painter itself is stubbed out so that every recorded op is
// content: a block drawn into the band shows up as negative air below.
vi.mock("./shotKit", async (importOriginal) => {
  const real = await importOriginal<typeof import("./shotKit")>();
  return {
    ...real,
    loadImage: async () => null,
    canvasToPngBytes: async () => new Uint8Array(),
    footerMinWidth: () => 0,
    drawFooter: () => {},
    newShotCanvas: (width: number, height: number) => {
      const canvas = {
        width: Math.round(width * real.SCALE),
        height: Math.round(height * real.SCALE),
      };
      mocks.heights.push(height);
      const ctx = {
        canvas,
        fillStyle: "",
        textAlign: "left",
        textBaseline: "alphabetic",
        font: "",
        measureText: (s: string) => ({ width: s.length * 7 }),
        fillText: (_s: string, _x: number, y: number) => {
          // Middle-baseline text boxes, the only baseline the renderer sets.
          const size = Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? "10");
          const half = ctx.textBaseline === "middle" ? size / 2 : 0;
          mocks.ops.push(y + (ctx.textBaseline === "middle" ? half : size));
        },
        fillRect: (_x: number, y: number, _w: number, h: number) => {
          mocks.ops.push(y + h);
        },
        beginPath: () => {},
        roundRect: (_x: number, y: number, _w: number, h: number) => {
          mocks.ops.push(y + h);
        },
        fill: () => {},
        save: () => {},
        restore: () => {},
        clip: () => {},
        // Only the untransformed icon draws (ship rows); seal glyphs live
        // under a rotate/translate this stub does not track, and no fixture
        // here carries a seal.
        drawImage: (
          _img: unknown,
          _x: number,
          y: number,
          _w: number,
          h: number,
        ) => {
          mocks.ops.push(y + h);
        },
      };
      return {
        canvas: canvas as unknown as HTMLCanvasElement,
        ctx: ctx as unknown as CanvasRenderingContext2D,
      };
    },
  };
});

beforeAll(async () => {
  await initLocaleMessages();
});

/** Air between the lowest painted content bottom and the footer band's top
 *  hairline, in logical units. The footer painter is stubbed out, so every
 *  recorded op is content — a block reaching into the band comes back
 *  negative. */
function bottomAir(): number {
  const height = mocks.heights[mocks.heights.length - 1];
  return height - FOOT_H - Math.max(...mocks.ops);
}

async function render(model: StatsShotModel): Promise<number> {
  mocks.ops.length = 0;
  mocks.heights.length = 0;
  await renderStatsShot(model, {});
  expect(mocks.ops.length).toBeGreaterThan(0);
  return bottomAir();
}

const EMPTY_MODEL: StatsShotModel = {
  title: "我的水表",
  rangeLabel: "全部",
  realm: "ASIA",
  name: "_Nahida_",
  clanTag: "U1S1",
  prOn: false,
  hero: { winrate: "—", winrateLabel: "胜率", battlesText: "0 场次" },
  divisions: [],
  kpis: [
    { label: "场次", value: "0" },
    { label: "场均伤害", value: "—" },
    { label: "场均经验", value: "—" },
    { label: "击杀比", value: "—" },
    { label: "存活率", value: "—" },
    { label: "命中率", value: "—" },
  ],
  typeChips: [],
  shipsTitle: "常用舰船",
  shipsHead: ["场次", "胜率", "场均伤害", "击杀比"],
  ships: [],
};

const FULL_MODEL: StatsShotModel = {
  ...EMPTY_MODEL,
  hero: { winrate: "52.3%", winrateLabel: "胜率", battlesText: "1,234 场次" },
  divisions: [
    { label: "单野", value: "51.2%" },
    { label: "双排", value: "54.0%" },
    { label: "三排", value: "55.1%" },
    { label: "排位", value: "50.0%" },
  ],
  kpis: [
    { label: "场次", value: "1,234" },
    { label: "场均伤害", value: "55,432" },
    { label: "场均经验", value: "1,234" },
    { label: "击杀比", value: "0.89" },
    { label: "存活率", value: "42%" },
    { label: "命中率", value: "38%" },
  ],
  typeChips: [
    { code: "BB", battles: "412", value: "53.1%" },
    { code: "CA", battles: "356", value: "51.2%" },
    { code: "DD", battles: "289", value: "52.4%" },
    { code: "CV", battles: "98", value: "50.8%" },
    { code: "SS", battles: "79", value: "48.1%" },
  ],
  ships: [
    {
      name: "Grosser Kurfürst",
      shipType: "Battleship",
      cells: [{ text: "120" }, { text: "58.3%" }, { text: "98,432" }, { text: "1.02" }],
    },
    {
      name: "Yamato",
      shipType: "Battleship",
      cells: [{ text: "98" }, { text: "54.1%" }, { text: "88,120" }, { text: "0.94" }],
    },
    {
      name: "Des Moines",
      shipType: "Cruiser",
      cells: [{ text: "77" }, { text: "52.0%" }, { text: "61,200" }, { text: "0.88" }],
    },
  ],
  moreShips: "+2 艘舰船",
};

describe("renderStatsShot footer clearance", () => {
  // The reported regression: a 0-battle table drops the division strip, chips
  // and ship list, so the KPI grid is the last block — and its cards landed
  // flush on the footer hairline (no bottom air at all).
  it("keeps the page's minimum margin when the table is empty", async () => {
    expect(await render(EMPTY_MODEL)).toBeGreaterThanOrEqual(PAD - 0.01);
  });

  it("keeps at least the same margin with every block present", async () => {
    expect(await render(FULL_MODEL)).toBeGreaterThanOrEqual(PAD - 0.01);
  });
});
