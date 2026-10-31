import { describe, expect, it, vi } from "vitest";

// Imported BEFORE the mocked modules below: the vi.mock factory for shotKit
// runs while those imports evaluate, and it calls fakeAs.
import { fakeAs } from "@/test-utils/fakes";

import { PAD, type ShotFooterStrings } from "@/features/share/shotKit";

import { COL_WIDTH, renderPostBattleShot, type ShotModel } from "./postBattleShot";

interface TextOp {
  text: string;
  x: number;
  align: string;
}

const mocks = vi.hoisted(() => ({
  texts: [] as TextOp[],
  /** Seal-tag faces drawn (their WORDING, i.e. the CJK labels). */
  tagDraws: [] as string[],
  /** Square row-end stamp draws — must stay empty (column retired). */
  stampDraws: [] as unknown[],
}));

/** Fresh recording state for one render. */
function reset(): void {
  mocks.texts.length = 0;
  mocks.tagDraws.length = 0;
  mocks.stampDraws.length = 0;
}

// The kit's browser plumbing is irrelevant to the layout math here: keep the
// real constants/measuring helpers (sealTagWidth/statCellOrigins/font) and
// swap in a recording 2d context + stubbed image/PNG/footer layers, the same
// contract statsShot.test.ts uses. measureText approximates a fixed-advance
// face (7px per character), so every recorded x is deterministic.
vi.mock("@/features/share/shotKit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/share/shotKit")>();
  return {
    ...real,
    loadImage: async () => null,
    canvasToPngBytes: async () => new Uint8Array(),
    footerMinWidth: () => 0,
    drawFooter: () => {},
    // Record the seal faces themselves: the wording proves the StampKind ->
    // STAMP_LABEL mapping, and the square row-end stamp must never draw.
    drawSealTag: (...args: Parameters<typeof real.drawSealTag>) => {
      mocks.tagDraws.push(args[3]);
      real.drawSealTag(...args);
    },
    drawStampSeal: (...args: Parameters<typeof real.drawStampSeal>) => {
      mocks.stampDraws.push(args);
    },
    newShotCanvas: (width: number, height: number) => {
      const canvas = fakeAs<HTMLCanvasElement>({
        width: Math.round(width * real.SCALE),
        height: Math.round(height * real.SCALE),
      });
      const ctx = fakeAs<CanvasRenderingContext2D>({
        canvas,
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        textAlign: "left",
        textBaseline: "alphabetic",
        font: "",
        globalAlpha: 1,
        measureText: (s: string) => fakeAs<TextMetrics>({ width: s.length * 7 }),
        fillText: (s: string, x: number) => {
          mocks.texts.push({ text: s, x, align: ctx.textAlign });
        },
        fillRect: () => {},
        beginPath: () => {},
        roundRect: () => {},
        fill: () => {},
        stroke: () => {},
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
        drawImage: () => {},
        createLinearGradient: () => fakeAs<CanvasGradient>({ addColorStop: () => {} }),
      });
      return { canvas, ctx };
    },
  };
});

/** The watermark/footer lines every real caller passes — the renderer only
 *  forwards them to the stubbed footer painter, so empty strings are fine. */
const FOOTER: ShotFooterStrings = {
  tagline: "",
  disclaimer1: "",
  disclaimer2: "",
  qqGroup: "",
};

/** One copied sheet: a single column whose four rows exercise the career
 *  seal tag, the tier track and the no-seal path. */
function model(): ShotModel {
  return {
    title: "战绩",
    botLabel: "AI",
    columns: [
      {
        title: "我方",
        rows: [
          {
            nick: "FlySh...",
            clanTag: "DLNY",
            shipName: "白露",
            tier: "X",
            sealTags: ["ape"],
            stats: [{ text: "5,600" }, { text: "49.3%" }],
          },
          {
            nick: "Baji...",
            clanTag: "K-E-Y",
            shipName: "剑",
            tier: "VIII",
            stats: [{ text: "1,365" }, { text: "54.6%" }],
          },
          {
            nick: "Ayana...",
            shipName: "明斯克",
            tier: "I",
            sealTags: ["miracle"],
            stats: [{ text: "1,728" }, { text: "55.4%" }],
          },
          {
            nick: "tama...",
            shipName: "最上",
            stats: [{ text: "577" }, { text: "52.7%" }],
          },
        ],
      },
    ],
  };
}

function textOf(prefix: string): TextOp {
  const hit = mocks.texts.find((t) => t.text.startsWith(prefix));
  expect(hit, `missing text "${prefix}"`).toBeTruthy();
  return hit!;
}

describe("post-battle share shot", () => {
  it("presses the career seal as its CJK wording tag before the nickname", async () => {
    reset();
    await renderPostBattleShot(model(), FOOTER);

    expect(mocks.tagDraws).toEqual(["猴", "神了"]);

    // The seal-tag helpers take the face WORDING — a raw StampKind id
    // ("ape") must never reach the canvas.
    expect(mocks.texts.some((t) => t.text === "ape")).toBe(false);
    expect(mocks.texts.some((t) => t.text === "miracle")).toBe(false);

    const seal = textOf("猴");
    expect(seal.align).toBe("center");
    const nick = textOf("FlySh...");
    // Tag cluster: the tag's width then 2px, then the nick — the identity
    // line reads [seal tag][nick], never the reverse.
    const tagW = 1 * 7 + 16; // "猴": one glyph + the tag's 16px chrome
    expect(seal.x).toBe(PAD + 12 + 28 + tagW / 2);
    expect(nick.x).toBe(PAD + 12 + 28 + tagW + 2);
  });

  it("prints the tier label in one fixed track so ship names share an x", async () => {
    reset();
    await renderPostBattleShot(model(), FOOTER);

    const shipA = textOf("白露");
    const shipB = textOf("剑");
    const shipC = textOf("明斯克");
    const shipD = textOf("最上");
    expect(shipA.x).toBe(shipB.x);
    expect(shipB.x).toBe(shipC.x);
    expect(shipC.x).toBe(shipD.x);

    const tierA = textOf("X");
    const tierB = textOf("VIII");
    expect(tierA.align).toBe("center");
    expect(tierB.align).toBe("center");
    expect(tierA.x).toBe(tierB.x);
    // The fixed track starts where the ship-class icon column ends.
    expect(shipA.x).toBe(PAD + 12 + 28 + (4 * 7 + 8));
  });

  it("draws no square row-end stamp and keeps the stat block on the row edge", async () => {
    reset();
    await renderPostBattleShot(model(), FOOTER);

    // The retired right-hand seal column must never come back: no square
    // stamp face is painted, and the only tag faces are the identity-line
    // ones (the model carries a 猴 and a 神了 career seal).
    expect(mocks.stampDraws).toHaveLength(0);
    expect(mocks.tagDraws).toEqual(["猴", "神了"]);

    // Two stat columns, right-aligned: the last cell's right edge is the
    // row card's constant trailing air mark. This pins the CURRENT layout
    // constant (it would also pass on the retired code for a stamp-less
    // model; the real regression guard above is the draw-op assertion).
    const lastCell = mocks.texts.filter((t) => t.align === "right").at(-1)!;
    expect(lastCell.x).toBe(PAD + COL_WIDTH - 38);
  });

  it("starts the nickname at the line head when the row carries no seal", async () => {
    reset();
    await renderPostBattleShot(model(), FOOTER);

    const plain = textOf("tama...");
    expect(plain.x).toBe(PAD + 12 + 28);
  });
});
