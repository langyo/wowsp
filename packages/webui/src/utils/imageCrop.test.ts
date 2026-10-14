/** Square-crop math invariants (utils/imageCrop.ts) — the crop dialog's
 *  geometry contract: the viewport always selects a square source region,
 *  pan offsets can never expose an edge, and "whole square image" is
 *  detected exactly (it gates the original-bytes passthrough). */
import { describe, expect, it } from "vitest";

import {
  clampOffset,
  coverScale,
  isFullImageRect,
  maxScale,
  viewportSourceRect,
  zoomOffsets,
} from "./imageCrop";

describe("coverScale", () => {
  it("is set by the shorter side (no empty bars inside the crop)", () => {
    // 800x400 in a 200px square: scaling by the longer side (0.25) would
    // leave vertical bars — the shorter side must fill the viewport.
    expect(coverScale(800, 400, 200)).toBe(200 / 400);
    expect(coverScale(400, 800, 200)).toBe(200 / 400);
    expect(coverScale(300, 300, 300)).toBe(1);
  });
});

describe("maxScale", () => {
  it("allows zooming until the crop is minCrop source pixels", () => {
    // 288px viewport over a 2000px side: cover is 0.144, cropping a
    // 100px square needs 2.88 CSS px per source px.
    expect(maxScale(2000, 2000, 288, 100)).toBe(288 / 100);
  });

  it("collapses to cover-fit for a small square (no upscaled zoom)", () => {
    expect(maxScale(100, 100, 288, 100)).toBe(coverScale(100, 100, 288));
  });
});

describe("clampOffset", () => {
  it("keeps the viewport inside the scaled image", () => {
    expect(clampOffset(500, 600, 288)).toBe((600 - 288) / 2);
    expect(clampOffset(-500, 600, 288)).toBe(-(600 - 288) / 2);
    expect(clampOffset(10, 600, 288)).toBe(10);
  });

  it("pins an exactly-fitting axis to zero", () => {
    expect(clampOffset(42, 288, 288)).toBe(0);
  });
});

describe("viewportSourceRect", () => {
  it("selects the centered square at cover-fit on a landscape image", () => {
    // 800x400 in a 200px viewport: cover crops the height fully and takes
    // the middle 400x400 of the width.
    const rect = viewportSourceRect(800, 400, 200, coverScale(800, 400, 200), 0, 0);
    expect(rect.size).toBeCloseTo(400, 6);
    expect(rect.x).toBeCloseTo(200, 6);
    expect(rect.y).toBeCloseTo(0, 6);
  });

  it("follows the pan offset in the opposite direction", () => {
    // Dragging the image right (tx > 0) moves the crop window left.
    const rect = viewportSourceRect(800, 800, 200, 1, 100, 0);
    expect(rect.x).toBeCloseTo(200, 6);
  });

  it("always yields a square inside the image, clamped at the edges", () => {
    // Overshoot offsets (a stale drag) must not push the rect outside.
    const rect = viewportSourceRect(500, 900, 250, 0.5, 99999, -99999);
    expect(rect.size).toBeCloseTo(500, 6);
    expect(rect.x).toBeLessThanOrEqual(500 - rect.size + 1e-6);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeLessThanOrEqual(900 - rect.size + 1e-6);
  });
});

describe("isFullImageRect", () => {
  it("accepts the whole square image", () => {
    const vp = 288;
    const scale = coverScale(400, 400, vp);
    const rect = viewportSourceRect(400, 400, vp, scale, 0, 0);
    expect(isFullImageRect(rect, 400, 400)).toBe(true);
  });

  it("rejects non-square sources and partial crops", () => {
    const landscape = viewportSourceRect(800, 400, 200, coverScale(800, 400, 200), 0, 0);
    expect(isFullImageRect(landscape, 800, 400)).toBe(false);
    const zoomed = viewportSourceRect(400, 400, 288, 288 / 100, 0, 0);
    expect(isFullImageRect(zoomed, 400, 400)).toBe(false);
  });
});

describe("zoomOffsets", () => {
  it("scales offsets around the viewport center", () => {
    expect(zoomOffsets(30, -20, 2)).toEqual({ tx: 60, ty: -40 });
  });
});
