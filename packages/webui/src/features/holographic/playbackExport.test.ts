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
  EXPORT_RECORDER_BLOCK_H,
  EXPORT_RECORDER_BAND_GAP,
  EXPORT_RECORDER_BOTTOM_INSET,
  EXPORT_RECORDER_INSET_X,
  EXPORT_RECORDER_RIBBON_COLS,
  EXPORT_RECORDER_RIBBON_ROWS,
  EXPORT_RECORDER_SOURCE_CAPTION_H,
  EXPORT_RECORDER_SOURCE_COLUMNS,
  EXPORT_RECORDER_SOURCE_GAP,
  EXPORT_RECORDER_SOURCE_ROWS,
  EXPORT_RECORDER_SOURCE_ROW_H,
  EXPORT_RECORDER_TOP_GAP,
  buildRecorderSourceHits,
  drawRecorderPanel,
  foldRecorderSources,
  recorderPanelBands,
  recorderPanelFits,
  recorderPanelHeight,
  recorderRibbonBandHeight,
  recorderSourceBandHeight,
  recorderSourceColumnWidth,
  recorderSourceLabel,
} from "./playbackExport";
import { FOOT_H, darkPalette } from "@/features/share/shotKit";
import type {
  PlaybackPanelLabels,
  PlaybackRecorderStats,
  PlaybackTeamRow,
  PlaybackTeamSide,
  RecorderSourceHit,
} from "./playbackExport";
import { RIBBON_SOURCES } from "@/features/replay/postBattle";
import type { EntityTrajectory, ShotKillEvent } from "@/api";
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
interface PaintedImage {
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function recordingContext() {
  const texts: PaintedText[] = [];
  const rects: PaintedRect[] = [];
  const images: PaintedImage[] = [];
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
    moveTo() {},
    lineTo() {},
    closePath() {},
    arc() {},
    fill() {},
    translate() {},
    rotate() {},
    scale() {},
    roundRect() {},
    stroke() {},
    strokeRect() {},
    setLineDash() {},
    drawImage(img: unknown, x: number, y: number, w: number, h: number) {
      const src = (img as { src?: string } | null)?.src ?? "";
      images.push({ src, x, y, w, h });
    },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    texts,
    rects,
    images,
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
  ribbonsTitle: "Ribbons",
  dmgDealtSources: "Damage dealt",
  dmgTakenSources: "Damage taken",
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

  it("right-aligns the header labels with the averages beneath them", () => {
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
    // The label shares the average's right edge inside its own 40px track
    // (the last two tracks of the column: 190 - 8 inset - 2 x 40) — a
    // centered label sits left of the number it names.
    const statsLeft = EXPORT_SIDE_W - EXPORT_TEAM_INSET_X - 2 * EXPORT_TEAM_STAT_TRACK_W;
    expect(label!.align).toBe("right");
    expect(label!.x).toBe(statsLeft + EXPORT_TEAM_STAT_TRACK_W);
    // The PR label rides the second track's right edge.
    const prLabel = texts.find((t) => t.text === "PR");
    expect(prLabel).toBeDefined();
    expect(prLabel!.x).toBe(statsLeft + 2 * EXPORT_TEAM_STAT_TRACK_W);
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

  // ── Repair Party's grey recoverable segment (the game's three-layer
  //    bar: green | grey | red) ─────────────────────────────────────────
  it("paints green | grey | red with the grey eating the red width", () => {
    const { ctx, rects } = recordingContext();
    drawPlaybackTeamColumn(
      ctx, 0, 0, EXPORT_SIDE_W,
      sideOf([teamRow(1, { hpFrac: 0.5, hpRecoverableFrac: 0.25 })]), "ally",
      "74 222 128", "Allies", darkPalette(), LABELS,
      () => null,
    );
    const bar = rects.filter((r) => r.h === EXPORT_TEAM_HP_H);
    // Rail + the three layers, in paint order.
    expect(bar).toHaveLength(4);
    const [rail, red, gray, green] = bar;
    const barW = EXPORT_SIDE_W - EXPORT_TEAM_INSET_X * 2;
    expect(rail.w).toBeCloseTo(barW, 6);
    // Green keeps the current HP: 0..50% of the track.
    expect(green.x).toBeCloseTo(rail.x, 6);
    expect(green.w).toBeCloseTo(barW * 0.5, 6);
    // Grey: 50%..75% — the recoverable pool, sitting BETWEEN green and red.
    expect(gray.x).toBeCloseTo(rail.x + barW * 0.5, 6);
    expect(gray.w).toBeCloseTo(barW * 0.25, 6);
    // Red: 75%..100% — lost for good.
    expect(red.x).toBeCloseTo(rail.x + barW * 0.75, 6);
    expect(red.w).toBeCloseTo(barW * 0.25, 6);
    // Each layer carries its own ink (the grey is the hull plaque's own
    // repairable grey, the red the lost-for-good tint).
    expect(gray.fill).toBe("rgba(200,208,220,0.85)");
    expect(red.fill).toBe("rgba(248,92,92,0.45)");
    expect(green.fill).toBe("rgba(251,191,36,0.95)");
  });

  it("keeps the two-layer bar when the hull has no Repair Party data", () => {
    const { ctx, rects } = recordingContext();
    drawPlaybackTeamColumn(
      ctx, 0, 0, EXPORT_SIDE_W,
      sideOf([teamRow(1, { hpFrac: 0.5, hpRecoverableFrac: null })]), "ally",
      "74 222 128", "Allies", darkPalette(), LABELS,
      () => null,
    );
    const bar = rects.filter((r) => r.h === EXPORT_TEAM_HP_H);
    // Rail + green only: the historical bar, byte-identical to before.
    expect(bar).toHaveLength(2);
    expect(bar[1].w).toBeCloseTo((EXPORT_SIDE_W - EXPORT_TEAM_INSET_X * 2) * 0.5, 6);
  });

  it("clamps a pool wider than the lost HP to the lost remainder", () => {
    const { ctx, rects } = recordingContext();
    drawPlaybackTeamColumn(
      ctx, 0, 0, EXPORT_SIDE_W,
      sideOf([teamRow(1, { hpFrac: 0.6, hpRecoverableFrac: 0.9 })]), "ally",
      "74 222 128", "Allies", darkPalette(), LABELS,
      () => null,
    );
    const bar = rects.filter((r) => r.h === EXPORT_TEAM_HP_H);
    const [, red, gray, green] = bar;
    const barW = EXPORT_SIDE_W - EXPORT_TEAM_INSET_X * 2;
    // Green never shrinks; the grey takes the remaining 40% and red is 0.
    expect(green.w).toBeCloseTo(barW * 0.6, 6);
    expect(gray.w).toBeCloseTo(barW * 0.4, 6);
    expect(red.w).toBe(0);
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

/* ── The recorder panel: budget, attribution, painter ───────────────────
   The 2026-11-21 「勋带弄齐全 + 造成/受到伤害来源」 request: the bottom-left
   block keeps its damage headline and adds the settlement ribbon strip and
   the two damage-source columns. The budget is hard (292 logical px), the
   source lists are a per-counterparty fold over the hit stream, and both are
   asserted against what actually gets painted. */

describe("recorder panel budget", () => {
  it("fits every band inside the column's 292px bottom half", () => {
    // The hard budget: the column is 760 tall, the roster keeps 452, the
    // panel adds a 10px top gap and a 6px bottom inset.
    expect(recorderPanelHeight()).toBe(292);
    expect(
      EXPORT_LOGICAL - EXPORT_TEAM_H - EXPORT_RECORDER_TOP_GAP - EXPORT_RECORDER_BOTTOM_INSET,
    ).toBe(292);
    // The stack: headline block, ribbon band, source band, two 10px gaps.
    const bands = recorderPanelBands();
    expect(bands.ribbonsTop).toBe(EXPORT_RECORDER_BLOCK_H + EXPORT_RECORDER_BAND_GAP);
    expect(recorderRibbonBandHeight()).toBe(43);
    expect(recorderSourceBandHeight()).toBe(83);
    expect(bands.sourcesTop).toBe(181);
    expect(bands.stackH).toBe(264);
    expect(recorderPanelFits()).toBe(true);
    expect(bands.stackH).toBeLessThanOrEqual(recorderPanelHeight());
    // No band may overlap the one above it.
    expect(EXPORT_RECORDER_BLOCK_H).toBeLessThan(bands.ribbonsTop);
    expect(bands.ribbonsTop + recorderRibbonBandHeight()).toBeLessThan(bands.sourcesTop);
    expect(bands.sourcesTop + recorderSourceBandHeight()).toBe(bands.stackH);
    // The five-row clamp is a DISPLAY choice, not a space limit: a sixth
    // row would still fit (7 rows fit the band) - the ledger keeps every
    // counterparty either way (see foldRecorderSources).
    const rowFit = Math.floor(
      (recorderPanelHeight() - bands.sourcesTop - EXPORT_RECORDER_SOURCE_CAPTION_H) /
        EXPORT_RECORDER_SOURCE_ROW_H,
    );
    expect(rowFit).toBeGreaterThanOrEqual(6);
    expect(EXPORT_RECORDER_SOURCE_ROWS).toBe(5);
  });

  it("gives each source column 82px and holds the whole ribbon set in 8 cells", () => {
    const colW = recorderSourceColumnWidth();
    expect(colW).toBe(82);
    // Two columns + the one gap + both insets reconstruct the 190px column.
    expect(
      EXPORT_RECORDER_SOURCE_COLUMNS * colW +
        (EXPORT_RECORDER_SOURCE_COLUMNS - 1) * EXPORT_RECORDER_SOURCE_GAP +
        2 * EXPORT_RECORDER_INSET_X,
    ).toBe(EXPORT_SIDE_W);
    // Every authoritative ribbon kind the settlement parser exposes has a
    // cell: 4 columns x 2 rows = 8 >= RIBBON_SOURCES (7) - the strip is
    // complete, never cut.
    expect(RIBBON_SOURCES.length).toBeLessThanOrEqual(
      EXPORT_RECORDER_RIBBON_COLS * EXPORT_RECORDER_RIBBON_ROWS,
    );
  });
});

/* One ship trajectory: a single position sample (the impact spot) plus the
   HP step stream the attribution reads. */
function shipTraj(
  entityId: number,
  x: number,
  z: number,
  hp: Array<{ time: number; value: number }>,
): EntityTrajectory {
  return {
    entityId,
    kind: {
      entityType: 2,
      vehicleId: 0,
      initialX: x,
      initialY: 0,
      initialZ: z,
      creationTime: 0,
    },
    samples: [{ time: 0, entityId, vehicleId: 0, x, y: 0, z, yaw: 0 }],
    hpSamples: hp,
  };
}

/** One terminal impact (receiveShotKills) at (x, z). */
function shotAt(time: number, ownerId: number, x = 0, z = 0): ShotKillEvent {
  return { time, ownerId, hitType: 1, shotId: 1, x, y: 0, z };
}

describe("buildRecorderSourceHits", () => {
  const trajectories = [
    // The recorder (entity 1) and two targets inside the blast (2, 3), one
    // far outside it (4) and one attacker (5) shooting the recorder.
    shipTraj(1, 0, 0, [
      { time: 0, value: 40000 },
      { time: 120.2, value: 38000 },
    ]),
    shipTraj(2, 100, 0, [
      { time: 0, value: 20000 },
      { time: 100.2, value: 19500 },
    ]),
    shipTraj(3, -150, 50, [
      { time: 0, value: 30000 },
      { time: 100.3, value: 29000 },
    ]),
    shipTraj(4, 5000, 0, [
      { time: 0, value: 30000 },
      { time: 100.3, value: 1000 },
    ]),
    shipTraj(5, 0, 0, [{ time: 0, value: 30000 }]),
  ];

  it("credits the recorder's shells to the ships their splash damaged", () => {
    const hits = buildRecorderSourceHits({
      shotKills: [shotAt(100, 1)],
      trajectories,
      selfEntityId: 1,
    });
    const dealt = hits.filter((h) => h.kind === "dealt");
    expect(dealt).toHaveLength(2);
    expect(dealt.map((h) => h.counterpartyId).sort()).toEqual([2, 3]);
    expect(dealt.find((h) => h.counterpartyId === 2)!.amount).toBe(500);
    expect(dealt.find((h) => h.counterpartyId === 3)!.amount).toBe(1000);
    // The far ship lost HP at the same moment but was nowhere near the
    // impact - it must never be credited.
    expect(dealt.some((h) => h.counterpartyId === 4)).toBe(false);
  });

  it("credits incoming fire to its attacker, and stays recorder-scoped", () => {
    const hits = buildRecorderSourceHits({
      shotKills: [
        // Near the recorder: 40000 -> 38000 = 2000.
        shotAt(120, 5),
        // A duel between two other ships, far from the recorder: neither
        // list may pick it up (the panel is the RECORDER's).
        shotAt(130, 2, 3000, 3000),
        // A withheld attacker id (the game's 0 sentinel) is dropped rather
        // than shown under a fake row.
        shotAt(121, 0),
      ],
      trajectories,
      selfEntityId: 1,
    });
    const taken = hits.filter((h) => h.kind === "taken");
    expect(taken).toHaveLength(1);
    expect(taken[0].counterpartyId).toBe(5);
    expect(taken[0].amount).toBe(2000);
    expect(taken[0].time).toBe(120);
    // No dealt row: the recorder fired nothing in this fixture.
    expect(hits.filter((h) => h.kind === "dealt")).toHaveLength(0);
  });

  it("splits a drop across a salvo's shells instead of multiplying it", () => {
    const hits = buildRecorderSourceHits({
      shotKills: [shotAt(100, 1), shotAt(100, 1), shotAt(100, 1)],
      trajectories,
      selfEntityId: 1,
    });
    // Three covering shells split each victim's drop three ways: the total
    // equals the real HP loss (no multiplication), no row exceeds its drop.
    const dealt = hits.filter((h) => h.kind === "dealt");
    expect(hits.reduce((a, h) => a + h.amount, 0)).toBeCloseTo(1500, 6);
    for (const h of dealt) {
      expect(h.amount).toBeLessThanOrEqual(h.counterpartyId === 3 ? 1000 : 500);
    }
  });

  it("excludes ally hulls from dealt while their shells still dilute", () => {
    // Entity 2 is a teammate: its hull is not a 造成伤害 row, but its
    // presence in the splash still halves the recorder's claim on entity 3.
    const hits = buildRecorderSourceHits({
      shotKills: [shotAt(100, 1)],
      trajectories,
      selfEntityId: 1,
      allyIds: [2],
    });
    const dealt = hits.filter((h) => h.kind === "dealt");
    expect(dealt.map((h) => h.counterpartyId)).toEqual([3]);
    expect(dealt[0].amount).toBeCloseTo(1000, 6);
  });

  it("orders the ledger by battle time", () => {
    const hits = buildRecorderSourceHits({
      shotKills: [shotAt(120, 5), shotAt(100, 1)],
      trajectories,
      selfEntityId: 1,
    });
    const times = hits.map((h) => h.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("foldRecorderSources", () => {
  const names = new Map<number, string>([
    [7, "Alpha"],
    [8, "Bravo"],
  ]);
  const nameOf = (id: number): string | null => names.get(id) ?? null;
  const hits: RecorderSourceHit[] = [
    { time: 10, counterpartyId: 7, amount: 1200, kind: "dealt" },
    { time: 20, counterpartyId: 8, amount: 4000, kind: "dealt" },
    { time: 30, counterpartyId: 7, amount: 900, kind: "dealt" },
    { time: 40, counterpartyId: 9, amount: 500, kind: "taken" },
  ];

  it("sums each counterparty and sorts descending", () => {
    const rows = foldRecorderSources(hits, 25, "dealt", nameOf);
    expect(rows).toEqual([
      { label: "Bravo", amount: 4000 },
      { label: "Alpha", amount: 1200 },
    ]);
  });

  it("folds cumulatively up to the playhead and keeps kinds apart", () => {
    const rows = foldRecorderSources(hits, 35, "dealt", nameOf);
    expect(rows).toEqual([
      { label: "Bravo", amount: 4000 },
      { label: "Alpha", amount: 2100 },
    ]);
    const taken = foldRecorderSources(hits, 100, "taken", nameOf);
    expect(taken).toEqual([{ label: "#9", amount: 500 }]);
    // Nothing happened yet at t = 5.
    expect(foldRecorderSources(hits, 5, "dealt", nameOf)).toEqual([]);
  });

  it("clamps to the top five for display without losing the rest", () => {
    const many: RecorderSourceHit[] = Array.from({ length: 7 }, (_, i) => ({
      time: 1,
      counterpartyId: 100 + i,
      amount: 100 * (i + 1),
      kind: "dealt" as const,
    }));
    const shown = foldRecorderSources(many, 10, "dealt", nameOf);
    expect(shown).toHaveLength(EXPORT_RECORDER_SOURCE_ROWS);
    // Descending, and the five biggest survived the clamp.
    expect(shown.map((r) => r.amount)).toEqual([700, 600, 500, 400, 300]);
    expect(shown.map((r) => r.label)).toEqual([
      "#106",
      "#105",
      "#104",
      "#103",
      "#102",
    ]);
    // The clamp is display-only: a wider cap returns every counterparty.
    expect(foldRecorderSources(many, 10, "dealt", nameOf, Infinity)).toHaveLength(7);
  });

  it("resolves names through the roster join, unknown ids to #id", () => {
    expect(recorderSourceLabel(7, nameOf)).toBe("Alpha");
    expect(recorderSourceLabel(42, nameOf)).toBe("#42");
    // A whitespace-only roster name is no name.
    expect(recorderSourceLabel(43, () => "  ")).toBe("#43");
  });
});

describe("drawRecorderPanel", () => {
  const stats = (
    over: Partial<PlaybackRecorderStats> = {},
  ): PlaybackRecorderStats => ({
    damage: 123456,
    frags: 3,
    taken: 98765,
    ribbons: [
      { key: "frag", value: 3 },
      { key: "main_caliber", value: 241 },
      { key: "torpedo", value: 12 },
    ],
    dealTargets: [
      { label: "Alpha", amount: 42000 },
      { label: "Bravo", amount: 9000 },
    ],
    takeSources: [{ label: "#42", amount: 7000 }],
    ...over,
  });
  const fakeIcon = { src: "ribbon.webp" } as unknown as HTMLImageElement;

  it("paints the headline, the ribbon strip and both source columns", () => {
    const { ctx, texts, images } = recordingContext();
    const h = recorderPanelHeight();
    drawRecorderPanel(
      ctx, 0, 0, EXPORT_SIDE_W, h, stats(), darkPalette(), LABELS,
      () => fakeIcon,
    );
    // The existing headline block survives untouched.
    expect(texts.some((t) => t.text === LABELS.damage)).toBe(true);
    expect(texts.some((t) => t.text === "123,456")).toBe(true);
    expect(texts.some((t) => t.text === "3")).toBe(true);
    expect(texts.some((t) => t.text === "98,765")).toBe(true);
    // The two added bands' captions.
    expect(texts.some((t) => t.text === LABELS.ribbonsTitle)).toBe(true);
    expect(texts.some((t) => t.text === LABELS.dmgDealtSources)).toBe(true);
    expect(texts.some((t) => t.text === LABELS.dmgTakenSources)).toBe(true);
    // Every ribbon's count paints, and one icon lands per kind.
    expect(texts.some((t) => t.text === "241")).toBe(true);
    expect(texts.some((t) => t.text === "12")).toBe(true);
    expect(images).toHaveLength(3);
    expect(images[0].src).toBe("ribbon.webp");
    // Source rows: name at the left inset, value right-aligned on the
    // column's right edge (two columns, 82px each).
    const alpha = texts.find((t) => t.text === "Alpha")!;
    const alphaValue = texts.find((t) => t.text === "42,000")!;
    expect(alpha.align).toBe("left");
    expect(alpha.x).toBe(EXPORT_RECORDER_INSET_X);
    expect(alphaValue.align).toBe("right");
    expect(alphaValue.x).toBe(EXPORT_RECORDER_INSET_X + recorderSourceColumnWidth());
    // The right-hand column starts one gap later.
    const taken = texts.find((t) => t.text === LABELS.dmgTakenSources)!;
    expect(taken.x).toBe(
      EXPORT_RECORDER_INSET_X + recorderSourceColumnWidth() + EXPORT_RECORDER_SOURCE_GAP,
    );
    // The unknown counterparty keeps its hash fallback.
    expect(texts.some((t) => t.text === "#42")).toBe(true);
    // Nothing may paint past the panel's bottom edge.
    const lowestText = Math.max(...texts.map((t) => t.y));
    const lowestImage = Math.max(...images.map((i) => i.y + i.h));
    expect(Math.max(lowestText, lowestImage)).toBeLessThanOrEqual(h);
    // The source rows sit BELOW the ribbon strip, which sits below the
    // headline (the band order the budget guarantees).
    const bands = recorderPanelBands();
    expect(alpha.y).toBeGreaterThan(bands.sourcesTop);
    expect(texts.find((t) => t.text === LABELS.ribbonsTitle)!.y).toBeGreaterThan(
      EXPORT_RECORDER_BLOCK_H,
    );
  });

  it("caps each source column at five rows", () => {
    const { ctx, texts } = recordingContext();
    const many = Array.from({ length: 7 }, (_, i) => ({
      label: "Target" + i,
      amount: 1000 * (i + 1),
    }));
    drawRecorderPanel(
      ctx, 0, 0, EXPORT_SIDE_W, recorderPanelHeight(),
      stats({ dealTargets: many, takeSources: many }), darkPalette(), LABELS,
      () => fakeIcon,
    );
    // The 5th (index 4) paints; the 6th and 7th never do.
    expect(texts.some((t) => t.text === "Target4")).toBe(true);
    expect(texts.some((t) => t.text === "Target5")).toBe(false);
    expect(texts.some((t) => t.text === "Target6")).toBe(false);
  });

  it("keeps a count and a dim dash when the art or the data is missing", () => {
    const empty = recordingContext();
    drawRecorderPanel(
      empty.ctx, 0, 0, EXPORT_SIDE_W, recorderPanelHeight(),
      stats({ ribbons: [], dealTargets: [], takeSources: [] }), darkPalette(),
      LABELS, () => null,
    );
    // No ribbon cells (the strip keeps its own dash) and both empty
    // columns keep theirs - the three bands never float caption-only.
    expect(empty.texts.filter((t) => t.text === "\u2014")).toHaveLength(3);
    expect(empty.images).toHaveLength(0);
    expect(empty.texts.some((t) => t.text === LABELS.ribbonsTitle)).toBe(true);
    // A missing icon still paints the cell's count.
    const noArt = recordingContext();
    drawRecorderPanel(
      noArt.ctx, 0, 0, EXPORT_SIDE_W, recorderPanelHeight(),
      stats(), darkPalette(), LABELS, () => null,
    );
    expect(noArt.images).toHaveLength(0);
    expect(noArt.texts.some((t) => t.text === "241")).toBe(true);
  });
});

