/** Offline-export frame schedule tests (pure — no DOM / WebCodecs here). */
import { describe, expect, it } from "vitest";
import { DEFAULT_CODEC_LADDER, frameTimes, joinExportPath } from "./exporters";

describe("frameTimes", () => {
  it("steps at 1/fps from `from` through `to` inclusive", () => {
    const t = frameTimes(0, 1, 10);
    expect(t).toHaveLength(11);
    expect(t[0]).toBe(0);
    expect(t[10]).toBeCloseTo(1, 6);
    for (let i = 1; i < t.length; i++) {
      expect(t[i]).toBeGreaterThan(t[i - 1]);
      expect(t[i] - t[i - 1]).toBeCloseTo(0.1, 9);
    }
  });

  it("is strictly increasing even with float-hostile ranges", () => {
    const t = frameTimes(3.7, 10.3, 30);
    for (let i = 1; i < t.length; i++) {
      expect(t[i]).toBeGreaterThan(t[i - 1]);
    }
    expect(t[t.length - 1]).toBeLessThanOrEqual(10.3 + 1e-9);
  });

  it("never passes `to`", () => {
    const t = frameTimes(2, 2.05, 30); // 2 frames only: 2.00 and 2.0333
    expect(t).toHaveLength(2);
    expect(t[1]).toBeLessThanOrEqual(2.05);
  });

  it("degenerates to a single frame when the range is empty or invalid", () => {
    expect(frameTimes(5, 5, 30)).toEqual([5]);
    expect(frameTimes(5, 4.9, 30)).toEqual([5]);
    expect(frameTimes(Number.NaN, 4, 30)).toEqual([]);
    expect(frameTimes(0, 1, 0)).toEqual([0]);
  });
});

describe("DEFAULT_CODEC_LADDER", () => {
  it("keeps the board's MP4-first contract (avc to MP4, vp9 to WebM)", () => {
    expect(DEFAULT_CODEC_LADDER).toEqual([
      { codec: "avc", ext: "mp4" },
      { codec: "vp9", ext: "webm" },
    ]);
  });

  it("pairs every rung with a container that accepts the codec", () => {
    // WebM holds vp8/vp9/av1 only; MP4 holds everything we emit. A future
    // rung like {avc, webm} must fail here, not in the muxer at runtime.
    const webmOk = new Set(["vp8", "vp9", "av1"]);
    for (const rung of DEFAULT_CODEC_LADDER) {
      if (rung.ext === "webm") expect(webmOk.has(rung.codec)).toBe(true);
    }
  });
});

describe("joinExportPath", () => {
  it("keeps the directory's own separator and collapses trailing ones", () => {
    expect(joinExportPath("C:\\Users\\me\\Downloads", "clip.mp4")).toBe(
      "C:\\Users\\me\\Downloads\\clip.mp4",
    );
    expect(joinExportPath("C:\\Users\\me\\Downloads\\", "clip.mp4")).toBe(
      "C:\\Users\\me\\Downloads\\clip.mp4",
    );
    expect(joinExportPath("/home/me/Downloads", "clip.mp4")).toBe(
      "/home/me/Downloads/clip.mp4",
    );
    expect(joinExportPath("/home/me/Downloads///", "clip.mp4")).toBe(
      "/home/me/Downloads/clip.mp4",
    );
  });

  it("refuses an empty directory", () => {
    expect(joinExportPath("", "clip.mp4")).toBeNull();
    expect(joinExportPath("   ", "clip.mp4")).toBeNull();
    expect(joinExportPath("\\\\", "clip.mp4")).toBeNull();
  });
});
