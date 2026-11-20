/** Pure-logic tests for the replay-playback export: layout math, the GIF
 *  delay grid, settings clamping and the settings-driven estimate inputs
 *  (no DOM / encoders here — the painters are exercised by the shotKit and
 *  exporter suites they reuse). */
import { describe, expect, it } from "vitest";

import {
  GIF_MAX_FRAMES,
  clampRangeToBudget,
  exportMaxSpan,
  normalizeExportRange,
  EXPORT_HEADER_H,
  PLAYBACK_CODEC_LADDER,
  EXPORT_LOGICAL,
  EXPORT_SIDE_W,
  EXPORT_TOTAL_LOGICAL,
  PLAYBACK_EXPORT_FPS,
  PLAYBACK_EXPORT_SIZES,
  clampExportSettings,
  frameTimesAtSpeed,
  gifDelayMs,
  playbackExportLayout,
} from "./playbackExport";
import { FOOT_H } from "@/features/share/shotKit";
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
    const s = clampExportSettings({ format: "video", from: 0, to: 60, fps: 60, speed: 2, size: 1080, footer: false });
    expect(s).toEqual({ format: "video", from: 0, to: 60, fps: 60, speed: 2, size: 1080, footer: false });
  });

  it("re-bases fps, speed and size when the format flips", () => {
    const s = clampExportSettings({ format: "gif", from: 0, to: 60, fps: 60, speed: 3, size: 1080, footer: true });
    // (1080 is off the GIF width ladder → falls to the ladder's smallest.)
    expect(s.format).toBe("gif");
    expect(PLAYBACK_EXPORT_FPS.gif).toContain(s.fps);
    expect(PLAYBACK_EXPORT_SIZES.gif).toContain(s.size);
    expect([1, 2, 5, 10, 20]).toContain(s.speed);
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
