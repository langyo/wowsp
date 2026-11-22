/**
 * Minimal animated-WebP muxer — dependency-free.
 *
 * mediabunny has no image output (verified for #2094) and nothing else in
 * this tree writes an animated WebP container, so the muxer is hand-rolled
 * against the WebP container spec
 * (https://developers.google.com/speed/webp/docs/rif):
 *
 *   RIFF <file size - 8> WEBP
 *     VP8X   canvas size + flags (ANIMATION, plus ALPHA when a frame has it)
 *     ANIM   canvas background colour + loop count
 *     ANMF   one per frame: x/y/size/duration/flags + the frame's image
 *            subchunks (ALPH?, VP8 / VP8L) copied verbatim
 *
 * Every chunk is `<fourcc:4> <payload size:u32le> <payload>` padded to an
 * even length; the pad byte is NOT part of the chunk's size field, and the
 * RIFF size field counts the file length minus its first 8 bytes.
 *
 * The frames come from the browser: the Tauri webview is Chromium/WebView2,
 * whose 2D canvas encodes ONE lossy WebP frame natively through
 * `toBlob("image/webp", quality)` (VP8). An animation is that same frame
 * bitstream repeated inside the container above.
 *
 * Firefox note: its canvas does not encode WebP (toBlob silently falls back
 * to PNG). The shipped app is the WebView2 shell, so frames are WebP; a
 * non-WebP frame is REJECTED here (readWebpFrame) instead of being muxed
 * into a file no decoder could open.
 */

/** Bytes of the `RIFF <size> WEBP` preamble a single-frame WebP file starts
 *  with — stripped from every frame before it enters an ANMF chunk. */
export const WEBP_RIFF_HEADER_BYTES = 12;

/** ANMF's fixed header: X, Y, width-1, height-1, duration (24-bit each) and
 *  the one flags byte. */
export const WEBP_ANMF_HEADER_BYTES = 16;

/** VP8X payload: flags + 3 reserved bytes + two 24-bit (dimension - 1). */
const VP8X_PAYLOAD_BYTES = 10;
/** ANIM payload: background colour (u32le) + loop count (u16le). */
const ANIM_PAYLOAD_BYTES = 6;

/** VP8X flags (libwebp's contract): bit 1 = animation, bit 4 = alpha. */
const VP8X_FLAG_ANIMATION = 0x02;
const VP8X_FLAG_ALPHA = 0x10;
/** ANMF flags: bit 1 = "do not blend" — a full-canvas opaque frame replaces
 *  the canvas instead of alpha-blending onto it. */
const ANMF_FLAG_NO_BLEND = 0x02;

/** Largest 24-bit field value: canvas edge - 1 and the frame duration. */
const U24_MAX = 0xffffff;

/** One frame of the animation: a complete single-frame WebP file (the
 *  canvas's own `toBlob` output) plus how long it stays on screen. */
export interface AnimatedWebpFrame {
  data: Uint8Array;
  /** Display duration in ms; clamped to 1..0xffffff. */
  durationMs: number;
}

export interface AnimatedWebpOptions {
  /** Canvas edge in px (clamped to 1..0x1000000, the 24-bit field's range). */
  width: number;
  height: number;
  /** At least one frame, in display order. */
  frames: readonly AnimatedWebpFrame[];
  /** 0 = loop forever (the spec's convention); 1..0xfffe = repeat count. */
  loopCount?: number;
  /** ANIM background colour as BGRA packed little-endian. Default 0 (fully
   *  transparent) — every frame covers the whole canvas anyway. */
  backgroundColor?: number;
}

/** A frame's image subchunks, ready to embed in an ANMF chunk. */
export interface WebpFrameChunks {
  /** ALPH + VP8 / VP8L subchunks WITH their own headers and even-length
   *  padding — exactly the "frame data" an ANMF payload carries. */
  data: Uint8Array;
  /** True when the frame carried an ALPH chunk (the file's VP8X must then
   *  advertise alpha). */
  hasAlpha: boolean;
}

function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
      0)
  );
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU24(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Clamp a canvas edge into the 24-bit field's 1..0x1000000 range. */
function clampDimension(value: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : 1;
  return Math.min(U24_MAX + 1, Math.max(1, rounded));
}

/** Clamp a frame duration into the 24-bit millisecond field (a 0 ms frame
 *  would be dropped by most decoders, so the floor is 1). */
function clampDuration(ms: number): number {
  const rounded = Number.isFinite(ms) ? Math.round(ms) : 1;
  return Math.min(U24_MAX, Math.max(1, rounded));
}

/**
 * Extract a single-frame WebP file's image subchunks (ALPH / VP8 / VP8L),
 * dropping the 12-byte RIFF preamble, any frame-level VP8X (the ANMF header
 * already carries the frame's geometry) and any container-level metadata
 * chunk. Throws on anything that is not a RIFF/WEBP file with a real
 * bitstream — notably the PNG a non-WebP canvas (Firefox) silently returns.
 */
export function readWebpFrame(frame: Uint8Array): WebpFrameChunks {
  if (frame.length < WEBP_RIFF_HEADER_BYTES) {
    throw new Error("webp: frame shorter than the RIFF header");
  }
  if (fourCC(frame, 0) !== "RIFF" || fourCC(frame, 8) !== "WEBP") {
    throw new Error("webp: frame is not a RIFF/WEBP file");
  }
  const parts: Uint8Array[] = [];
  let hasAlpha = false;
  let hasBitstream = false;
  let offset = WEBP_RIFF_HEADER_BYTES;
  while (offset + 8 <= frame.length) {
    const id = fourCC(frame, offset);
    const size = u32le(frame, offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > frame.length) {
      throw new Error(`webp: truncated ${id} chunk`);
    }
    if (id === "ALPH") hasAlpha = true;
    if (id === "VP8 " || id === "VP8L") hasBitstream = true;
    // An ANMF payload may carry ONLY image subchunks (ALPH + VP8 / VP8L) —
    // a frame-level VP8X or a metadata chunk is container-level and would
    // make the animation invalid, so every other chunk is dropped.
    if (id === "ALPH" || id === "VP8 " || id === "VP8L") {
      // Copy the chunk verbatim, header included, plus its even-length pad
      // byte (synthesized when the source file omitted it).
      const chunk = new Uint8Array(8 + size + (size & 1));
      chunk.set(frame.subarray(offset, end), 0);
      parts.push(chunk);
    }
    offset = end + (size & 1);
  }
  if (!hasBitstream) {
    throw new Error("webp: frame carries no VP8 / VP8L bitstream");
  }
  return { data: concatBytes(parts), hasAlpha };
}

/**
 * Assemble an animated WebP from single-frame WebP files. Frames are
 * full-canvas at (0, 0) — the export composes every frame at the same size
 * — and use "do not blend" + "no dispose": each frame is a complete opaque
 * painting, so replacing the canvas is exact and cheaper than blending.
 */
export function muxAnimatedWebp(options: AnimatedWebpOptions): Uint8Array {
  const frames = options.frames;
  if (frames.length === 0) {
    throw new Error("webp: an animation needs at least one frame");
  }
  const width = clampDimension(options.width);
  const height = clampDimension(options.height);
  const loopCount = Math.min(0xffff, Math.max(0, Math.round(options.loopCount ?? 0)));
  const backgroundColor = (options.backgroundColor ?? 0) >>> 0;

  const chunks = frames.map((frame) => readWebpFrame(frame.data));
  const hasAlpha = chunks.some((chunk) => chunk.hasAlpha);
  const sizes = chunks.map((chunk) => WEBP_ANMF_HEADER_BYTES + chunk.data.length);

  const vp8xTotal = 8 + VP8X_PAYLOAD_BYTES;
  const animTotal = 8 + ANIM_PAYLOAD_BYTES;
  let framesTotal = 0;
  for (const size of sizes) framesTotal += 8 + size + (size & 1);
  const fileBytes = WEBP_RIFF_HEADER_BYTES + vp8xTotal + animTotal + framesTotal;

  const out = new Uint8Array(fileBytes);
  let at = 0;
  const writeChunkHeader = (id: string, size: number): void => {
    for (let i = 0; i < 4; i++) out[at + i] = id.charCodeAt(i);
    writeU32(out, at + 4, size);
    at += 8;
  };

  // RIFF preamble: the size field is the file length minus these 8 bytes.
  for (let i = 0; i < 4; i++) out[i] = "RIFF".charCodeAt(i);
  writeU32(out, 4, fileBytes - 8);
  for (let i = 0; i < 4; i++) out[8 + i] = "WEBP".charCodeAt(i);
  at = WEBP_RIFF_HEADER_BYTES;

  // VP8X: animation flag (+ alpha when any frame carries ALPH), reserved
  // zero bytes, then the canvas dimensions as (edge - 1).
  writeChunkHeader("VP8X", VP8X_PAYLOAD_BYTES);
  out[at] = VP8X_FLAG_ANIMATION | (hasAlpha ? VP8X_FLAG_ALPHA : 0);
  writeU24(out, at + 4, width - 1);
  writeU24(out, at + 7, height - 1);
  at += VP8X_PAYLOAD_BYTES;

  // ANIM: background (BGRA, little-endian) + loop count (0 = forever).
  writeChunkHeader("ANIM", ANIM_PAYLOAD_BYTES);
  writeU32(out, at, backgroundColor);
  writeU16(out, at + 4, loopCount);
  at += ANIM_PAYLOAD_BYTES;

  // ANMF per frame. The payload is the 16-byte header + the frame's image
  // chunks (already even-length, so the payload needs no pad of its own).
  chunks.forEach((chunk, i) => {
    writeChunkHeader("ANMF", sizes[i]);
    writeU24(out, at, 0); // frame X / 2
    writeU24(out, at + 3, 0); // frame Y / 2
    writeU24(out, at + 6, width - 1);
    writeU24(out, at + 9, height - 1);
    writeU24(out, at + 12, clampDuration(frames[i].durationMs));
    out[at + 15] = ANMF_FLAG_NO_BLEND;
    at += WEBP_ANMF_HEADER_BYTES;
    out.set(chunk.data, at);
    at += chunk.data.length;
  });

  return out;
}
