/** Regression tests for the GIF export's take-wide palette.
 *
 *  The bug class: the export used to quantize EVERY frame on its own and hand
 *  each frame its palette, so gifenc wrote a LOCAL colour table per frame
 *  (the first frame's palette became the global one and every later frame
 *  overrode it). A static antialiased background — the sea/terrain gradient —
 *  then landed on a slightly different palette entry on every frame, which
 *  plays back as the reported 「五颜六色」 shimmer.
 *
 *  These tests drive the SAME writer + palette helpers the export loop calls,
 *  DECODE the produced GIF back (block parser + LZW, below) and assert:
 *    - exactly one colour table (the global one), never a per-frame local one;
 *    - several static background pixels keep ONE index and ONE RGB across the
 *      whole take;
 *    - the control — the old per-frame encoding — HAS local tables and DOES
 *      drift at those probes, so the assertion can fail loudly if the bug
 *      returns.
 */
import { describe, expect, it } from "vitest";
import { GIFEncoder, applyPalette, quantize } from "gifenc";

import {
  GIF_PALETTE_MAX_COLORS,
  GIF_PALETTE_SAMPLE_FRAMES,
  GIF_PALETTE_SAMPLE_PIXELS,
  createGifTakeWriter,
  gifPaletteSampleFrame,
  gifPaletteSampleIndices,
  gifTakePalette,
} from "./playbackExport";

/* ── Synthetic take ──────────────────────────────────────────────────────
 * 192x128 keeps the decode fast while leaving room for the three things that
 * matter: a STATIC gradient with many near-identical greens (the flicker
 * surface), a STATIC soft-edged coast line (antialiased edges), static HUD
 * inks, and ONE moving dot whose position changes every frame — the
 * histogram perturbation that made the per-frame palettes drift. */
const W = 192;
const H = 128;
const FRAME_COUNT = 10;

function syntheticFrame(index: number, frameCount: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  const movingX = 20 + Math.round((index / Math.max(1, frameCount - 1)) * (W - 64));
  const movingY = 98;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const at = (y * W + x) * 4;
      // Static sea gradient: two close ramps plus a gentle wave.
      let r = 12 + Math.round((x / (W - 1)) * 10) + Math.round((y / (H - 1)) * 6);
      let g = 40 + Math.round((y / (H - 1)) * 26) + Math.round(Math.sin(x * 0.05) * 4);
      let b = 34 + Math.round((x / (W - 1)) * 12) + Math.round((y / (H - 1)) * 8);
      // Static antialiased coast line (an 8px softstep blend into sand).
      const edge = Math.abs(y - (40 + 0.35 * x));
      if (edge < 8) {
        const a = Math.max(0, Math.min(1, 1 - edge / 8));
        r = Math.round(r * (1 - a) + 148 * a);
        g = Math.round(g * (1 - a) + 138 * a);
        b = Math.round(b * (1 - a) + 104 * a);
      }
      // Static HUD inks: a pale band and a red HP bar.
      if (y >= 6 && y < 14 && x > 10 && x < W - 10) {
        r = 226; g = 232; b = 228;
      }
      if (y >= 18 && y < 22 && x > 10 && x < 80) {
        r = 196; g = 48; b = 44;
      }
      // The moving element: the only per-frame difference, and big enough
      // (~2% of the frame) to genuinely re-roll a per-frame quantizer.
      const dx = x - movingX;
      const dy = y - movingY;
      if (dx >= 0 && dx < 24 && dy >= 0 && dy < 24) {
        r = 250; g = 150; b = 40;
      }
      px[at] = r;
      px[at + 1] = g;
      px[at + 2] = b;
      px[at + 3] = 255;
    }
  }
  return px;
}

const frames = Array.from({ length: FRAME_COUNT }, (_, i) =>
  syntheticFrame(i, FRAME_COUNT),
);

/** Static background probes: on the gradient, on the coast's antialiased
 *  band, and clear of the HUD bands and of the moving dot's path — so every
 *  one of them must be IDENTICAL in every frame of a stable take. */
const SAMPLE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [4, 60],
  [30, 30],
  [60, 72],
  [100, 44],
  [120, 60],
  [170, 60],
  [20, 34],
  [180, 84],
];

/** The palette the export itself would build: it samples the take through
 *  gifPaletteSampleIndices, not every frame. */
const ENCODE_PALETTE = gifTakePalette(
  gifPaletteSampleIndices(FRAME_COUNT).map((i) => frames[i]),
);

function encodeTake(): Uint8Array {
  const writer = createGifTakeWriter(W, H, 100, ENCODE_PALETTE);
  for (const f of frames) writer.writeFrame(f);
  return writer.finish();
}

/** The PRE-FIX encoding, kept as the failing control: quantize each frame
 *  independently and pass every frame its palette (a local colour table). */
function encodePerFrameTake(): Uint8Array {
  const gif = GIFEncoder();
  for (const f of frames) {
    const palette = quantize(f, GIF_PALETTE_MAX_COLORS, { format: "rgb565" });
    gif.writeFrame(applyPalette(f, palette, "rgb565"), W, H, {
      palette,
      delay: 100,
    });
  }
  gif.finish();
  return new Uint8Array(gif.bytes());
}

/* ── Decode-back (GIF block parser + LZW, test-only) ─────────────────────
 *  Nothing in the app reads GIFs, so the regression harness carries its own
 *  minimal reader: it exposes the global table, each frame's own table (if
 *  any) and the decoded palette INDICES, which is exactly what the flicker
 *  assertion needs. */
interface DecodedFrame {
  width: number;
  height: number;
  /** True when the frame carried a local colour table (the bug's shape). */
  hasLocalPalette: boolean;
  localPalette: number[][] | null;
  indices: number[];
}

interface DecodedGif {
  width: number;
  height: number;
  globalPalette: number[][] | null;
  frames: DecodedFrame[];
}

function u16(b: Uint8Array, p: number): number {
  return b[p] | (b[p + 1] << 8);
}

function readColorTable(b: Uint8Array, p: number, size: number): number[][] {
  const table: number[][] = [];
  for (let i = 0; i < size; i++) {
    table.push([b[p + i * 3], b[p + i * 3 + 1], b[p + i * 3 + 2]]);
  }
  return table;
}

/** GIF's variable-width LZW stream (LSB-first codes, a dictionary that grows
 *  by one entry per code, width stepping up as the dictionary fills). */
function lzwDecode(
  minCodeSize: number,
  data: Uint8Array,
  pixelCount: number,
): number[] {
  const out: number[] = [];
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = (): void => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = [];
    codeSize = minCodeSize + 1;
  };
  reset();
  let bitPos = 0;
  let prev: number[] | null = null;
  while (out.length < pixelCount) {
    if (bitPos + codeSize > data.length * 8) break;
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = data[(bitPos + i) >> 3];
      code |= ((byte >> ((bitPos + i) & 7)) & 1) << i;
    }
    bitPos += codeSize;
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length && dict[code] !== undefined) entry = dict[code];
    else if (prev) entry = prev.concat([prev[0]]);
    else break;
    for (const value of entry) out.push(value);
    if (prev) {
      dict.push(prev.concat([entry[0]]));
      if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return out;
}

function decodeGif(b: Uint8Array): DecodedGif {
  const signature = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
  if (signature !== "GIF89a" && signature !== "GIF87a") {
    throw new Error("not a GIF: " + signature);
  }
  let p = 6;
  const width = u16(b, p);
  const height = u16(b, p + 2);
  const packed = b[p + 4];
  p += 7;
  let globalPalette: number[][] | null = null;
  if (packed & 0x80) {
    const size = 1 << ((packed & 0x7) + 1);
    globalPalette = readColorTable(b, p, size);
    p += size * 3;
  }
  const framesOut: DecodedFrame[] = [];
  for (;;) {
    const marker = b[p++];
    if (marker === undefined) throw new Error("truncated GIF");
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      p++; // extension label
      for (;;) {
        const size = b[p++];
        if (!size) break;
        p += size;
      }
      continue;
    }
    if (marker !== 0x2c) throw new Error("unexpected block 0x" + marker.toString(16));
    const w = u16(b, p + 4);
    const h = u16(b, p + 6);
    const ipacked = b[p + 8];
    p += 9;
    if (ipacked & 0x40) throw new Error("interlaced frame unsupported");
    let localPalette: number[][] | null = null;
    if (ipacked & 0x80) {
      const size = 1 << ((ipacked & 0x7) + 1);
      localPalette = readColorTable(b, p, size);
      p += size * 3;
    }
    const minCodeSize = b[p++];
    const chunks: number[] = [];
    for (;;) {
      const size = b[p++];
      if (!size) break;
      for (let i = 0; i < size; i++) chunks.push(b[p + i]);
      p += size;
    }
    const indices = lzwDecode(minCodeSize, Uint8Array.from(chunks), w * h);
    if (indices.length !== w * h) {
      throw new Error("short LZW stream: " + indices.length + " of " + w * h);
    }
    framesOut.push({
      width: w,
      height: h,
      hasLocalPalette: localPalette !== null,
      localPalette,
      indices,
    });
  }
  return { width, height, globalPalette, frames: framesOut };
}

/** The RGB a frame paints at (x, y), resolved through the frame's own table
 *  if it has one (the pre-fix behaviour) or the global one. */
function decodedRgb(decoded: DecodedGif, frame: DecodedFrame, x: number, y: number): string {
  const table = frame.localPalette ?? decoded.globalPalette;
  if (!table) throw new Error("GIF has no colour table");
  const color = table[frame.indices[y * decoded.width + x]];
  if (!color) throw new Error("index outside the colour table");
  return color.join(",");
}

/** Everything the stable-palette contract forbids, as readable violations
 *  (empty = stable). The export assertion and the failing control read the
 *  SAME list, so a regression cannot slip through on a technicality. */
function gifStabilityViolations(decoded: DecodedGif): string[] {
  const violations: string[] = [];
  if (!decoded.globalPalette) violations.push("no global colour table");
  decoded.frames.forEach((frame, i) => {
    if (frame.hasLocalPalette) {
      violations.push("frame " + i + " carries a local colour table");
    }
  });
  for (const [x, y] of SAMPLE_POINTS) {
    let rgbs: string[];
    try {
      rgbs = decoded.frames.map((f) => decodedRgb(decoded, f, x, y));
    } catch (err) {
      violations.push("background (" + x + "," + y + "): " + String(err));
      continue;
    }
    if (new Set(rgbs).size > 1) {
      violations.push(
        "background (" + x + "," + y + ") drifts: " + rgbs.join(" / "),
      );
    }
  }
  return violations;
}

describe("GIF take-wide palette (the playback export's flicker fix)", () => {
  it("writes ONE global colour table and no per-frame local tables", () => {
    const decoded = decodeGif(encodeTake());
    expect(decoded.frames).toHaveLength(FRAME_COUNT);
    expect(decoded.globalPalette).not.toBeNull();
    const palette = decoded.globalPalette!;
    expect(palette.length).toBeGreaterThan(1);
    expect(palette.length).toBeLessThanOrEqual(GIF_PALETTE_MAX_COLORS);
    // The flicker's structural cause: every frame after the first carried a
    // local table. It must stay gone.
    expect(decoded.frames.map((f) => f.hasLocalPalette)).toEqual(
      Array.from({ length: FRAME_COUNT }, () => false),
    );
    // The decode is lossless: each frame's indices are exactly the ones the
    // writer handed the encoder, so the RGB probes later read real pixels.
    for (let i = 0; i < FRAME_COUNT; i++) {
      expect(decoded.frames[i].indices).toEqual(
        Array.from(applyPalette(frames[i], ENCODE_PALETTE, "rgb565")),
      );
    }
  });

  it("keeps every static background pixel on ONE RGB across the take", () => {
    const decoded = decodeGif(encodeTake());
    // One quantized RGB per probe for the whole take. If the per-frame
    // palettes ever come back this list becomes non-empty and the test
    // names the exact pixel that shimmers.
    expect(gifStabilityViolations(decoded)).toEqual([]);
    for (const [x, y] of SAMPLE_POINTS) {
      const rgb = decodedRgb(decoded, decoded.frames[0], x, y);
      // ... and it is the source's own colour (a stable but wrong palette
      // would be just as broken): within one rgb565 bin step.
      const at = (y * W + x) * 4;
      const source = [frames[0][at], frames[0][at + 1], frames[0][at + 2]];
      const got = rgb.split(",").map(Number);
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(got[c] - source[c])).toBeLessThanOrEqual(24);
      }
    }
  });

  it("proves the harness fails on the old per-frame palettes", () => {
    const violations = gifStabilityViolations(decodeGif(encodePerFrameTake()));
    // The control has a local table on every frame after the first ...
    expect(violations.some((v) => v.includes("local colour table"))).toBe(true);
    // ... and its background probes genuinely drift, so the RGB half of the
    // assertion is not vacuous either.
    expect(violations.some((v) => v.includes("drifts"))).toBe(true);
  });
});

describe("gifPaletteSampleIndices", () => {
  it("always samples the first and last frame, in order, within the cap", () => {
    for (const n of [1, 2, 7, 10, 40, 300, 1500]) {
      const idx = gifPaletteSampleIndices(n);
      expect(idx[0]).toBe(0);
      expect(idx[idx.length - 1]).toBe(n - 1);
      expect(idx.length).toBeLessThanOrEqual(GIF_PALETTE_SAMPLE_FRAMES);
      expect(idx.every((v, i) => i === 0 || v > idx[i - 1])).toBe(true);
    }
  });

  it("keeps the palette pass a small slice of the take", () => {
    // The pass re-composes every sampled frame, so a short take must not
    // spend most of its budget on palette samples.
    expect(gifPaletteSampleIndices(10).length).toBeLessThanOrEqual(3);
    expect(gifPaletteSampleIndices(1500).length).toBe(GIF_PALETTE_SAMPLE_FRAMES);
  });

  it("degenerates on an empty or invalid frame count", () => {
    expect(gifPaletteSampleIndices(0)).toEqual([]);
    expect(gifPaletteSampleIndices(Number.NaN)).toEqual([]);
    expect(gifPaletteSampleIndices(-3)).toEqual([]);
  });
});

describe("gifPaletteSampleFrame", () => {
  it("downsamples a later sample to the pixel budget", () => {
    const big = new Uint8ClampedArray(512 * 512 * 4);
    for (let i = 0; i < big.length; i += 4) {
      big[i] = i & 0xff;
      big[i + 1] = (i >> 4) & 0xff;
      big[i + 2] = (i >> 8) & 0xff;
      big[i + 3] = 255;
    }
    // 512 x 512 = 262,144 px is 8x the budget, so every 8th pixel survives.
    const small = gifPaletteSampleFrame(big);
    expect(small.length).toBeLessThanOrEqual(GIF_PALETTE_SAMPLE_PIXELS * 4);
    expect(small.length % 4).toBe(0);
    expect(Array.from(small.slice(0, 4))).toEqual(Array.from(big.slice(0, 4)));
    expect(Array.from(small.slice(4, 8))).toEqual(Array.from(big.slice(32, 36)));
  });

  it("leaves a sample that already fits untouched", () => {
    const tiny = new Uint8ClampedArray(4 * 4);
    expect(gifPaletteSampleFrame(tiny)).toBe(tiny);
  });
});

describe("gifTakePalette", () => {
  it("is deterministic for the same samples", () => {
    expect(gifTakePalette(frames.slice(0, 3))).toEqual(
      gifTakePalette(frames.slice(0, 3)),
    );
  });

  it("returns no palette without a usable sample", () => {
    expect(gifTakePalette([])).toEqual([]);
  });

  it("never exceeds GIF's 256 colours on a many-colour take", () => {
    // A deterministic 24-bit-ish noise field: far more distinct colours than
    // a GIF table can hold.
    const noise = new Uint8ClampedArray(64 * 64 * 4);
    let seed = 0x1234_5678;
    for (let i = 0; i < noise.length; i += 4) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      noise[i] = seed & 0xff;
      noise[i + 1] = (seed >> 8) & 0xff;
      noise[i + 2] = (seed >> 16) & 0xff;
      noise[i + 3] = 255;
    }
    const palette = gifTakePalette([noise]);
    expect(palette.length).toBeGreaterThan(1);
    expect(palette.length).toBeLessThanOrEqual(GIF_PALETTE_MAX_COLORS);
  });
});
