/** Ambient types for gifenc (MIT, no bundled declarations — the API
 *  surface WoWSP uses: encoder + quantize + applyPalette; see
 *  https://github.com/mattdesl/gifenc). */
declare module "gifenc" {
  export interface GifFrameOptions {
    /** Palette for this frame. The FIRST frame's palette becomes the
     *  file's global colour table; on a later frame it is written as a
     *  local colour table that overrides it. Omit it on later frames to
     *  keep indexing the one global table (the stable-palette route). */
    palette?: number[][];
    /** Frame delay in milliseconds (snapped to centiseconds). */
    delay: number;
    transparent?: boolean;
    transparentIndex?: number;
    repeat?: number;
    dispose?: number;
    first?: boolean;
  }

  export interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts: GifFrameOptions,
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }

  export function GIFEncoder(opts?: {
    auto?: boolean;
    initialCapacity?: number;
  }): GifEncoderInstance;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: {
      format?: "rgb565" | "rgb444" | "rgba4444";
      oneBitAlpha?: boolean | number;
      clearAlpha?: boolean;
      clearAlphaThreshold?: number;
      clearAlphaColor?: number;
    },
  ): number[][];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: "rgb565" | "rgb444" | "rgba4444",
  ): Uint8Array;
}
