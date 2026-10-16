import { describe, expect, it } from "vitest";
import {
  averageRectLuma,
  OSD_DARK_INK_ABOVE,
  OSD_LIGHT_INK_BELOW,
  toneForLuma,
} from "./osdContrast";

/** Fill an RGBA readback buffer (bottom-up rows) with a constant color. */
function fillBuf(
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
): Uint8Array {
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

describe("toneForLuma", () => {
  it("keeps the historical white ink on a dark backdrop", () => {
    expect(toneForLuma(undefined, 0.01)).toBe("light");
    expect(toneForLuma("light", 0.05)).toBe("light");
  });

  it("flips to dark ink when the backdrop is bright", () => {
    expect(toneForLuma(undefined, 0.9)).toBe("dark");
    expect(toneForLuma("light", 0.9)).toBe("dark");
  });

  it("hysteresis: dark ink survives the band, light ink needs real dark", () => {
    // Between the thresholds a dark-ink label stays dark…
    const mid = (OSD_DARK_INK_ABOVE + OSD_LIGHT_INK_BELOW) / 2;
    expect(toneForLuma("dark", mid)).toBe("dark");
    // …and a light-ink label stays light until the backdrop is clearly
    // bright again.
    expect(toneForLuma("light", mid)).toBe("light");
    expect(toneForLuma("dark", OSD_LIGHT_INK_BELOW - 0.01)).toBe("light");
    expect(toneForLuma("dark", OSD_DARK_INK_ABOVE)).toBe("dark");
  });

  it("unknown backdrop keeps the current tone", () => {
    expect(toneForLuma(undefined, -1)).toBe("light");
    expect(toneForLuma("dark", -1)).toBe("dark");
  });

  it("thresholds leave a non-empty hysteresis band", () => {
    expect(OSD_LIGHT_INK_BELOW).toBeLessThan(OSD_DARK_INK_ABOVE);
  });
});

describe("averageRectLuma", () => {
  it("averages the rect it is given (dark navy scene)", () => {
    // 0x0b1220-ish dark sea across a 100×100 canvas with a 50×50 readback.
    const buf = fillBuf(50, 50, 4, 8, 14);
    const luma = averageRectLuma(buf, 50, 50, 100, 100, 10, 10, 40, 30);
    const expectLuma = (0.2126 * 4 + 0.7152 * 8 + 0.0722 * 14) / 255;
    expect(luma).toBeCloseTo(expectLuma, 5);
  });

  it("reads the correct rows from a bottom-up buffer (two-tone canvas)", () => {
    // Top half of the CANVAS is white, bottom half black. Readback rows
    // are bottom-up, so buffer rows 0..24 are the canvas's BOTTOM (black)
    // and rows 25..49 the canvas's TOP (white).
    const w = 50;
    const h = 50;
    const buf = fillBuf(w, h, 0, 0, 0);
    for (let by = 25; by < h; by++) {
      for (let bx = 0; bx < w; bx++) {
        const o = (by * w + bx) * 4;
        buf[o] = 255;
        buf[o + 1] = 255;
        buf[o + 2] = 255;
      }
    }
    // A rect over the canvas's top half must read bright.
    const top = averageRectLuma(buf, w, h, 100, 100, 0, 0, 100, 50);
    // A rect over the canvas's bottom half must read dark.
    const bottom = averageRectLuma(buf, w, h, 100, 100, 0, 50, 100, 50);
    expect(top).toBeGreaterThan(0.9);
    expect(bottom).toBeLessThan(0.1);
  });

  it("clamps to the canvas and reports unknown for off-screen rects", () => {
    const buf = fillBuf(10, 10, 255, 255, 255);
    // Partially off-screen: clamps to the on-canvas part and still reads.
    expect(averageRectLuma(buf, 10, 10, 100, 100, -20, -20, 40, 40)).toBeGreaterThan(0.9);
    // Entirely off-screen: unknown.
    expect(averageRectLuma(buf, 10, 10, 100, 100, 200, 200, 40, 40)).toBe(-1);
    expect(averageRectLuma(new Uint8Array(0), 10, 10, 100, 100, 0, 0, 10, 10)).toBe(-1);
  });
});
