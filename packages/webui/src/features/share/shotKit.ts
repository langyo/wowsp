/**
 * Shared primitives for WoWSP share shots — the hand-drawn offscreen-canvas
 * pipeline behind every "copy share shot" surface (the replay post-battle
 * matrix, the water-table / lookup stats cards, the clan roster card).
 *
 * One kit, many compositions: each renderer owns its layout and comes here
 * for the pieces that must stay identical across every share image — the
 * live-theme palette reader, the font stacks, the bundled-image loader, the
 * career-seal painter and above all the fixed WoWSP watermark footer, so no
 * surface can ship an unbranded or differently-branded shot. Like the
 * tactical board's exporters this is deterministic hand-drawn canvas, never
 * DOM rasterization: no hover states, no scrollbars, and privacy masking
 * stays in the caller's plain-data model (a renderer never sees what it
 * must not paint).
 *
 * Theme colors are read live from the app's CSS custom properties (so the
 * shot follows the light/dark mode) with hard dark-theme fallbacks; embedded
 * bitmaps (class icons, seal glyphs, the mascot logo) are bundled
 * same-origin vite assets, so the canvas never taints.
 */
import { t } from "@/i18n";
import type { StampKind } from "@/utils/winrate";
import stampAir from "../../res/stamps/stamp-air.png";
import stampAirApe from "../../res/stamps/stamp-air-ape.png";
import stampAirMiracle from "../../res/stamps/stamp-air-miracle.png";
import stampAirVeteran from "../../res/stamps/stamp-air-veteran.png";
import stampApe from "../../res/stamps/stamp-ape.png";
import stampMaggot from "../../res/stamps/stamp-maggot.png";
import stampMiracle from "../../res/stamps/stamp-miracle.png";
import stampRat from "../../res/stamps/stamp-rat.png";
import stampSub from "../../res/stamps/stamp-sub.png";
import stampSubApe from "../../res/stamps/stamp-sub-ape.png";
import stampSubMiracle from "../../res/stamps/stamp-sub-miracle.png";
import stampSubVeteran from "../../res/stamps/stamp-sub-veteran.png";

/** App palette snapshot: CSS var triplets ("R G B") resolved at render time. */
export interface ShotPalette {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  primary: string;
  accent: string;
}

const DEFAULT_PALETTE: ShotPalette = {
  bg: "12 17 27",
  surface: "22 30 46",
  text: "233 238 246",
  muted: "150 160 175",
  border: "255 255 255",
  primary: "0 120 200",
  accent: "255 180 60",
};

const FONT_STACK =
  'ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
const MONO_STACK =
  'ui-monospace, "Cascadia Mono", Consolas, "Segoe UI", monospace, sans-serif';

/** Fixed 2× supersampling: share shots keep crisp small text when pasted
 *  into HiDPI chat clients. All draw code works in logical units. */
export const SCALE = 2;
/** Shared page padding and footer band height, in logical units. */
export const PAD = 28;
/** Footer band: tall enough for the logo block and the two centered
 *  disclaimer lines to breathe. */
export const FOOT_H = 88;
/** The footer's mascot logo: rounded-frame size and the air between it and
 *  the brand block (shared by the painter and the minimum-width measure). */
const LOGO_SIZE = 46;
const LOGO_GAP = 12;
/** Minimum air between the footer's three text blocks (brand / disclaimers /
 *  QQ group) before they count as colliding. */
const FOOTER_GAP = 16;
/** The bundled pig-mascot brand mark (public/ asset — same-origin, so the
 *  canvas never taints; same pattern as the HUD marker PNGs). */
export const LOGO_URL = "/logo.webp";
const GITHUB_URL = "github.com/langyo/wowsp";

/** Scratch 2d context for measuring text outside a live shot canvas — the
 *  footer minimum width budgets before any painting starts. */
let measureCtx: CanvasRenderingContext2D | null = null;
function sharedMeasureContext(): CanvasRenderingContext2D | null {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

export const rgba = (triplet: string, alpha: number): string =>
  `rgba(${triplet.split(" ").join(",")},${alpha})`;

export function font(size: number, weight = 400, mono = false): string {
  return `${weight} ${size}px ${mono ? MONO_STACK : FONT_STACK}`;
}

export function readPalette(el?: HTMLElement | null): ShotPalette {
  if (!el) return DEFAULT_PALETTE;
  const style = getComputedStyle(el);
  const pick = (name: string, fallback: string): string => {
    const v = style.getPropertyValue(name).trim();
    // CSS vars here are "R G B" triplets (rgb(var(--x) / a) usage in the app).
    return /^\d{1,3} \d{1,3} \d{1,3}$/.test(v) ? v : fallback;
  };
  return {
    bg: pick("--color-background", DEFAULT_PALETTE.bg),
    surface: pick("--color-surface", DEFAULT_PALETTE.surface),
    text: pick("--color-text", DEFAULT_PALETTE.text),
    muted: pick("--color-muted", DEFAULT_PALETTE.muted),
    border: pick("--color-text", DEFAULT_PALETTE.border),
    primary: pick("--color-primary", DEFAULT_PALETTE.primary),
    accent: pick("--color-accent", DEFAULT_PALETTE.accent),
  };
}

/** Image cache for the bundled PNG/WebP assets (a full roster reuses the
 * same handful of class icons and seal glyphs dozens of times). */
const imageCache = new Map<string, Promise<HTMLImageElement | null>>();
export function loadImage(url: string | null): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  let entry = imageCache.get(url);
  if (!entry) {
    entry = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    imageCache.set(url, entry);
  }
  return entry;
}

/** Localized strings the fixed promo footer carries (the QQ number itself
 *  comes from about.qqGroupNumber). */
export interface ShotFooterStrings {
  tagline: string;
  disclaimer1: string;
  disclaimer2: string;
  qqGroup: string;
}

/** Resolve the footer strings from the shared `share` i18n namespace — the
 *  single source so every share surface carries the same watermark copy. */
export function shareFooterStrings(): ShotFooterStrings {
  return {
    tagline: t("share.shotTagline"),
    disclaimer1: t("share.shotDisclaimer1"),
    disclaimer2: t("share.shotDisclaimer2"),
    qqGroup: t("share.shotQqGroup", { n: t("about.qqGroupNumber") }),
  };
}

/** Lowest canvas logical width that keeps the fixed footer's three blocks —
 *  brand + tagline left, the two disclaimers centered, QQ group + project
 *  URL right — from colliding (the centered block must clear both sides).
 *  Renderers floor their width on this (their own layout minimums may sit
 *  higher) so a longer watermark copy widens the shot instead of having its
 *  bottom lines overlap. */
export function footerMinWidth(
  footer: ShotFooterStrings,
  hasLogo: boolean,
): number {
  const ctx = sharedMeasureContext();
  if (!ctx) return 0;
  let left = PAD;
  if (hasLogo) left += LOGO_SIZE + LOGO_GAP;
  ctx.font = font(19, 700);
  const brandW = ctx.measureText("WoWSP").width;
  ctx.font = font(12, 400);
  left += Math.max(brandW, ctx.measureText(footer.tagline).width);
  ctx.font = font(11.5, 400);
  const centerW = Math.max(
    ctx.measureText(footer.disclaimer1).width,
    ctx.measureText(footer.disclaimer2).width,
  );
  ctx.font = font(12, 600);
  const qqW = ctx.measureText(footer.qqGroup).width;
  ctx.font = font(12, 400);
  const rightW = Math.max(qqW, ctx.measureText(GITHUB_URL).width);
  return Math.ceil(
    Math.max(
      2 * left + centerW + FOOTER_GAP * 2,
      centerW + 2 * rightW + 2 * (PAD + FOOTER_GAP),
    ),
  );
}

/** Draw the camera-watermark promo footer: pig logo + brand + localized
 *  tagline left, the two fixed disclaimers centered (data is reference-only;
 *  the software is free — never pay for it), QQ group + project URL right —
 *  the fixed WoWSP signature on every share shot. */
export function drawFooter(
  ctx: CanvasRenderingContext2D,
  palette: ShotPalette,
  width: number,
  footer: ShotFooterStrings,
  logo: HTMLImageElement | null,
): void {
  const y = ctx.canvas.height / SCALE - FOOT_H;
  ctx.fillStyle = rgba(palette.surface, 0.75);
  ctx.fillRect(0, y, width, FOOT_H);
  ctx.fillStyle = rgba(palette.text, 0.12);
  ctx.fillRect(0, y, width, 1);

  ctx.textBaseline = "middle";
  const cy = y + FOOT_H / 2;

  // Left: the mascot logo in a rounded frame, brand + tagline beside it.
  let lx = PAD;
  if (logo) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(lx, cy - LOGO_SIZE / 2, LOGO_SIZE, LOGO_SIZE, 10);
    ctx.clip();
    ctx.drawImage(logo, lx, cy - LOGO_SIZE / 2, LOGO_SIZE, LOGO_SIZE);
    ctx.restore();
    lx += LOGO_SIZE + LOGO_GAP;
  }
  ctx.textAlign = "left";
  ctx.font = font(19, 700);
  ctx.fillStyle = rgba(palette.text, 1);
  ctx.fillText("WoWSP", lx, cy - 11);
  ctx.font = font(12, 400);
  ctx.fillStyle = rgba(palette.text, 0.6);
  ctx.fillText(footer.tagline, lx, cy + 12);

  // Center: the two disclaimers.
  ctx.textAlign = "center";
  ctx.font = font(11.5, 400);
  ctx.fillStyle = rgba(palette.text, 0.48);
  ctx.fillText(footer.disclaimer1, width / 2, cy - 12);
  ctx.fillText(footer.disclaimer2, width / 2, cy + 12);

  // Right: QQ group over the project URL.
  ctx.textAlign = "right";
  ctx.font = font(12, 600);
  ctx.fillStyle = rgba(palette.text, 0.72);
  ctx.fillText(footer.qqGroup, width - PAD, cy - 11);
  ctx.font = font(12, 400);
  ctx.fillStyle = rgba(palette.text, 0.55);
  ctx.fillText(GITHUB_URL, width - PAD, cy + 12);
}

/** Cinnabar seal ink — RatingStamp's frame color (RatingStamp.scss). */
const STAMP_INK = "202 44 38";

/** The seal glyph bitmaps (same assets the RatingStamp SVG embeds). */
export const STAMP_URL: Record<StampKind, string> = {
  miracle: stampMiracle,
  ape: stampApe,
  maggot: stampMaggot,
  rat: stampRat,
  air: stampAir,
  sub: stampSub,
  airVeteran: stampAirVeteran,
  subVeteran: stampSubVeteran,
  airMiracle: stampAirMiracle,
  subMiracle: stampSubMiracle,
  airApe: stampAirApe,
  subApe: stampSubApe,
};

/** RatingStamp's face redrawn in canvas — double rounded frame in cinnabar
 *  ink around the glyph bitmap, tilted by the shared −9° press. The
 *  `variant` mirrors the component's: "full" keeps the classic wide
 *  double border, "mini" presses the thinner tighter frame with the larger
 *  glyph (no moiré weave at these sizes either way). */
export function drawStampSeal(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  img: HTMLImageElement | null,
  variant: "full" | "mini" = "full",
): void {
  // Frame geometry per variant, in viewBox units (see RatingStamp.tsx).
  const geo = variant === "mini"
    ? { outer: 46.5, outerW: 93, outerR: 6, outerLw: 4, inner: 39.5, innerW: 79, innerR: 2.5, innerLw: 1.5, glyph: 36, glyphW: 72 }
    : { outer: 45, outerW: 90, outerR: 7, outerLw: 6, inner: 35.5, innerW: 71, innerR: 3, innerLw: 2, glyph: 33, glyphW: 66 };
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 20);
  ctx.strokeStyle = rgba(STAMP_INK, 0.9);
  const s = size / 100;
  ctx.lineWidth = geo.outerLw * s;
  ctx.beginPath();
  ctx.roundRect(-geo.outer * s, -geo.outer * s, geo.outerW * s, geo.outerW * s, geo.outerR * s);
  ctx.stroke();
  ctx.lineWidth = geo.innerLw * s;
  ctx.beginPath();
  ctx.roundRect(-geo.inner * s, -geo.inner * s, geo.innerW * s, geo.innerW * s, geo.innerR * s);
  ctx.stroke();
  if (img) {
    ctx.globalAlpha *= 0.92;
    ctx.drawImage(img, -geo.glyph * s, -geo.glyph * s, geo.glyphW * s, geo.glyphW * s);
  }
  ctx.restore();
}

/** Truncate `text` with an ellipsis so it fits `maxWidth` at the active
 *  font (canvas's own fillText maxWidth arg squishes glyphs instead). */
export function ellipsize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/** The six PR band colors (prTier's scale) — the canvas counterpart of the
 *  app's rainbow-text for the 彩表 (战舰仙人) tier: a horizontal gradient
 *  across the text's extent, `x` being the text's RIGHT edge (PR values
 *  render right-aligned). */
export function rainbowFill(
  ctx: CanvasRenderingContext2D,
  x: number,
  w: number,
): CanvasGradient {
  const grad = ctx.createLinearGradient(x - w, 0, x, 0);
  const bands = [
    "rgb(254 14 0)",
    "rgb(255 199 31)",
    "rgb(68 179 0)",
    "rgb(2 201 179)",
    "rgb(208 66 243)",
    "rgb(160 13 197)",
  ];
  bands.forEach((c, i) => grad.addColorStop(i / (bands.length - 1), c));
  return grad;
}

/** Measure the widest right-aligned stat cell per column index so every
 *  row's cells share one x-origin — the aligned-table look of the live
 *  panels. `cells` is one string array per row; `gap` is the visual air
 *  between adjacent columns.
 *
 *  The returned origin per column is that column's RIGHT edge, measured
 *  from the stat block's left edge (`origin[i] = Σ_{j≤i} width_j + i·gap`)
 *  — exactly where a `textAlign: "right"` fillText belongs. Returning
 *  LEFT edges here used to make every column's right-aligned text reach
 *  one column-width leftward into its neighbour, visibly overlapping
 *  whenever a later column is wider than the previous one plus the gap
 *  (the stats card's narrow battles column under a wide "100.0%"
 *  winrate). The LAST origin therefore equals the whole block's width,
 *  which is what the callers' `origins[origins.length - 1] + pad`
 *  trailing-space math expects. */
export function statCellOrigins(
  ctx: CanvasRenderingContext2D,
  cells: string[][],
  gap: number,
): number[] {
  const count = Math.max(0, ...cells.map((c) => c.length));
  const origins: number[] = [];
  let x = 0;
  for (let i = 0; i < count; i++) {
    let w = 0;
    for (const row of cells) {
      const s = row[i];
      if (s) w = Math.max(w, ctx.measureText(s).width);
    }
    origins.push(x + w);
    x += w + gap;
  }
  return origins;
}

/** Create the offscreen canvas for one shot at logical `width`×`height`
 *  (2× supersampled, background pre-filled from the palette). */
export function newShotCanvas(
  width: number,
  height: number,
  palette: ShotPalette,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * SCALE);
  canvas.height = Math.round(height * SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = rgba(palette.bg, 1);
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx };
}

/** Encode the painted canvas as PNG bytes (the clipboard payload shape). */
export async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) throw new Error("PNG encode failed");
  return new Uint8Array(await blob.arrayBuffer());
}
