/** Pure-logic tests for the replay-playback export: layout math, the GIF
 *  delay grid, settings clamping, the settings-driven estimate inputs, the
 *  team-column layout rules (fixed name size, left-aligned identity, the
 *  centered header labels over right-aligned value tracks, the stats
 *  toggle's full-width fallback) and the header's corner blocks. The
 *  painters are driven with a recording 2D context — no real canvas, no
 *  encoders. */
import { describe, expect, it } from "vitest";

import {
  GIF_MAX_FRAMES,
  clampRangeToBudget,
  exportMaxSpan,
  normalizeExportRange,
  EXPORT_HEADER_H,
  EXPORT_TEAM_ENTRY_H,
  EXPORT_TEAM_H,
  EXPORT_TEAM_HEADER_H,
  EXPORT_TEAM_HEADER_STAT_CY,
  EXPORT_TEAM_HEADER_TITLE_CY,
  EXPORT_TEAM_HP_H,
  EXPORT_TEAM_HP_TOP,
  EXPORT_TEAM_INSET,
  EXPORT_TEAM_MAX_ROWS,
  EXPORT_TEAM_NAME_CY,
  EXPORT_TEAM_NAME_SIZE,
  EXPORT_TEAM_SHIP_CY,
  EXPORT_TEAM_SHIP_SIZE,
  EXPORT_TEAM_STAT_COLS,
  EXPORT_TEAM_STAT_TEXT_SIZE,
  EXPORT_TEAM_STAT_TRACK_W,
  EXPORT_TEAM_INSET_X,
  EXPORT_TEAM_ID_CELL_W,
  EXPORT_HEADER_CORNER_CY,
  drawPlaybackHeader,
  teamIdentityCell,
  teamStatBandWidth,
  PLAYBACK_CODEC_LADDER,
  EXPORT_LOGICAL,
  EXPORT_SIDE_W,
  EXPORT_TOTAL_LOGICAL,
  PLAYBACK_EXPORT_FPS,
  PLAYBACK_EXPORT_SIZES,
  clampExportSettings,
  fitShrinkSize,
  fitTeamName,
  frameTimesAtSpeed,
  gifDelayMs,
  playbackExportLayout,
  teamEntryCapacity,
  visibleTeamStats,
  drawPlaybackTeamColumn,
} from "./playbackExport";
import { FOOT_H, darkPalette } from "@/features/share/shotKit";
import type {
  PlaybackPanelLabels,
  PlaybackTeamRow,
  PlaybackTeamSide,
} from "./playbackExport";
import { TACTICAL_SIZE } from "./tactical/render";

describe("playbackExportLayout", () => {
  it("stacks header + map + footer across the side columns", () => {
    const l = playbackExportLayout(1080, true);
    expect(l.width).toBe(1080);
    expect(l.width % 2).toBe(0);
    expect(l.height % 2).toBe(0);
    // The map square sits between two side columns; band heights follow
    // the shared logical space exactly.
    expect(l.mapLeft).toBeCloseTo(EXPORT_SIDE_W * (1080 / EXPORT_TOTAL_LOGICAL), 6);
    expect(l.mapTop).toBeCloseTo(EXPORT_HEADER_H * (1080 / EXPORT_TOTAL_LOGICAL), 6);
    expect(l.mapSize).toBeCloseTo(EXPORT_LOGICAL * (1080 / EXPORT_TOTAL_LOGICAL), 6);
    expect(l.footerHeight).toBeCloseTo(FOOT_H * (1080 / EXPORT_TOTAL_LOGICAL), 6);
    expect(l.footerTop).toBe(l.height - l.footerHeight);
  });

  it("drops the footer band entirely when the watermark is off", () => {
    const l = playbackExportLayout(720, false);
    expect(l.footerHeight).toBe(0);
    expect(l.footerTop).toBe(l.height);
    // The map square is never clipped by the even-ceil — at most a 2px
    // slack strip of background may follow it.
    const mapBottom = l.mapTop + EXPORT_LOGICAL * l.scale;
    expect(mapBottom).toBeLessThanOrEqual(l.height + 1e-9);
    expect(l.height - mapBottom).toBeLessThanOrEqual(2);
  });

  it("evens up odd target widths instead of shrinking the ladder step", () => {
    const l = playbackExportLayout(1081, true);
    expect(l.width).toBe(1080);
  });

  it("keeps the map square logical space equal to the tactical canvas", () => {
    expect(EXPORT_LOGICAL).toBe(TACTICAL_SIZE);
  });
});

describe("gifDelayMs", () => {
  it("snaps to GIF's centisecond grid", () => {
    expect(gifDelayMs(30)).toBe(30); // 33.3 ms → 30 ms
    expect(gifDelayMs(15)).toBe(70); // 66.7 ms → 70 ms
    expect(gifDelayMs(10)).toBe(100);
  });

  it("never drops below 20 ms (viewers ignore faster delays)", () => {
    expect(gifDelayMs(60)).toBe(20);
    expect(gifDelayMs(500)).toBe(20);
  });
});

describe("frameTimesAtSpeed", () => {
  it("advances speed/fps battle seconds per frame", () => {
    // 100 battle seconds at 30 fps × 10× → a 10 s clip of 301 frames
    // (the schedule is endpoint-inclusive, like frameTimes).
    const t = frameTimesAtSpeed(0, 100, 30, 10);
    expect(t).toHaveLength(301);
    // Values round-trip through toFixed(6) like frameTimes — 1/3
    // keeps a 1e-6 rounding, so compare at that precision.
    expect(t[1] - t[0]).toBeCloseTo(1 / 3, 5);
    expect(t[t.length - 1]).toBeLessThanOrEqual(100 + 1e-9);
  });

  it("degenerates like frameTimes on empty or invalid ranges", () => {
    expect(frameTimesAtSpeed(5, 5, 30, 10)).toEqual([5]);
    expect(frameTimesAtSpeed(5, 4.9, 30, 10)).toEqual([5]);
    expect(frameTimesAtSpeed(Number.NaN, 4, 30, 10)).toEqual([]);
    expect(frameTimesAtSpeed(0, 1, 0, 10)).toEqual([0]);
  });
});

describe("clampExportSettings", () => {
  it("keeps on-ladder values untouched", () => {
    const s = clampExportSettings({ format: "video", from: 0, to: 60, fps: 60, speed: 2, size: 1080, footer: false, stats: true });
    expect(s).toEqual({ format: "video", from: 0, to: 60, fps: 60, speed: 2, size: 1080, footer: false, stats: true });
  });

  it("re-bases fps, speed and size when the format flips", () => {
    const s = clampExportSettings({ format: "gif", from: 0, to: 60, fps: 60, speed: 3, size: 1080, footer: true, stats: false });
    // (1080 is off the GIF width ladder → falls to the ladder's smallest.)
    expect(s.format).toBe("gif");
    expect(PLAYBACK_EXPORT_FPS.gif).toContain(s.fps);
    expect(PLAYBACK_EXPORT_SIZES.gif).toContain(s.size);
    expect([1, 2, 5, 10, 20]).toContain(s.speed);
    // The stats toggle is not a ladder value - it survives the flip.
    expect(s.stats).toBe(false);
  });
});


/* ── Team columns (the live roster full mode rebuilt for the clip) ──────
   The drawing itself needs a canvas; what is unit-tested here is the
   layout arithmetic, the fixed-name-size rule and the header/cell
   structure the drawer consumes. */

/** A deterministic stand-in for canvas measureText: 1 unit per latin
 *  character at the face size, 1.6 units per CJK glyph (roughly the real
 *  ratio at 12px), so a test can reason about overflow without a canvas.
 *  `width` is proportional to the size, which the shrink rule needs. */
const measureText = (text: string, size: number): number => {
  let units = 0;
  for (const ch of text) units += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1.6 : 1;
  return (units * size) / 2;
};

describe("team column budget", () => {
  it("fits 12 three-line entries plus the header inside EXPORT_TEAM_H", () => {
    // The hard budget: inset + header + 12 entries <= the 452px roster half.
    expect(EXPORT_TEAM_MAX_ROWS).toBe(12);
    expect(teamEntryCapacity()).toBeGreaterThanOrEqual(EXPORT_TEAM_MAX_ROWS);
    expect(
      EXPORT_TEAM_INSET +
        EXPORT_TEAM_HEADER_H +
        EXPORT_TEAM_MAX_ROWS * EXPORT_TEAM_ENTRY_H,
    ).toBeLessThanOrEqual(EXPORT_TEAM_H);
    // A 13th entry would NOT fit - the cap is real, not padding.
    expect(
      EXPORT_TEAM_INSET + EXPORT_TEAM_HEADER_H + 13 * EXPORT_TEAM_ENTRY_H,
    ).toBeGreaterThan(EXPORT_TEAM_H);
    // Two fixed 40px stat tracks leave the identity band 88px (190 - 2x8
    // inset - 2x40 - the 6px guard), and the identity cell + ship name fit
    // inside that band with room for a name.
    expect(EXPORT_TEAM_STAT_TRACK_W).toBe(40);
    const identityBand =
      EXPORT_SIDE_W - 2 * EXPORT_TEAM_INSET_X - 2 * EXPORT_TEAM_STAT_TRACK_W - 6;
    expect(identityBand).toBe(88);
    expect(EXPORT_TEAM_ID_CELL_W).toBeLessThan(identityBand);
    expect(identityBand - EXPORT_TEAM_ID_CELL_W - 4).toBeGreaterThanOrEqual(40);
  });

  it("keeps the header around 22-26px and every text band inside its slot", () => {
    expect(EXPORT_TEAM_HEADER_H).toBeGreaterThanOrEqual(22);
    expect(EXPORT_TEAM_HEADER_H).toBeLessThanOrEqual(26);
    // Header: title row above the averages row, both inside the band
    // (text is middle-baselined, so half the face height is the extent).
    expect(EXPORT_TEAM_HEADER_TITLE_CY).toBeLessThan(EXPORT_TEAM_HEADER_STAT_CY);
    expect(
      EXPORT_TEAM_HEADER_STAT_CY + EXPORT_TEAM_STAT_TEXT_SIZE / 2,
    ).toBeLessThanOrEqual(EXPORT_TEAM_HEADER_H);
    // Entry: 12px nick line, 11px ship line, then the slim HP bar.
    expect(EXPORT_TEAM_NAME_SIZE).toBe(12);
    expect(EXPORT_TEAM_SHIP_SIZE).toBe(11);
    // The three lines never overlap: nick, ship, then the HP bar.
    expect(
      EXPORT_TEAM_NAME_CY + EXPORT_TEAM_NAME_SIZE / 2,
    ).toBeLessThanOrEqual(EXPORT_TEAM_SHIP_CY - EXPORT_TEAM_SHIP_SIZE / 2);
    expect(
      EXPORT_TEAM_SHIP_CY + EXPORT_TEAM_SHIP_SIZE / 2,
    ).toBeLessThanOrEqual(EXPORT_TEAM_HP_TOP);
    expect(EXPORT_TEAM_HP_H).toBeLessThanOrEqual(5);
    expect(EXPORT_TEAM_HP_TOP + EXPORT_TEAM_HP_H).toBeLessThanOrEqual(EXPORT_TEAM_ENTRY_H);
  });
});

describe("fitTeamName (the fixed-name-size invariant)", () => {
  it("returns the fixed size for typical widths and leaves the name alone", () => {
    const fit = fitTeamName(measureText, "[HOOD] langyo", 160);
    expect(fit.size).toBe(EXPORT_TEAM_NAME_SIZE);
    expect(fit.text).toBe("[HOOD] langyo");
    expect(fit.ellipsized).toBe(false);
  });

  it("never changes the face size past the cap - it ellipsizes instead", () => {
    const long = "VeryLongPlayerNicknameThatCannotFit";
    const fit = fitTeamName(measureText, long, 80);
    // The 2026-11-20 「字体在不断变化」 report: EVERY name keeps ONE
    // size; only the string is shortened.
    expect(fit.size).toBe(EXPORT_TEAM_NAME_SIZE);
    expect(fit.ellipsized).toBe(true);
    expect(fit.text.endsWith("\u2026")).toBe(true);
    expect(measureText(fit.text, fit.size)).toBeLessThanOrEqual(80);
  });

  it("uses the same size for every name in a column", () => {
    const names = ["A", "medium_nick", "一个很长的玩家昵称超长了", "x".repeat(60)];
    const sizes = new Set(names.map((n) => fitTeamName(measureText, n, 110).size));
    expect([...sizes]).toEqual([EXPORT_TEAM_NAME_SIZE]);
  });
});

describe("fitShrinkSize (line-2 only shrink)", () => {
  it("keeps the size while the string fits", () => {
    expect(fitShrinkSize(measureText, "VIII 雷电", 120, 11)).toBe(11);
  });

  it("shrinks only past the cap, down to the floor", () => {
    // 20 latin chars at 11px measure 110 units > the 100 cap: the face
    // steps down until it fits (10 here), never below the 8.5 floor.
    const mid = fitShrinkSize(measureText, "X".repeat(20), 100, 11, 8.5);
    expect(mid).toBeGreaterThanOrEqual(8.5);
    expect(mid).toBeLessThan(11);
    expect(measureText("X".repeat(20), mid)).toBeLessThanOrEqual(100);
    // A hopeless overflow bottoms out at the floor; the caller ellipsizes
    // there (fillFit) instead of shrinking further.
    expect(fitShrinkSize(measureText, "X".repeat(60), 100, 11, 8.5)).toBe(8.5);
  });
});

describe("team header structure", () => {
  it("paints the stats config\u2019s FIRST TWO columns in order", () => {
    const columns = [
      { label: "胜率", text: "52.3%" },
      { label: "PR", text: "1450" },
      { label: "场次", text: "1,024" },
    ];
    expect(EXPORT_TEAM_STAT_COLS).toBe(2);
    expect(visibleTeamStats(columns)).toEqual(columns.slice(0, 2));
    // Header and entries share the SAME slice helper, so the averages can
    // never sit above different columns than the cells.
    expect(visibleTeamStats([])).toEqual([]);
  });
});

describe("PLAYBACK_CODEC_LADDER", () => {
  it("ships VP9 then AV1 inside MP4, H.264 as the last resort", () => {
    expect(PLAYBACK_CODEC_LADDER).toEqual([
      { codec: "vp9", ext: "mp4" },
      { codec: "av1", ext: "mp4" },
      { codec: "avc", ext: "mp4" },
    ]);
  });

  it("never muxes VP8 into MP4 (no player decodes vp08)", () => {
    for (const rung of PLAYBACK_CODEC_LADDER) {
      expect(rung.codec).not.toBe("vp8");
    }
    // Every rung lands in the MP4 container the modal advertises.
    expect(PLAYBACK_CODEC_LADDER.every((r) => r.ext === "mp4")).toBe(true);
  });
});

describe("export range helpers", () => {
  it("GIF takes the 1500-frame budget", () => {
    expect(GIF_MAX_FRAMES).toBe(1500);
  });

  it("exportMaxSpan is the endpoint-inclusive budget span", () => {
    // 1500 frames at 10 fps × 10× speed → 1499 steps of 1 battle second.
    expect(exportMaxSpan("gif", 10, 10)).toBeCloseTo(1499, 6);
    // Video is not auto-clamped (its budget is a refusal, not a shrink).
    expect(exportMaxSpan("video", 30, 1)).toBeCloseTo(29999 / 30, 6);
  });

  it("clampRangeToBudget shortens GIF only", () => {
    const span = exportMaxSpan("gif", 10, 10);
    expect(clampRangeToBudget(0, 5000, "gif", 10, 10)).toBeCloseTo(span, 6);
    expect(clampRangeToBudget(0, 5000, "video", 30, 5)).toBe(5000);
    // A window inside the budget is untouched.
    expect(clampRangeToBudget(100, 300, "gif", 10, 10)).toBe(300);
  });

  it("normalizeExportRange orders, clamps and caps the window", () => {
    const r = normalizeExportRange(50, 10, 600, "video", 30, 1);
    expect(r.from).toBe(10);
    expect(r.to).toBe(50);
    expect(normalizeExportRange(-5, 9999, 600, "video", 30, 1)).toEqual({ from: 0, to: 600 });
    // Hairline windows keep at least one frame step.
    const hair = normalizeExportRange(100, 100, 600, "video", 30, 1);
    expect(hair.to - hair.from).toBeGreaterThan(0);
    // GIF end capped by the budget — only bites once the window exceeds it
    // (the fixture's whole battle is shorter than the 1499 s budget span).
    const gif = normalizeExportRange(0, 600, 600, "gif", 10, 10);
    expect(gif.to).toBe(600);
    const long = normalizeExportRange(0, 5000, 5000, "gif", 10, 10);
    expect(long.to).toBeCloseTo(exportMaxSpan("gif", 10, 10), 6);
  });
});

/* ── The painter itself (recording 2D context) ────────────────────────
   No real canvas here: a stub records every fillText/fillRect with the
   face, alignment and ink in force, so the CANVAS-side invariants (one
   name size, centered lines, the header structure, the capped entry
   count) are checked against what actually gets painted. */

interface PaintedText {
  text: string;
  x: number;
  y: number;
  font: string;
  align: string;
  fill: string;
}
interface PaintedRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

function recordingContext() {
  const texts: PaintedText[] = [];
  const rects: PaintedRect[] = [];
  const stack: Array<Record<string, unknown>> = [];
  const ctx: Record<string, unknown> = {
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    measureText(text: string) {
      const m = /(\d+(?:\.\d+)?)px/.exec(String(ctx.font));
      const size = m ? Number.parseFloat(m[1]) : 10;
      // 13 units per CJK glyph, 7.5 per latin character at 12px - the
      // proportions the real stacks show closely enough for layout.
      let units = 0;
      for (const ch of text) units += /[\u3000-\u9fff]/.test(ch) ? 1.3 : 0.62;
      return { width: units * size };
    },
    fillText(text: string, x: number, y: number) {
      texts.push({
        text: String(text),
        x,
        y,
        font: String(ctx.font),
        align: String(ctx.textAlign),
        fill: String(ctx.fillStyle),
      });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, fill: String(ctx.fillStyle) });
    },
    save() {
      stack.push({
        font: ctx.font,
        textAlign: ctx.textAlign,
        fillStyle: ctx.fillStyle,
        strokeStyle: ctx.strokeStyle,
        lineWidth: ctx.lineWidth,
        globalAlpha: ctx.globalAlpha,
      });
    },
    restore() {
      const s = stack.pop();
      if (s) Object.assign(ctx, s);
    },
    beginPath() {},
    arc() {},
    fill() {},
    translate() {},
    rotate() {},
    scale() {},
    roundRect() {},
    stroke() {},
    strokeRect() {},
    setLineDash() {},
    drawImage() {},
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    texts,
    rects,
  };
}

const LABELS: PlaybackPanelLabels = {
  teamAlly: "Allies",
  teamEnemy: "Enemies",
  teamAvg: "Avg",
  noStats: "No stat columns",
  damage: "Damage",
  dmgFrags: "Frags",
  dmgTaken: "Taken",
  chat: "Chat",
};

function teamRow(i: number, over: Partial<PlaybackTeamRow> = {}): PlaybackTeamRow {
  return {
    name: "p" + String(i).padStart(2, "0"),
    clan: null,
    shipName: "Ship" + i,
    tier: "VIII",
    shipType: "Battleship",
    medals: [],
    stats: [
      { text: "52.3%", color: "rgb(71 227 165)" },
      { text: "1450" },
    ],
    hpFrac: 0.75,
    dead: false,
    ...over,
  };
}

function sideOf(rows: PlaybackTeamRow[]): PlaybackTeamSide {
  return {
    columns: [
      { label: "\u80dc\u7387", text: "52.3%", color: "rgb(71 227 165)" },
      { label: "PR", text: "1450" },
    ],
    rows,
  };
}

describe("drawPlaybackTeamColumn", () => {
  it("paints one fixed name size for every row and caps at 12 entries", () => {
    const { ctx, texts } = recordingContext();
    const rows = Array.from({ length: 13 }, (_, i) => teamRow(i));
    rows[0] = teamRow(0, {
      name: "AReallyLongPlayerNicknameThatCannotFitAtAll",
    });
    drawPlaybackTeamColumn(
      ctx, 0, 0, EXPORT_SIDE_W, sideOf(rows), "ally",
      "74 222 128", "Allies", darkPalette(), LABELS,
      () => null,
    );
    // Every nickname painted at the SAME face - the fixed-size invariant.
    const nickTexts = texts.filter((t) => /^p\d\d|^AReallyLong/.test(t.text));
    expect(nickTexts).toHaveLength(EXPORT_TEAM_MAX_ROWS);
    for (const nick of nickTexts) {
      expect(nick.font).toContain(String(EXPORT_TEAM_NAME_SIZE) + "px");
    }
    // The 13th row never paints (the cap), and the long name ellipsizes
    // rather than shrinking.
    expect(nickTexts.some((t) => t.text === "p12")).toBe(false);
    expect(nickTexts[0].text.endsWith("\u2026")).toBe(true);
  });

  it("left-aligns the nick at the column inset and keeps the HP bar full width", () => {
    const { ctx, texts, rects } = recordingContext();
    drawPlaybackTeamColumn(
      ctx, 0, 0, EXPORT_SIDE_W, sideOf([teamRow(1)]), "ally",
      "74 222 128", "Allies", darkPalette(), LABELS,
      () => null,
    );
    const nick = texts.find((t) => t.text === "p01");
    expect(nick).toBeDefined();
    // The 2026-11-21 「全体左对齐」 report: the nick starts at the LEFT
    // inset, never on the column centre.
    expect(nick!.x).toBe(EXPORT_TEAM_INSET_X);
    expect(nick!.align).toBe("left");
    // Every row's nick shares that exact left edge.
    const ctx2 = recordingContext();
    drawPlaybackTeamColumn(
      ctx2.ctx, 0, 0, EXPORT_SIDE_W, sideOf([teamRow(1), teamRow(2), teamRow(3)]), "ally",
      "74 222 128", "Allies", darkPalette(), LABELS,
      () => null,
    );
    const nicks = ctx2.texts.filter((t) => /^p0\d$/.test(t.text));
    expect(nicks.length).toBe(3);
    for (const n of nicks) expect(n.x).toBe(EXPORT_TEAM_INSET_X);
    // Ship line: the roman tier and the ship name ride the same line, the
    // ship starting right after the FIXED identity cell.
    const tier = texts.find((t) => t.text === "VIII");
    const ship = texts.find((t) => t.text === "Ship1");
    expect(tier).toBeDefined();
    expect(ship).toBeDefined();
    expect(ship!.y).toBe(tier!.y);
    expect(ship!.y).toBeGreaterThan(nick!.y);
    expect(ship!.x).toBe(EXPORT_TEAM_INSET_X + EXPORT_TEAM_ID_CELL_W + 4);
    expect(ship!.align).toBe("left");
    // Tier content centres inside its fixed cell: it starts after the cell
    // edge's left inset and ends before the cell's right edge.
    expect(tier!.x).toBeGreaterThan(EXPORT_TEAM_INSET_X);
    expect(tier!.x).toBeLessThan(EXPORT_TEAM_INSET_X + EXPORT_TEAM_ID_CELL_W);
    // The two stats hug the RIGHT edge on the ship line, in column order
    // (the header paints the same average text earlier - take the LAST).
    const percents = texts.filter((t) => t.text === "52.3%");
    const stat = percents[percents.length - 1];
    expect(stat.align).toBe("right");
    expect(stat.y).toBe(ship!.y);
    expect(stat.x).toBeGreaterThan(EXPORT_SIDE_W - 60);
    // ...and they end exactly on their own track's right edge (the first
    // track ends 40px before the column's right inset).
    expect(stat.x).toBe(EXPORT_SIDE_W - EXPORT_TEAM_INSET_X - EXPORT_TEAM_STAT_TRACK_W);
    // The HP bar spans the column's inner width at 5px tall.
    const bar = rects.find(
      (r) =>
        r.h === EXPORT_TEAM_HP_H && r.w === EXPORT_SIDE_W - 16 && r.y > 0,
    );
    expect(bar).toBeDefined();
  });

  it("centres the header labels over their tracks, averages right in them", () => {
    const { ctx, texts } = recordingContext();
    drawPlaybackTeamColumn(
      ctx, 0, 0, EXPORT_SIDE_W, sideOf([teamRow(0)]), "ally",
      "74 222 128", "Allies", darkPalette(), LABELS,
      () => null,
    );
    const label = texts.find((t) => t.text === "\u80dc\u7387");
    const avg = texts.find((t) => t.text === "52.3%");
    // The label sits ABOVE the average, both inside the header band.
    expect(label).toBeDefined();
    expect(avg).toBeDefined();
    expect(label!.y).toBeLessThan(avg!.y);
    expect(avg!.y).toBeLessThan(EXPORT_TEAM_HEADER_H);
    // The label is CENTERED over its own 40px track (the last two tracks
    // of the column: 190 - 8 inset - 2 x 40).
    const statsLeft = EXPORT_SIDE_W - EXPORT_TEAM_INSET_X - 2 * EXPORT_TEAM_STAT_TRACK_W;
    expect(label!.align).toBe("center");
    expect(label!.x).toBe(statsLeft + EXPORT_TEAM_STAT_TRACK_W / 2);
    // The PR label is the second track's centre.
    const prLabel = texts.find((t) => t.text === "PR");
    expect(prLabel).toBeDefined();
    expect(prLabel!.x).toBe(statsLeft + 1.5 * EXPORT_TEAM_STAT_TRACK_W);
    // The averages row carries its caption (so the numbers read as team
    // means, not one player\u2019s)...
    expect(texts.some((t) => t.text === "Avg")).toBe(true);
    // ...and the averages themselves plus the row cells stay RIGHT-aligned
    // inside their own tracks (the first 52.3% is the average, the second
    // the row's cell - both end on the track's right edge).
    const values = texts.filter((t) => t.text === "52.3%");
    expect(values.length).toBe(2);
    for (const v of values) {
      expect(v.align).toBe("right");
      expect(v.x).toBe(statsLeft + EXPORT_TEAM_STAT_TRACK_W);
    }
  });

  it("drops the whole stat band when the toggle is off (full-width identity)", () => {
    const withStats = recordingContext();
    drawPlaybackTeamColumn(
      withStats.ctx, 0, 0, EXPORT_SIDE_W, sideOf([teamRow(1, { shipName: "LongShipNameTwelve" })]), "ally",
      "74 222 128", "Allies", darkPalette(), LABELS,
      () => null,
      true,
    );
    const without = recordingContext();
    drawPlaybackTeamColumn(
      without.ctx, 0, 0, EXPORT_SIDE_W, sideOf([teamRow(1, { shipName: "LongShipNameTwelve" })]), "ally",
      "74 222 128", "Allies", darkPalette(), LABELS,
      () => null,
      false,
    );
    // No stat labels, no averages caption, no values - anywhere.
    expect(without.texts.some((t) => t.text === "52.3%")).toBe(false);
    expect(without.texts.some((t) => t.text === "1450")).toBe(false);
    expect(without.texts.some((t) => t.text === "PR")).toBe(false);
    expect(without.texts.some((t) => t.text === "Avg")).toBe(false);
    // The identity still paints: nick at the inset, ship in its cell.
    expect(without.texts.find((t) => t.text === "p01")).toBeDefined();
    // The identity band now owns the column: the 17-char ship name that
    // ellipsized beside the stat tracks fits whole in the full-width band.
    const shipOff = without.texts.find((t) => t.text.startsWith("LongShip"));
    expect(shipOff).toBeDefined();
    expect(shipOff!.text).toBe("LongShipNameTwelve");
    const shipOn = withStats.texts.find((t) => t.text.startsWith("LongShip"));
    expect(shipOn!.text.endsWith("\u2026")).toBe(true);
    // The HP bar is unchanged (full inner width), and the vertical budget
    // still holds with a ZERO-width stat band: 6 + 26 + 12 x 34 <= 452.
    expect(teamStatBandWidth([])).toBe(0);
    expect(
      EXPORT_TEAM_INSET + EXPORT_TEAM_HEADER_H + EXPORT_TEAM_MAX_ROWS * EXPORT_TEAM_ENTRY_H,
    ).toBeLessThanOrEqual(EXPORT_TEAM_H);
    expect(teamEntryCapacity()).toBeGreaterThanOrEqual(EXPORT_TEAM_MAX_ROWS);
  });
});

describe("teamIdentityCell", () => {
  it("centres the glyph + tier group inside the fixed cell", () => {
    const cellX = 8;
    const cell = teamIdentityCell(cellX, EXPORT_TEAM_ID_CELL_W, 12, 4, 10, true);
    expect(cell.contentW).toBe(12 + 4 + 10);
    // A 26-wide content group inside the 36px cell starts 5px in...
    expect(cell.iconX - cellX).toBeCloseTo((EXPORT_TEAM_ID_CELL_W - 26) / 2, 6);
    // ...and the tier follows the glyph by the cell's inner gap.
    expect(cell.tierX).toBeCloseTo(cell.iconX + 16, 6);
    // Tier text ending flush with the content group always stays inside
    // the cell.
    expect(cell.tierX + 10).toBeLessThanOrEqual(cellX + EXPORT_TEAM_ID_CELL_W);
  });

  it("keeps a tier-only cell centred and never goes negative", () => {
    const cell = teamIdentityCell(8, EXPORT_TEAM_ID_CELL_W, 12, 4, 0, false);
    expect(cell.iconX).toBe(8 + (EXPORT_TEAM_ID_CELL_W - 0) / 2);
    // A content group WIDER than the cell starts flush left, never left of
    // the cell (the caller pre-fits the tier; this is the guard).
    const wide = teamIdentityCell(8, EXPORT_TEAM_ID_CELL_W, 12, 4, 40, true);
    expect(wide.iconX).toBe(8);
  });
});

describe("drawPlaybackHeader corners", () => {
  const header = (over: Partial<Parameters<typeof drawPlaybackHeader>[1]>) => ({
    clock: "03:12",
    scoreAlly: null,
    scoreEnemy: null,
    caps: [],
    ships: [],
    ...over,
  });

  it("paints the map/mode/start block LEFT and the duration/winner RIGHT", () => {
    const { ctx, texts } = recordingContext();
    const info = ["58 Ridge · Random battle", "2026-11-08 22:43"];
    const outcome = ["Duration 20:34", "Our team won"];
    drawPlaybackHeader(
      ctx,
      header({ infoLines: info, outcomeLines: outcome }),
      darkPalette(),
      () => null,
    );
    const left = texts.filter((t) => t.text === info[0] || t.text === info[1]);
    expect(left.length).toBe(2);
    for (const t of left) {
      expect(t.align).toBe("left");
      expect(t.x).toBe(10);
    }
    // Two stacked small lines at the corner's own baselines.
    expect(left[0].y).toBe(EXPORT_HEADER_CORNER_CY[0]);
    expect(left[1].y).toBe(EXPORT_HEADER_CORNER_CY[1]);
    const right = texts.filter((t) => t.text === outcome[0] || t.text === outcome[1]);
    expect(right.length).toBe(2);
    for (const t of right) {
      expect(t.align).toBe("right");
      expect(t.x).toBe(EXPORT_TOTAL_LOGICAL - 10);
    }
    // The centre still carries the clock (the pill's own row).
    expect(texts.some((t) => t.text === "03:12" && t.align === "center")).toBe(true);
  });

  it("omits a corner block gracefully when its data is missing", () => {
    const { ctx, texts } = recordingContext();
    drawPlaybackHeader(
      ctx,
      header({ infoLines: ["58 Ridge · Random battle"], outcomeLines: [] }),
      darkPalette(),
      () => null,
    );
    expect(texts.some((t) => t.text === "58 Ridge · Random battle")).toBe(true);
    // Nothing was invented for the missing outcome block.
    expect(texts.filter((t) => t.align === "right")).toHaveLength(0);
  });
});
