/**
 * Replay-playback video/GIF export (the 录像回放 share clip).
 *
 * Renders the match's 2D full-map playback offline — faster than realtime,
 * exactly like the reference clip the feature asks for — into a framed
 * composition: a compact score header (ally/enemy points + alive counts +
 * the battle clock) over the map square, with the fixed WoWSP promo footer
 * (the share-shot watermark, shotKit's drawFooterBand) burned under it.
 * One deterministic frame pipeline feeds BOTH muxers:
 *
 *   video — WebCodecs via mediabunny through the tactical exporter's
 *           renderVideoOffline (H.264 MP4 first, VP9 WebM fallback);
 *   gif   — gifenc, per-frame quantized palette, centisecond delays.
 *
 * The caller (HolographicMap) owns the playhead: every frame first seeks
 * the shared map internals to the frame's battle time (markers, caps,
 * scores, planes all update synchronously) and paints the map through
 * minimapPainter's paintEnlargedMap onto this module's offscreen canvas —
 * never a rasterized DOM canvas, so exports stay crisp at any size.
 */
import { GIFEncoder, quantize, applyPalette } from "gifenc";

import {
  FOOT_H,
  drawFooterBand,
  font,
  footerMinWidth,
  rgba,
  type ShotFooterStrings,
  type ShotPalette,
} from "@/features/share/shotKit";
import {
  renderVideoOffline,
  type OfflineCodecChoice,
} from "./tactical/exporters";
import { TACTICAL_SIZE } from "./tactical/render";

/** Logical width of the whole composition — the map square's own edge
 *  (TACTICAL_SIZE), which paintEnlargedMap already draws in. Header and
 *  footer share the same logical space so one device scale fits all. */
export const EXPORT_LOGICAL = TACTICAL_SIZE;
/** Score-header band height in logical units (score digits + clock). */
export const EXPORT_HEADER_H = 56;

/** Export formats offered by the modal. */
export type PlaybackExportFormat = "video" | "gif";

/** The replay clip's video ladder — VP9 into MP4 first (the modern MP4
 *  combination every Chromium/ffmpeg/VLC toolchain plays: `vp09` sample
 *  entries are standard ISO BMFF), AV1 next (better compression, slower
 *  encode), H.264 as the last resort. Deliberately NOT VP8-in-MP4: the
 *  `vp08` binding exists on paper but no mainstream player decodes it
 *  (verified: Chromium `canPlayType` refuses, ffmpeg refuses to mux). */
export const PLAYBACK_CODEC_LADDER: readonly OfflineCodecChoice[] = [
  { codec: "vp9", ext: "mp4" },
  { codec: "av1", ext: "mp4" },
  { codec: "avc", ext: "mp4" },
];
/** Range options — same semantics as the tactical wizard's. */
export type PlaybackExportRange = "now" | "start";

export interface PlaybackExportSettings {
  format: PlaybackExportFormat;
  from: PlaybackExportRange;
  fps: number;
  /** Battle-time compression: each frame advances speed/fps battle
   *  seconds, so a whole match fits a shareable clip (the reference
   *  video the feature mirrors runs ≈19×). */
  speed: number;
  /** Target composition width in device px (even). */
  size: number;
  /** Burn the WoWSP share-shot footer band. */
  footer: boolean;
}

/** Frame-rate ladders per format: GIF stays coarse (size explodes fast). */
export const PLAYBACK_EXPORT_FPS: Record<PlaybackExportFormat, number[]> = {
  video: [30, 60],
  gif: [10, 15],
};
/** GIF frame budget: every frame is a full quantized bitmap held in
 *  memory until finish(), so an unbounded take (a 1× full match) would
 *  balloon past a gigabyte. The modal refuses to start past this and
 *  says how to shrink the take. */
export const GIF_MAX_FRAMES = 1200;
/** Video frame budget: mediabunny's BufferTarget also holds the whole
 *  mux in memory, so a 1× 60 fps full match (72k frames) is not a
 *  take anyone should be able to start by accident. */
export const VIDEO_MAX_FRAMES = 30000;
/** The budget for a format (the modal's start guard + warning line). */
export function exportFrameBudget(format: PlaybackExportFormat): number {
  return format === "gif" ? GIF_MAX_FRAMES : VIDEO_MAX_FRAMES;
}
/** Width ladders per format: GIF stays small for the same reason. */
export const PLAYBACK_EXPORT_SIZES: Record<PlaybackExportFormat, number[]> = {
  video: [720, 1080],
  gif: [480, 640],
};
/** Battle-time compression ladder (shared by both formats). */
export const PLAYBACK_EXPORT_SPEEDS = [1, 2, 5, 10, 20] as const;
/** Default compression per format — a full match at 1× is minutes long,
 *  which is not what a share clip is for (the reference runs ≈19×). */
export const PLAYBACK_EXPORT_DEFAULT_SPEED: Record<PlaybackExportFormat, number> = {
  video: 5,
  gif: 10,
};

/** Clamp fps/size/speed onto the ladders (format switches in the modal
 *  must not leave an alien value behind). */
export function clampExportSettings(s: PlaybackExportSettings): PlaybackExportSettings {
  const fps = PLAYBACK_EXPORT_FPS[s.format];
  const sizes = PLAYBACK_EXPORT_SIZES[s.format];
  return {
    ...s,
    fps: fps.includes(s.fps) ? s.fps : fps[0],
    size: sizes.includes(s.size) ? s.size : sizes[sizes.length - 1],
    speed: (PLAYBACK_EXPORT_SPEEDS as readonly number[]).includes(s.speed)
      ? s.speed
      : PLAYBACK_EXPORT_DEFAULT_SPEED[s.format],
  };
}

/** Frame schedule under compression: like frameTimes, but each frame
 *  advances speed/fps battle seconds (grid-snapped so float error can
 *  never produce a non-increasing pair; the last frame never passes
 *  `to`; an empty range degenerates to the single `from` frame). */
export function frameTimesAtSpeed(
  from: number,
  to: number,
  fps: number,
  speed: number,
): number[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    return Number.isFinite(from) ? [from] : [];
  }
  if (fps <= 0) return [from];
  const step = Math.max(1 / fps, speed / fps);
  const count = Math.floor((to - from) / step + 1e-9) + 1;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = from + i * step;
    out.push(t > to ? to : Number(t.toFixed(6)));
  }
  return out;
}

/** GIF frame delay in ms, snapped to GIF's centisecond grid (a 30 fps ask
 *  lands on 30 ms ≈ 33 fps; sub-10 ms delays are unreadable in most
 *  viewers, so the floor keeps slow GIFs honest). */
export function gifDelayMs(fps: number): number {
  return Math.max(20, Math.round(100 / Math.max(1, fps)) * 10);
}

export interface PlaybackExportLayout {
  /** Composition width in device px (even — codecs need it). */
  width: number;
  /** Composition height in device px (even). */
  height: number;
  /** Device px per logical unit. */
  scale: number;
  /** Device-px top edge of the map square. */
  mapTop: number;
  /** Device-px top edge of the footer band (0-height when off). */
  footerTop: number;
  /** Footer band height in device px (0 when off). */
  footerHeight: number;
}

/** Resolve the frame geometry for one export (pure — unit-tested). */
export function playbackExportLayout(
  targetWidth: number,
  footer: boolean,
): PlaybackExportLayout {
  const width = Math.max(2, Math.round(targetWidth) - (Math.round(targetWidth) % 2));
  const scale = width / EXPORT_LOGICAL;
  const mapTop = EXPORT_HEADER_H * scale;
  const footerHeight = footer ? FOOT_H * scale : 0;
  const rawH = EXPORT_HEADER_H * scale + EXPORT_LOGICAL * scale + footerHeight;
  // Even-Ceil: codecs want even heights, and rounding UP never clips the
  // map square — the ≤2px slack lands as background between the map and
  // the footer band (or at the frame's bottom edge with the footer off),
  // where nothing else paints.
  const rounded = Math.round(rawH);
  const height = rounded % 2 === 0 ? rounded : rounded + 1;
  return {
    width,
    height,
    scale,
    mapTop,
    footerTop: height - footerHeight,
    footerHeight,
  };
}

/** Score-header content for one frame — all fields derive synchronously
 *  from the seek the caller just performed. Null scores (operations) hide
 *  the digits and center the clock alone. */
export interface PlaybackHeaderData {
  /** Elapsed battle clock label ("MM:SS"). */
  clock: string;
  scoreAlly: number | null;
  scoreEnemy: number | null;
  aliveAlly: number;
  aliveEnemy: number;
  totalAlly: number;
  totalEnemy: number;
}

/** Team ink for the header's score blocks (the scorebar's green/red). */
const ALLY_INK = "74 222 128";
const ENEMY_INK = "204 51 51";

/** Draw the score header band in LOGICAL units (the caller's transform
 *  maps them onto the device canvas): ally points + alive left, the battle
 *  clock centered, enemy points + alive right — the compact cousin of the
 *  in-game top strip the reference clip shows. */
export function drawPlaybackHeader(
  g: CanvasRenderingContext2D,
  data: PlaybackHeaderData,
  palette: ShotPalette,
): void {
  const w = EXPORT_LOGICAL;
  const h = EXPORT_HEADER_H;
  g.fillStyle = rgba(palette.surface, 0.75);
  g.fillRect(0, 0, w, h);
  g.fillStyle = rgba(palette.text, 0.12);
  g.fillRect(0, h - 1, w, 1);
  g.textBaseline = "middle";
  const cy = h / 2;
  const showScores = data.scoreAlly != null && data.scoreEnemy != null;
  // Team blocks: a colored side-dot on the outer edge, the bold score and
  // the alive ratio flowing inward (explicit mirroring — a flipped
  // transform would mirror the glyphs themselves).
  const block = (score: number, alive: number, total: number, ink: string, right: boolean): void => {
    const dotX = right ? w - 24 : 24;
    const dir = right ? -1 : 1;
    g.fillStyle = rgba(ink, 0.95);
    g.beginPath();
    g.arc(dotX, cy, 5, 0, Math.PI * 2);
    g.fill();
    g.textAlign = right ? "right" : "left";
    g.font = font(26, 700);
    g.fillStyle = rgba(palette.text, 0.95);
    g.fillText(String(score), dotX + dir * 14, cy - 2);
    g.font = font(12, 400);
    g.fillStyle = rgba(palette.text, 0.55);
    g.fillText(`${alive}/${total}`, dotX + dir * 14, cy + 15);
  };
  if (showScores) {
    block(data.scoreAlly!, data.aliveAlly, data.totalAlly, ALLY_INK, false);
    block(data.scoreEnemy!, data.aliveEnemy, data.totalEnemy, ENEMY_INK, true);
  }
  // Clock: elapsed battle time, mono, dead center.
  g.textAlign = "center";
  g.font = font(20, 700, true);
  g.fillStyle = rgba(palette.text, 0.9);
  g.fillText(data.clock, w / 2, cy);
}

export interface PlaybackExportRequest {
  format: PlaybackExportFormat;
  fps: number;
  /** Frame battle times — speed-compressed (frameTimesAtSpeed): spaced
   *  speed/fps battle seconds apart. They drive WHAT is painted; the
   *  muxers' presentation clock is the uniform i / fps grid. */
  times: number[];
  /** Target composition width in device px. */
  targetWidth: number;
  footer: boolean;
  palette: ShotPalette;
  footerStrings: ShotFooterStrings;
  logo: HTMLImageElement | null;
  /** Header content at each frame's battle time. */
  header: (t: number) => PlaybackHeaderData;
  /** Paint the map square for battle time `t` in logical units onto `g`
   *  (already translated to the map's top edge and scaled). */
  paintMap: (t: number, g: CanvasRenderingContext2D) => void;
  onProgress?: (done: number, total: number) => void;
  cancelToken?: { cancelled: boolean };
}

export interface PlaybackExportResult {
  blob: Blob;
  ext: "mp4" | "webm" | "gif";
  cancelled: boolean;
}

/** Compose one full frame (header + map + footer) in device px. */
function composeFrame(
  ctx: CanvasRenderingContext2D,
  layout: PlaybackExportLayout,
  req: PlaybackExportRequest,
  t: number,
): void {
  const s = layout.scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#05080f";
  ctx.fillRect(0, 0, layout.width, layout.height);
  // Map square FIRST (logical units, translated under the header): the
  // host's paintMap SEEKS the shared map internals to `t`, and the header
  // below must read the post-seek scores/alive state — painting the
  // header before the seek would show the previous frame's numbers
  // (verifier catch). The bands never overlap the map, so the order is
  // only about data freshness, not z-index.
  ctx.save();
  ctx.translate(0, layout.mapTop);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.rect(0, 0, EXPORT_LOGICAL, EXPORT_LOGICAL);
  ctx.clip();
  req.paintMap(t, ctx);
  ctx.restore();
  // Header band (logical units).
  ctx.save();
  ctx.scale(s, s);
  drawPlaybackHeader(ctx, req.header(t), req.palette);
  ctx.restore();
  // Footer band (logical units, share-shot geometry). Wordy locales can
  // need a wider band than the map square (footerMinWidth measures the
  // three text blocks) — the content then scales DOWN into the fixed band
  // instead of colliding, mirroring how share shots widen their canvas.
  // The band's own background is pre-filled at the exact geometry so the
  // scaled-down band leaves no gap at the bottom edge.
  if (layout.footerHeight > 0) {
    const footerLogical = Math.max(
      EXPORT_LOGICAL,
      footerMinWidth(req.footerStrings, req.logo != null),
    );
    const fit = (EXPORT_LOGICAL / footerLogical) * s;
    ctx.save();
    ctx.translate(0, layout.footerTop);
    ctx.scale(fit, fit);
    drawFooterBand(ctx, req.palette, footerLogical, 0, req.footerStrings, req.logo);
    ctx.restore();
    // A downscaled band (wordy locale) ends short of the frame's bottom
    // edge — fill ONLY that shortfall strip, after the band: pre-filling
    // the whole band would double-blend the 0.75 surface wash the band
    // paints itself (verifier catch).
    const bandBottom = layout.footerTop + FOOT_H * fit;
    if (bandBottom < layout.height - 0.5) {
      ctx.fillStyle = rgba(req.palette.surface, 0.75);
      ctx.fillRect(0, bandBottom, layout.width, layout.height - bandBottom);
    }
  }
}

/** Run the export. Resolves null only when the VIDEO path finds no
 *  WebCodecs codec (the caller surfaces "unsupported"); a cancelled run
 *  resolves with cancelled: true and whatever was encoded so far. */
export async function renderPlaybackExport(
  req: PlaybackExportRequest,
): Promise<PlaybackExportResult | null> {
  const layout = playbackExportLayout(req.targetWidth, req.footer);

  if (req.format === "video") {
    // Battle times drive WHAT is painted; the PTS grid is the clip's own
    // uniform clock (i / fps) — under speed compression the two differ,
    // and feeding battle times as PTS would stretch a 10× take back into
    // a full-length video (verifier catch).
    const pts: number[] = req.times.map((_, i) => i / req.fps);
    const result = await renderVideoOffline({
      fps: req.fps,
      times: req.times,
      width: layout.width,
      height: layout.height,
      frameTimestamps: pts,
      // VP9 → AV1 → AVC, all inside MP4 (see PLAYBACK_CODEC_LADDER).
      codecLadder: PLAYBACK_CODEC_LADDER,
      paintAt: (t, g) => {
        // The exporter's canvas is our canvas — compose straight into it.
        composeFrame(g, layout, req, t);
      },
      onProgress: req.onProgress,
      cancelToken: req.cancelToken,
    });
    if (!result) return null;
    return { blob: result.blob, ext: result.ext, cancelled: result.cancelled };
  }

  // GIF: gifenc with a per-frame local palette (the map's colors drift
  // with weather/smoke; one global palette would band late-game frames).
  // The compose canvas belongs to THIS branch — the video path composes
  // straight into the muxer's own canvas.
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const gif = GIFEncoder();
  const delay = gifDelayMs(req.fps);
  let encoded = 0;
  for (let i = 0; i < req.times.length; i++) {
    if (req.cancelToken?.cancelled === true) break;
    const t = req.times[i];
    composeFrame(ctx, layout, req, t);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const palette = quantize(data, 256, { format: "rgb565" });
    const index = applyPalette(data, palette, "rgb565");
    gif.writeFrame(index, canvas.width, canvas.height, { palette, delay });
    encoded++;
    req.onProgress?.(i + 1, req.times.length);
    // Sync quantize bursts starve the UI thread — yield every few frames
    // so the progress chip keeps painting and cancel stays responsive.
    if (i % 3 === 2) await new Promise((r) => setTimeout(r, 0));
  }
  if (encoded === 0) {
    return { blob: new Blob([], { type: "image/gif" }), ext: "gif", cancelled: true };
  }
  gif.finish();
  // Copy into a plain ArrayBuffer-backed view — TS's BlobPart wants
  // ArrayBuffer (not ArrayBufferLike) and gifenc returns the shared
  // backing view.
  const written = gif.bytes();
  const bytes = new Uint8Array(written.length);
  bytes.set(written);
  return {
    blob: new Blob([bytes.buffer], { type: "image/gif" }),
    ext: "gif",
    cancelled: req.cancelToken?.cancelled === true,
  };
}

