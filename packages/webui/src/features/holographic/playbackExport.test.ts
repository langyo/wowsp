/** Pure-logic tests for the replay-playback export: layout math, the GIF
 *  delay grid, settings clamping and the settings-driven estimate inputs
 *  (no DOM / encoders here — the painters are exercised by the shotKit and
 *  exporter suites they reuse). */
import { describe, expect, it } from "vitest";

import {
  EXPORT_HEADER_H,
  EXPORT_LOGICAL,
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
  it("stacks header + map + footer and keeps everything even", () => {
    const l = playbackExportLayout(1080, true);
    expect(l.width).toBe(1080);
    expect(l.width % 2).toBe(0);
    expect(l.height % 2).toBe(0);
    // Band heights follow the shared logical space exactly.
    expect(l.mapTop).toBeCloseTo(EXPORT_HEADER_H * (1080 / EXPORT_LOGICAL), 6);
    expect(l.footerHeight).toBeCloseTo(FOOT_H * (1080 / EXPORT_LOGICAL), 6);
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
    const s = clampExportSettings({ format: "video", from: "now", fps: 60, speed: 2, size: 720, footer: false });
    expect(s).toEqual({ format: "video", from: "now", fps: 60, speed: 2, size: 720, footer: false });
  });

  it("re-bases fps, speed and size when the format flips", () => {
    const s = clampExportSettings({ format: "gif", from: "start", fps: 60, speed: 3, size: 1080, footer: true });
    expect(s.format).toBe("gif");
    expect(PLAYBACK_EXPORT_FPS.gif).toContain(s.fps);
    expect(PLAYBACK_EXPORT_SIZES.gif).toContain(s.size);
    expect([1, 2, 5, 10, 20]).toContain(s.speed);
  });
});
