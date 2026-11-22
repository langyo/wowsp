/** Animated-WebP muxer tests — a PARSE-BACK decoder lives here on purpose:
 *  the test walks the bytes the muxer produced with its own RIFF reader and
 *  asserts the chunk tree, the frame count, every duration and the pad-byte
 *  accounting. Nothing here reuses the muxer's code, so a symmetrically
 *  wrong writer and reader cannot pass. */
import { describe, expect, it } from "vitest";

import {
  WEBP_ANMF_HEADER_BYTES,
  WEBP_RIFF_HEADER_BYTES,
  muxAnimatedWebp,
  readWebpFrame,
  type AnimatedWebpFrame,
} from "./webpMux";

/** One RIFF chunk as the test's own decoder sees it. */
interface ParsedChunk {
  id: string;
  /** The size field (padding excluded, per the spec). */
  size: number;
  payload: Uint8Array;
}

const ascii = (text: string): Uint8Array =>
  Uint8Array.from([...text].map((ch) => ch.charCodeAt(0)));

function expectU32(bytes: Uint8Array, offset: number, value: number): void {
  const got =
    ((bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
      0);
  expect(got).toBe(value >>> 0);
}

function u24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/** Walk a chunk tree the way the WebP container spec defines it: 4-byte
 *  fourcc + u32le size + payload + one pad byte when the size is odd. */
function parseChunks(bytes: Uint8Array, from: number, to: number): ParsedChunk[] {
  const out: ParsedChunk[] = [];
  let at = from;
  while (at < to) {
    expect(at + 8).toBeLessThanOrEqual(to);
    const id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const size =
      bytes[at + 4] |
      (bytes[at + 5] << 8) |
      (bytes[at + 6] << 16) |
      (bytes[at + 7] << 24);
    expect(size).toBeGreaterThanOrEqual(0);
    const start = at + 8;
    const end = start + size;
    expect(end).toBeLessThanOrEqual(to);
    out.push({ id, size, payload: bytes.subarray(start, end) });
    at = end + (size & 1);
  }
  expect(at).toBe(to);
  return out;
}

/** Decode a whole animated WebP: the RIFF preamble plus its top chunks. */
function parseWebp(bytes: Uint8Array): ParsedChunk[] {
  expect(bytes.length).toBeGreaterThanOrEqual(WEBP_RIFF_HEADER_BYTES);
  expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
  // The RIFF size field counts everything after itself: file length - 8.
  expectU32(bytes, 4, bytes.length - 8);
  expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WEBP");
  return parseChunks(bytes, WEBP_RIFF_HEADER_BYTES, bytes.length);
}

/** A chunk with its header, payload and an even-length pad byte. */
function riffChunk(id: string, payload: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(8 + payload.length + (payload.length & 1));
  chunk.set(ascii(id), 0);
  chunk[4] = payload.length & 0xff;
  chunk[5] = (payload.length >>> 8) & 0xff;
  chunk[6] = (payload.length >>> 16) & 0xff;
  chunk[7] = (payload.length >>> 24) & 0xff;
  chunk.set(payload, 8);
  return chunk;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A single-frame WebP file as the browser emits one: RIFF/WEBP + chunks. */
function frameFile(chunks: readonly Uint8Array[]): Uint8Array {
  const body = concat(chunks);
  const out = new Uint8Array(WEBP_RIFF_HEADER_BYTES + body.length);
  out.set(ascii("RIFF"), 0);
  out[4] = (body.length + 4) & 0xff;
  out[5] = ((body.length + 4) >>> 8) & 0xff;
  out[6] = ((body.length + 4) >>> 16) & 0xff;
  out[7] = ((body.length + 4) >>> 24) & 0xff;
  out.set(ascii("WEBP"), 8);
  out.set(body, 12);
  return out;
}

/** A lossy (VP8) frame carrying `payload` as its bitstream. */
function vp8Frame(payload: number[]): Uint8Array {
  return frameFile([riffChunk("VP8 ", Uint8Array.from(payload))]);
}

/** A frame whose extended format carries an ALPH chunk — the browser's
 *  shape for a frame with transparency. */
function alphaFrame(payload: number[]): Uint8Array {
  return frameFile([
    riffChunk("VP8X", new Uint8Array(10)),
    riffChunk("ALPH", Uint8Array.from([0, 0, 0, 0, 0, 0])),
    riffChunk("VP8 ", Uint8Array.from(payload)),
  ]);
}

const frames = (...list: AnimatedWebpFrame[]): AnimatedWebpFrame[] => list;

describe("muxAnimatedWebp", () => {
  it("writes a RIFF/WEBP animation: VP8X + ANIM + one ANMF per frame", () => {
    const bytes = muxAnimatedWebp({
      width: 1920,
      height: 1080,
      frames: frames(
        { data: vp8Frame([1, 2, 3, 4]), durationMs: 100 },
        { data: vp8Frame([5, 6, 7, 8]), durationMs: 67 },
        { data: vp8Frame([9, 10, 11, 12]), durationMs: 250 },
      ),
      loopCount: 0,
    });
    const chunks = parseWebp(bytes);
    // The exact tree the spec requires for an animation.
    expect(chunks.map((c) => c.id)).toEqual(["VP8X", "ANIM", "ANMF", "ANMF", "ANMF"]);
    // VP8X: 10-byte payload, animation flag set, no alpha, canvas - 1.
    const vp8x = chunks[0];
    expect(vp8x.size).toBe(10);
    expect(vp8x.payload[0] & 0x02).toBe(0x02);
    expect(vp8x.payload[0] & 0x10).toBe(0);
    expect(u24(vp8x.payload, 4)).toBe(1919);
    expect(u24(vp8x.payload, 7)).toBe(1079);
    // ANIM: background + loop count.
    const anim = chunks[1];
    expect(anim.size).toBe(6);
    expectU32(anim.payload, 0, 0);
    expect(u16(anim.payload, 4)).toBe(0);
    // One ANMF each, 16-byte header + the frame's VP8 chunk (8 + 4).
    expect(chunks.slice(2).map((c) => c.size)).toEqual([16 + 12, 16 + 12, 16 + 12]);
  });

  it("carries each frame's duration and geometry in its ANMF header", () => {
    const bytes = muxAnimatedWebp({
      width: 720,
      height: 720,
      frames: frames(
        { data: vp8Frame([1]), durationMs: 100 },
        { data: vp8Frame([2]), durationMs: 66 },
        { data: vp8Frame([3]), durationMs: 40 },
      ),
    });
    const anmf = parseWebp(bytes).filter((c) => c.id === "ANMF");
    expect(anmf.map((c) => u24(c.payload, 12))).toEqual([100, 66, 40]);
    for (const chunk of anmf) {
      // Full-canvas frames at the origin, the size as (edge - 1).
      expect(u24(chunk.payload, 0)).toBe(0);
      expect(u24(chunk.payload, 3)).toBe(0);
      expect(u24(chunk.payload, 6)).toBe(719);
      expect(u24(chunk.payload, 9)).toBe(719);
      // "Do not blend": every frame is a complete opaque painting.
      expect(chunk.payload[15]).toBe(0x02);
    }
  });

  it("copies each frame's bitstream verbatim into its ANMF payload", () => {
    const first = [0xde, 0xad, 0xbe, 0xef];
    const second = [0xca, 0xfe];
    const bytes = muxAnimatedWebp({
      width: 4,
      height: 4,
      frames: frames(
        { data: vp8Frame(first), durationMs: 10 },
        { data: vp8Frame(second), durationMs: 10 },
      ),
    });
    const anmf = parseWebp(bytes).filter((c) => c.id === "ANMF");
    const inner = anmf.map((c) =>
      parseChunks(c.payload, WEBP_ANMF_HEADER_BYTES, c.payload.length),
    );
    expect(inner.map((chs) => chs.map((c) => c.id))).toEqual([["VP8 "], ["VP8 "]]);
    expect(inner[0][0].size).toBe(first.length);
    expect([...inner[0][0].payload]).toEqual(first);
    expect([...inner[1][0].payload]).toEqual(second);
  });

  it("pads an odd-length frame chunk and keeps every size even", () => {
    // A 5-byte VP8 payload is odd: its inner chunk needs one pad byte, and
    // the ANMF payload (16 + 8 + 5 + 1) stays even.
    const odd = [1, 2, 3, 4, 5];
    const bytes = muxAnimatedWebp({
      width: 3,
      height: 3,
      frames: frames({ data: vp8Frame(odd), durationMs: 20 }),
    });
    const anmf = parseWebp(bytes).find((c) => c.id === "ANMF")!;
    expect(anmf.size).toBe(16 + 14);
    expect(anmf.size % 2).toBe(0);
    const inner = parseChunks(anmf.payload, WEBP_ANMF_HEADER_BYTES, anmf.payload.length);
    expect(inner).toHaveLength(1);
    expect(inner[0].id).toBe("VP8 ");
    expect(inner[0].size).toBe(5);
    expect([...inner[0].payload]).toEqual(odd);
    // The pad byte sits between the payload and the next chunk / ANMF end.
    const padAt = WEBP_ANMF_HEADER_BYTES + 8 + 5;
    expect(anmf.payload[padAt]).toBe(0);
    // The whole file is even too (the spec's chunk-padding invariant).
    expect(bytes.length % 2).toBe(0);
    expectU32(bytes, 4, bytes.length - 8);
  });

  it("drops the frame-level VP8X and advertises alpha when a frame has ALPH", () => {
    const bytes = muxAnimatedWebp({
      width: 16,
      height: 9,
      frames: frames(
        { data: vp8Frame([1, 2]), durationMs: 100 },
        { data: alphaFrame([3, 4]), durationMs: 100 },
      ),
    });
    const chunks = parseWebp(bytes);
    // The file's VP8X now advertises alpha; the frames' own VP8X copies are
    // gone (the ANMF header carries their geometry).
    expect(chunks[0].payload[0] & 0x10).toBe(0x10);
    const anmf = chunks.filter((c) => c.id === "ANMF");
    const alphaInner = parseChunks(anmf[1].payload, WEBP_ANMF_HEADER_BYTES, anmf[1].payload.length);
    expect(alphaInner.map((c) => c.id)).toEqual(["ALPH", "VP8 "]);
    const plainInner = parseChunks(anmf[0].payload, WEBP_ANMF_HEADER_BYTES, anmf[0].payload.length);
    expect(plainInner.map((c) => c.id)).toEqual(["VP8 "]);
  });

  it("drops container-level metadata chunks (the ANMF keeps image data only)", () => {
    // An ICCP / EXIF chunk is container-level: inside an ANMF it would make
    // the animation invalid, so the frame keeps only ALPH + VP8 / VP8L.
    const frame = frameFile([
      riffChunk("ICCP", Uint8Array.from([1, 2, 3])),
      riffChunk("EXIF", Uint8Array.from([9, 9])),
      riffChunk("VP8 ", Uint8Array.from([7, 8])),
    ]);
    expect(readWebpFrame(frame).data.length).toBe(8 + 2);
    const bytes = muxAnimatedWebp({
      width: 8,
      height: 8,
      frames: frames({ data: frame, durationMs: 50 }),
    });
    const anmf = parseWebp(bytes).find((c) => c.id === "ANMF")!;
    const inner = parseChunks(anmf.payload, WEBP_ANMF_HEADER_BYTES, anmf.payload.length);
    expect(inner.map((c) => c.id)).toEqual(["VP8 "]);
  });

  it("keeps the loop count and background it was given", () => {
    const bytes = muxAnimatedWebp({
      width: 8,
      height: 8,
      frames: frames({ data: vp8Frame([1]), durationMs: 100 }),
      loopCount: 3,
      backgroundColor: 0xff102030,
    });
    const anim = parseWebp(bytes).find((c) => c.id === "ANIM")!;
    expectU32(anim.payload, 0, 0xff102030);
    expect(u16(anim.payload, 4)).toBe(3);
  });

  it("clamps durations and the loop count into their field ranges", () => {
    const bytes = muxAnimatedWebp({
      width: 8,
      height: 8,
      frames: frames(
        { data: vp8Frame([1]), durationMs: 0 },
        { data: vp8Frame([2]), durationMs: 1e9 },
      ),
      loopCount: 1e9,
    });
    const chunks = parseWebp(bytes);
    const anmf = chunks.filter((c) => c.id === "ANMF");
    // 0 ms would be dropped by decoders → 1; > 0xffffff → the field's max.
    expect(u24(anmf[0].payload, 12)).toBe(1);
    expect(u24(anmf[1].payload, 12)).toBe(0xffffff);
    const anim = chunks.find((c) => c.id === "ANIM")!;
    expect(u16(anim.payload, 4)).toBe(0xffff);
  });

  it("rejects a non-WebP frame (Firefox's PNG fallback) instead of muxing it", () => {
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(() => readWebpFrame(png)).toThrow(/not a RIFF\/WEBP file/);
    expect(() =>
      muxAnimatedWebp({
        width: 8,
        height: 8,
        frames: frames({ data: png, durationMs: 100 }),
      }),
    ).toThrow();
  });

  it("rejects an empty frame list and a truncated chunk", () => {
    expect(() => muxAnimatedWebp({ width: 8, height: 8, frames: [] })).toThrow(
      /needs at least one frame/,
    );
    const good = vp8Frame([1, 2, 3]);
    const truncated = good.subarray(0, good.length - 2);
    expect(() => readWebpFrame(truncated)).toThrow(/truncated/);
    // A RIFF/WEBP shell with no image bitstream is not a frame either.
    expect(() => readWebpFrame(frameFile([riffChunk("VP8X", new Uint8Array(10))]))).toThrow(
      /no VP8/,
    );
  });
});
