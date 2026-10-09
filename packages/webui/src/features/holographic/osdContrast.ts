/**
 * OSD auto-contrast for the holographic map's floating text — the same
 * trick a surveillance camera's on-screen display uses: sample the pixels
 * the scene actually rendered behind each text block and flip the ink
 * between light and dark so the text stays readable over whatever sits
 * behind it (cyclone wash, smoke, the bright light-theme sea, islands).
 *
 * The DOM ship labels and the cap-letter / smoke-countdown sprites are all
 * painted constant white; the storm mask (weatherScene.ts) only darkens
 * the WebGL canvas, and any bright background washes the white ink out.
 * Rather than modeling the background analytically (theme palette × storm
 * geometry × water tones — a recipe that drifts every time the scene art
 * changes), the whole scene is re-rendered into a tiny render target at a
 * throttled cadence and the average luminance under each text's screen
 * rect is read back — exactly what the camera sees, whatever the art does.
 *
 * Cost: one extra scene render at ≤288 px wide plus one small GPU readback
 * per refresh (5 Hz by default) — orders of magnitude below the main
 * render, and the per-label tone write only touches the DOM when a label
 * actually flips.
 */
import * as THREE from "three";
import type { Ref } from "vue";
import { paintCapSprite, paintSmokeCountdown } from "./screenOverlays";
import type { ThreeScene } from "./useThreeScene";
import type { MapInternals } from "./mapInternals";

/** Which ink a text block currently wears: "light" = white ink (the
 *  historical look, readable over the dark sea), "dark" = near-black ink
 *  (readable over smoke / cyclone wash / the light-theme sea). */
export type OsdTone = "light" | "dark";

/** Linear-light luminance above which ink flips to dark (bright backdrop). */
export const OSD_DARK_INK_ABOVE = 0.34;
/** Below which it flips back to light — the hysteresis band between the
 *  two thresholds keeps a label sitting on the boundary from flapping. */
export const OSD_LIGHT_INK_BELOW = 0.26;

/** Resolve the ink tone for a backdrop luminance, with hysteresis: an
 *  unassigned label follows the plain threshold; a previously-dark label
 *  only gives its dark ink up once the backdrop drops clearly bright. */
export function toneForLuma(prev: OsdTone | undefined, luma: number): OsdTone {
  if (luma < 0) return prev ?? "light"; // unknown backdrop → keep current
  if (prev === "dark") return luma < OSD_LIGHT_INK_BELOW ? "light" : "dark";
  return luma > OSD_DARK_INK_ABOVE ? "dark" : "light";
}

/** Longest edge of the readback target — a 288×~162 buffer is plenty for
 *  per-label averages and keeps the readback under ~0.2 MB. */
const RT_MAX_EDGE = 288;
/** Smallest usable target edge (degenerate 0×0 containers). */
const RT_MIN_EDGE = 32;
/** Seconds between refreshes (~5 Hz — tone flips are slow, backgrounds drift slowly). */
export const OSD_REFRESH_S = 0.2;

/** Average linear-space luminance (0..1) of the canvas-CSS-px `rect` over
 *  a bottom-up RGBA readback buffer. Pure — unit-testable. Returns -1 when
 *  the rect falls entirely outside the canvas or no pixel was sampled. */
export function averageRectLuma(
  buf: Uint8Array,
  rtW: number,
  rtH: number,
  cssW: number,
  cssH: number,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  if (buf.length === 0 || cssW === 0 || cssH === 0) return -1;
  // Clamp the rect to the canvas; nothing readable off-screen.
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(cssW, x + w);
  const y1 = Math.min(cssH, y + h);
  if (x1 <= x0 || y1 <= y0) return -1;
  const sx = rtW / cssW;
  const sy = rtH / cssH;
  const bx0 = Math.floor(x0 * sx);
  const by0 = Math.floor(y0 * sy);
  const bx1 = Math.min(rtW, Math.ceil(x1 * sx));
  const by1 = Math.min(rtH, Math.ceil(y1 * sy));
  // Cap the sample grid (~16×12) so a huge rect stays cheap.
  const stepX = Math.max(1, Math.floor((bx1 - bx0) / 16));
  const stepY = Math.max(1, Math.floor((by1 - by0) / 12));
  let sum = 0;
  let n = 0;
  for (let by = by0; by < by1; by += stepY) {
    // WebGL readback is bottom-up; the canvas rect is top-down.
    const row = (rtH - 1 - by) * rtW;
    for (let bx = bx0; bx < bx1; bx += stepX) {
      const o = (row + bx) * 4;
      sum += 0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2];
      n++;
    }
  }
  return n > 0 ? sum / (n * 255) : -1;
}

export interface OsdContrast {
  /** Re-render the scene into the readback target and pull the pixels.
   *  Returns false when the scene/renderer wasn't ready. */
  refresh(): boolean;
  /** Average scene luminance (0..1 linear) under a canvas-CSS-px rect, or
   *  -1 when nothing has been read back yet / the rect is off-canvas. */
  lumaUnder(x: number, y: number, w: number, h: number): number;
  dispose(): void;
}

/** Optional hooks for the refresh pass: `cull` runs just before the scene
 *  is rendered into the readback target and `restore` right after — the
 *  map hides the cap-letter / smoke-countdown text sprites so their own
 *  ink cannot bias the backdrop sample (a glyph covering a slice of its
 *  sampling rect nudges the average toward its current tone). */
export interface OsdContrastHooks {
  cull?: () => void;
  restore?: () => void;
}

/** Create the sampler for one map instance. The render target and pixel
 *  buffer are allocated lazily on the first refresh and re-sized when the
 *  canvas geometry drifts. */
export function createOsdContrast(
  api: Ref<ThreeScene | null>,
  container: Ref<HTMLElement | null>,
  hooks: OsdContrastHooks = {},
): OsdContrast {
  let rt: THREE.WebGLRenderTarget | null = null;
  let buf: Uint8Array = new Uint8Array(0);
  let rtW = 0;
  let rtH = 0;
  let cssW = 0;
  let cssH = 0;

  const dispose = () => {
    rt?.dispose();
    rt = null;
    buf = new Uint8Array(0);
  };

  const refresh = (): boolean => {
    const a = api.value;
    const el = container.value;
    const canvas = a?.renderer.domElement;
    if (!a || !el || !canvas) return false;
    cssW = canvas.clientWidth || 800;
    cssH = canvas.clientHeight || 600;
    // Keep the target's aspect matched to the canvas so screen rects map
    // cleanly; the downscale step quantizes the edge to stay under budget.
    const down = Math.max(2, Math.ceil(Math.max(cssW, cssH) / RT_MAX_EDGE));
    const w = Math.max(RT_MIN_EDGE, Math.floor(cssW / down));
    const h = Math.max(RT_MIN_EDGE, Math.floor(cssH / down));
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(w, h, {
        depthBuffer: true,
        stencilBuffer: false,
      });
    } else if (w !== rtW || h !== rtH) {
      rt.setSize(w, h);
    }
    rtW = w;
    rtH = h;
    if (buf.length !== w * h * 4) buf = new Uint8Array(w * h * 4);
    const prevTarget = a.renderer.getRenderTarget();
    hooks.cull?.();
    a.renderer.setRenderTarget(rt);
    a.renderer.render(a.scene, a.camera);
    a.renderer.setRenderTarget(prevTarget);
    hooks.restore?.();
    a.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    return true;
  };

  const lumaUnder = (x: number, y: number, w: number, h: number): number =>
    averageRectLuma(buf, rtW, rtH, cssW, cssH, x, y, w, h);

  return { refresh, lumaUnder, dispose };
}

/** Nominal sampled rect (canvas px) around a floating label. The label is
 *  anchored bottom-center at (x, y) (`translate: -50% -100%`), spans up to
 *  12 rem of width and ~3 text rows of height; the average over a slightly
 *  tighter box is what the ink actually sits on. */
const LABEL_RECT_W = 176;
const LABEL_RECT_H = 52;

/** Apply tones to every in-scene text: the floating DOM labels (per-label
 *  `tone`, consumed by HoloLabel's ink vars) and the cap-letter / smoke
 *  countdown sprites (repainted with the matching ink when it flips). */
export function applyOsdTones(ctx: MapInternals, osd: OsdContrast): void {
  const labels = ctx.shipLabels.value;
  for (const lbl of labels) {
    if (!lbl.visible) continue;
    const luma = osd.lumaUnder(
      lbl.x - LABEL_RECT_W / 2,
      lbl.y - LABEL_RECT_H + 4,
      LABEL_RECT_W,
      LABEL_RECT_H,
    );
    // An unknown backdrop (-1: rect fully off-canvas) must not pin a
    // first tone — leave the label theme-driven until it is measurable.
    if (luma < 0) continue;
    const tone = toneForLuma(lbl.tone, luma);
    if (tone !== lbl.tone) lbl.tone = tone;
  }
  const cam = ctx.api.value?.camera;
  const canvas = ctx.api.value?.renderer.domElement;
  if (!cam || !canvas) return;
  const vw = canvas.clientWidth;
  const vh = canvas.clientHeight;
  const spriteTone = (
    pos: THREE.Vector3,
    halfW: number,
    halfH: number,
    prev: OsdTone | undefined,
  ): OsdTone | null => {
    ctx._projVec.copy(pos);
    ctx._projVec.project(cam);
    if (ctx._projVec.z >= 1) return null;
    const sx = ctx._projVec.x * (vw / 2) + vw / 2;
    const sy = -ctx._projVec.y * (vh / 2) + vh / 2;
    const luma = osd.lumaUnder(sx - halfW, sy - halfH, halfW * 2, halfH * 2);
    return toneForLuma(prev, luma);
  };
  // Cap letters: big zone glyph (+ optional ETA line) — repaint on flip.
  // The text sprites are culled from the readback render (see the cull
  // hook), so the sample is pure backdrop; hysteresis still applies via
  // the sprite's current tone.
  for (const sprite of ctx.capLetterSprites) {
    if (!sprite.visible || !sprite.userData.canvas) continue;
    const tone = spriteTone(sprite.position, 24, 24, sprite.userData.tone as OsdTone | undefined);
    if (tone == null || tone === sprite.userData.tone) continue;
    sprite.userData.tone = tone;
    repaintCapSprite(sprite);
  }
  // Smoke countdowns: small "12s" tags over the smoke rings.
  for (const cl of ctx.smokeClusters) {
    const sprite = cl.timeSprite;
    if (!sprite || !sprite.visible || !sprite.userData.canvas) continue;
    const tone = spriteTone(sprite.position, 18, 12, sprite.userData.tone as OsdTone | undefined);
    if (tone == null || tone === sprite.userData.tone) continue;
    sprite.userData.tone = tone;
    const text = (sprite.userData.text as string | undefined) ?? "";
    if (text) {
      paintSmokeCountdown(sprite.userData.canvas as HTMLCanvasElement, text, tone);
      (sprite.material as THREE.SpriteMaterial).map!.needsUpdate = true;
    }
  }
}

/** Repaint a cap-letter sprite from its cached `text` key with the tone it
 *  now wears. The key format is owned by markerUpdate's repaint pass —
 *  `letter|etaLine|quickEta|tone` (the tone suffix keeps that pass's cache
 *  honest after a flip) — and parsing here simply ignores the 4th part, so
 *  a backdrop flip repaints immediately instead of waiting for the next
 *  playhead tick. */
export function repaintCapSprite(sprite: THREE.Sprite): void {
  const key = (sprite.userData.text as string | undefined) ?? "";
  const [letter = "", etaLine = "", quickEta = ""] = key.split("|");
  paintCapSprite(
    sprite.userData.canvas as HTMLCanvasElement,
    letter,
    quickEta || etaLine,
    (sprite.userData.tone as OsdTone | undefined) ?? "light",
  );
  (sprite.material as THREE.SpriteMaterial).map!.needsUpdate = true;
}
