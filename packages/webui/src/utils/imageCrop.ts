/**
 * Square-crop math for the image crop dialog (components/base/
 * ImageSquareCropModal). The dialog shows a pan/zoom window over the picked
 * image inside a fixed square viewport; these helpers own the geometry
 * invariants so the component only carries state:
 *
 *  - `scale` is CSS px per source pixel; its floor is cover-fit (the image
 *    always fills the viewport — no empty bars inside the crop).
 *  - Pan offsets `tx`/`ty` are viewport-center-relative: 0 keeps the image
 *    centered, and the clamped range never exposes an edge.
 *  - The viewport therefore always selects a SQUARE source region — the
 *    crop can't help being square, which is the dialog's whole point.
 */

/** The smallest zoom at which the image still covers the square viewport. */
export function coverScale(srcW: number, srcH: number, viewport: number): number {
  return Math.max(viewport / srcW, viewport / srcH);
}

/** The largest useful zoom: deep enough to crop a `minCrop`-pixel square
 *  out of any image, but never past what the min-side rule would accept —
 *  on a square source at/below `minCrop` this collapses to cover-fit, so a
 *  small square picture can only be taken whole (no upscaled "zoom"). */
export function maxScale(srcW: number, srcH: number, viewport: number, minCrop: number): number {
  return Math.max(coverScale(srcW, srcH, viewport), viewport / minCrop);
}

/** Clamp one pan axis so the scaled image still covers the viewport on it
 * (a exactly-fitting axis pins the offset to 0). */
export function clampOffset(offset: number, scaledImg: number, viewport: number): number {
  const limit = Math.max(0, (scaledImg - viewport) / 2);
  return Math.min(limit, Math.max(-limit, offset));
}

export interface SourceRect {
  x: number;
  y: number;
  /** Edge length in source pixels (square by construction). */
  size: number;
}

/** The source region the viewport currently shows. Offsets are
 *  viewport-center-relative (see coverScale), so the image's top-left sits
 *  at `(viewport - scaled) / 2 + offset` and the rect follows from there. */
export function viewportSourceRect(
  srcW: number,
  srcH: number,
  viewport: number,
  scale: number,
  tx: number,
  ty: number,
): SourceRect {
  const size = viewport / scale;
  const x = (srcW * scale - viewport) / 2 / scale - tx / scale;
  const y = (srcH * scale - viewport) / 2 / scale - ty / scale;
  // Absorb float drift at the clamped edges so the rect never leaves the
  // image by a fraction of a pixel (canvas drawImage would clip it).
  return {
    x: Math.min(Math.max(0, x), srcW - size),
    y: Math.min(Math.max(0, y), srcH - size),
    size,
  };
}

/** Whether the viewport shows the image whole — the passthrough condition
 *  that keeps the ORIGINAL bytes (and a GIF's animation) instead of a
 *  canvas re-encode. */
export function isFullImageRect(rect: SourceRect, srcW: number, srcH: number): boolean {
  if (srcW !== srcH) return false;
  const epsilon = 0.5;
  return rect.x <= epsilon && rect.y <= epsilon && Math.abs(rect.size - srcW) <= epsilon;
}

/** Zoom around the viewport center: keep the source point under the center
 *  fixed by scaling the center-relative offsets proportionally. */
export function zoomOffsets(tx: number, ty: number, factor: number): { tx: number; ty: number } {
  return { tx: tx * factor, ty: ty * factor };
}
