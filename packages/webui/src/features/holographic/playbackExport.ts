/**
 * Replay-playback video/GIF export (the 录像回放 share clip).
 *
 * Renders the match's 2D full-map playback offline — faster than realtime,
 * exactly like the reference clip the feature asks for — into a framed
 * composition that mirrors the in-game replay HUD:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ score header: ally pts · caps · clock · enemy │
 *   ├──────────┬──────────────────────────┬────────┤
 *   │ ally     │                          │ enemy  │
 *   │ team HP  │   map square (the same   │ team HP│
 *   │ rows     │   enlarged-map painter)  │ rows   │
 *   │ ──────── │  ship labels over every  │ ───────│
 *   │ recorder │        glyph             │ chat   │
 *   │ damage   │                          │ log    │
 *   ├──────────┴──────────────────────────┴────────┤
 *   │ the fixed WoWSP promo footer (share shots)   │
 *   └──────────────────────────────────────────────┘
 *
 * One deterministic frame pipeline feeds BOTH muxers:
 *
 *   video — WebCodecs via mediabunny through the tactical exporter's
 *           renderVideoOffline (this clip's ladder: VP9 into MP4, then
 *           AV1, then H.264 — see PLAYBACK_CODEC_LADDER);
 *   gif   — gifenc, per-frame quantized palette, centisecond delays.
 *
 * The caller (HolographicMap) owns the playhead: every frame first seeks
 * the shared map internals to the frame's battle time (markers, caps,
 * scores, planes, team rows all update synchronously), paints the map
 * through minimapPainter's paintEnlargedMap, and only THEN reads the
 * panel/header data — so every band shows this frame's state.
 */
import { GIFEncoder, quantize, applyPalette } from "gifenc";

import {
  FOOT_H,
  drawFooterBand,
  ellipsize,
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

/** Logical edge of the map square — paintEnlargedMap draws in this space. */
export const EXPORT_LOGICAL = TACTICAL_SIZE;
/** Logical width of one side column (team HP list + damage/chat panel). */
export const EXPORT_SIDE_W = 190;
/** Logical width of the whole composition (map square plus both columns). */
export const EXPORT_TOTAL_LOGICAL = EXPORT_LOGICAL + EXPORT_SIDE_W * 2;
/** Header band height in logical units: the scorebar pill row (score ·
 *  cap chips · score), the battle clock UNDER the caps (the live app reads
 *  the time from the transport bar; a clip needs it visible, and beside
 *  the chips it crowded them), then the ship-icon strip row. */
export const EXPORT_HEADER_H = 112;
/** Team-list portion of a side column; the rest is damage (left) or the
 *  chat log (right). */
export const EXPORT_TEAM_H = 452;

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
/** The export settings; `from`/`to` are the range ribbon's window, in
 *  battle seconds. */
export interface PlaybackExportSettings {
  format: PlaybackExportFormat;
  /** Window start, battle seconds. */
  from: number;
  /** Window end, battle seconds (clamped to an end > from at job time). */
  to: number;
  fps: number;
  /** Battle-time compression: each frame advances speed/fps battle
   *  seconds, so a whole match fits a shareable clip. */
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
export const GIF_MAX_FRAMES = 1500;
/** Video frame budget: mediabunny's BufferTarget also holds the whole
 *  mux in memory, so a 1× 60 fps full match (72k frames) is not a
 *  take anyone should be able to start by accident. */
export const VIDEO_MAX_FRAMES = 30000;
/** The budget for a format (the modal's start guard + warning line). */
export function exportFrameBudget(format: PlaybackExportFormat): number {
  return format === "gif" ? GIF_MAX_FRAMES : VIDEO_MAX_FRAMES;
}

/** Longest battle span the format's frame budget allows, in battle seconds
 *  (frameTimesAtSpeed is endpoint-inclusive: frames = span·fps/speed + 1). */
export function exportMaxSpan(
  format: PlaybackExportFormat,
  fps: number,
  speed: number,
): number {
  const step = Math.max(1e-6, speed / Math.max(1, fps));
  return Math.max(step, (exportFrameBudget(format) - 1) * step);
}

/** Clamp a window's end so the take fits the budget. GIF auto-shrinks (the
 *  range ribbon短ens itself, 2026-11-20 request); video keeps the explicit
 *  refusal instead, so its end is left untouched here. */
export function clampRangeToBudget(
  from: number,
  to: number,
  format: PlaybackExportFormat,
  fps: number,
  speed: number,
): number {
  if (format !== "gif") return to;
  return Math.min(to, from + exportMaxSpan(format, fps, speed));
}
/** Width ladders per format: the HUD composition needs width for its side
 *  columns, so video starts at 1080 (1440 default — the map text goes
 *  blurry at 1080's 720px map square); GIF stays small for size reasons. */
export const PLAYBACK_EXPORT_SIZES: Record<PlaybackExportFormat, number[]> = {
  video: [1080, 1440, 1920],
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
 *  must not leave an alien value behind). The from/to window is NOT a
 *  ladder value — the job normalizes it against the replay's duration. */
export function clampExportSettings(s: PlaybackExportSettings): PlaybackExportSettings {
  const fps = PLAYBACK_EXPORT_FPS[s.format];
  const sizes = PLAYBACK_EXPORT_SIZES[s.format];
  return {
    ...s,
    fps: fps.includes(s.fps) ? s.fps : fps[0],
    size: sizes.includes(s.size) ? s.size : sizes[0],
    speed: (PLAYBACK_EXPORT_SPEEDS as readonly number[]).includes(s.speed)
      ? s.speed
      : PLAYBACK_EXPORT_DEFAULT_SPEED[s.format],
  };
}

/** Normalize a raw settings window against the replay: finite, ordered,
 *  inside [0, duration], at least one frame long, GIF capped to its budget.
 *  Both the modal (estimate) and the job (the actual take) run this, so
 *  what the user reads is exactly what gets rendered. */
export function normalizeExportRange(
  from: number,
  to: number,
  duration: number,
  format: PlaybackExportFormat,
  fps: number,
  speed: number,
): { from: number; to: number } {
  const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;
  let a = Number.isFinite(from) ? Math.min(Math.max(0, from), dur) : 0;
  let b = Number.isFinite(to) ? Math.min(Math.max(0, to), dur) : dur;
  if (b < a) [a, b] = [b, a];
  // The ribbon can hand back a hairline window (a stray click); the export
  // always covers at least one frame step.
  const minSpan = Math.max(1e-3, speed / Math.max(1, fps));
  if (b - a < minSpan) b = Math.min(dur, a + minSpan);
  return { from: a, to: clampRangeToBudget(a, b, format, fps, speed) };
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
  /** Device-px left edge of the map square (right edge of the ally
   *  column). */
  mapLeft: number;
  /** Device-px top edge of the map square. */
  mapTop: number;
  /** Map square edge in device px. */
  mapSize: number;
  /** Device-px top edge of the footer band (0-height when off). */
  footerTop: number;
  /** Footer band height in device px (0 when off). */
  footerHeight: number;
}

/** Resolve the frame geometry for one export (pure — unit-tested). The
 *  user-facing "resolution" is the composition width; the map square and
 *  side columns derive from it through the shared logical space. */
export function playbackExportLayout(
  targetWidth: number,
  footer: boolean,
): PlaybackExportLayout {
  const width = Math.max(2, Math.round(targetWidth) - (Math.round(targetWidth) % 2));
  const scale = width / EXPORT_TOTAL_LOGICAL;
  const mapTop = EXPORT_HEADER_H * scale;
  const footerHeight = footer ? FOOT_H * scale : 0;
  const rawH = (EXPORT_HEADER_H + EXPORT_LOGICAL + (footer ? FOOT_H : 0)) * scale;
  // Even-Ceil: codecs want even heights, and rounding UP never clips the
  // map square — the ≤2px slack lands as background between the map and
  // the footer band (or at the frame's bottom edge with the footer off),
  // where nothing else paints.
  const ceil = Math.ceil(rawH);
  const height = ceil % 2 === 0 ? ceil : ceil + 1;
  return {
    width,
    height,
    scale,
    mapLeft: EXPORT_SIDE_W * scale,
    mapTop,
    mapSize: EXPORT_LOGICAL * scale,
    footerTop: height - footerHeight,
    footerHeight,
  };
}

/** Capture-point chip for the header — the HoloScorebar's CapChip mirrored
 *  onto canvas (square when held, diamond + progress ring while capturing). */
export interface PlaybackCapChip {
  letter: string;
  owner: "ally" | "enemy" | "neutral";
  /** 0..1 capture progress. */
  progress: number;
  capturing: boolean;
  contested: boolean;
  /** The side ACCRUING the capture — the progress ring's colour (the
   *  scorebar's --holo-captureSide rule); falls back to the owner. */
  captureSide?: "ally" | "enemy";
}

/** One ship-icon slot of the header strip (the scorebar's HoloShip, cut
 *  down to what a canvas slot draws). */
export interface PlaybackShipSlot {
  role: "ally" | "enemy";
  shipType: string | null;
  dead: boolean;
  /** 0..1, or null when unknown (no bar). */
  hpFrac: number | null;
}

export interface PlaybackHeaderData {
  /** Elapsed battle clock label ("MM:SS"). */
  clock: string;
  scoreAlly: number | null;
  scoreEnemy: number | null;
  caps: PlaybackCapChip[];
  /** Strip slots, allies first then enemies (the scorebar's own order). */
  ships: PlaybackShipSlot[];
}

/** Ship-class HUD icon variant for a strip slot (the scorebar's direction
 *  contract: each side carries its own face, dead ships their own sunk
 *  face — casualties never flip direction). */
export type PlaybackIconVariant = "ally" | "enemy" | "sunk" | "sunk-enemy";

/** One team-list row for a side column. */
export interface PlaybackTeamRow {
  name: string;
  /** Clan tag WITHOUT brackets (rendered as `[TAG] name`), or null. */
  clan?: string | null;
  shipName: string;
  /** 0..1, or null when unknown (row dims instead of a bar). */
  hpFrac: number | null;
  dead: boolean;
}

export interface PlaybackRecorderStats {
  damage: number;
  frags: number;
  taken: number;
}

export interface PlaybackChatLine {
  sender: string;
  side: "ally" | "enemy";
  text: string;
  /** Battle seconds, rendered as [MM:SS]. */
  time: number;
}

/** Team ink — the scorebar's own tokens (--holo-ally #4ade80, --holo-enemy
 *  #f87171, neutral white) so the clip's HUD matches the app verbatim. */
const ALLY_INK = "74 222 128";
const ENEMY_INK = "248 113 113";
const NEUTRAL_INK = "255 255 255";
const HP_GOOD = "74 222 128";
const HP_MID = "251 191 36";
const HP_LOW = "248 92 92";

/** Draw text fitted into `maxW`: the face shrinks down to `minSize`
 *  instead of the string being ellipsized — a clipped player name reads as
 *  a different player, so names are never truncated (2026-11-20 report). */
function fillFit(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  size: number,
  weight = 400,
  mono = false,
  minSize = 8.5,
): void {
  let s = size;
  g.font = font(s, weight, mono);
  while (s > minSize && g.measureText(text).width > maxW) {
    s = Math.max(minSize, s - 0.5);
    g.font = font(s, weight, mono);
  }
  // At the floor, ellipsize as the last resort — an overflowing name
  // would paint over the ship-name column.
  g.fillText(ellipsize(g, text, maxW), x, y);
}

function hpInk(frac: number): string {
  return frac > 0.55 ? HP_GOOD : frac > 0.25 ? HP_MID : HP_LOW;
}

function ownerInk(owner: PlaybackCapChip["owner"]): string {
  return owner === "ally" ? ALLY_INK : owner === "enemy" ? ENEMY_INK : NEUTRAL_INK;
}

function slotInk(role: "ally" | "enemy"): string {
  return role === "ally" ? ALLY_INK : ENEMY_INK;
}

/** Strip icon variant for one ship slot (the scorebar's shipIconUrlFor). */
function slotVariant(role: "ally" | "enemy", dead: boolean): PlaybackIconVariant {
  if (dead) return role === "enemy" ? "sunk-enemy" : "sunk";
  return role === "enemy" ? "enemy" : "ally";
}

/** Draw the header band in LOGICAL units across the WHOLE composition
 *  width: the app’s HoloScorebar replicated on canvas — the grey glass
 *  pill (ally score · cap chips · clock · enemy score) over the game-HUD
 *  ship-icon strip (allies left, enemies right, sunk greyed, hurt hulls
 *  carry the thin team-coloured bar). `shipIconFor` resolves the
 *  preloaded class icons; a null image skips the slot (broken-image
 *  glyphs never render). */
export function drawPlaybackHeader(
  g: CanvasRenderingContext2D,
  data: PlaybackHeaderData,
  palette: ShotPalette,
  shipIconFor: (shipType: string | null, variant: PlaybackIconVariant) => HTMLImageElement | null,
): void {
  const w = EXPORT_TOTAL_LOGICAL;
  const h = EXPORT_HEADER_H;
  g.fillStyle = rgba(palette.surface, 0.75);
  g.fillRect(0, 0, w, h);
  g.textBaseline = "middle";
  const pillH = 44;
  const pillY = 6;
  const pillCy = pillY + pillH / 2;
  // ── Pill content metrics ─────────────────────────────────────
  const chipSize = 26;
  const chipGap = 6;
  const groupGap = 24;
  const dotR = 4;
  const scoreFont = font(20, 700);
  g.font = scoreFont;
  const scoreW = (s: number): number => g.measureText(String(s)).width;
  const chips = data.caps.slice(0, 5);
  const capsW = chips.length * chipSize + Math.max(0, chips.length - 1) * chipGap;
  const showScores = data.scoreAlly != null && data.scoreEnemy != null;
  const allyScoreW = showScores ? Math.max(scoreW(data.scoreAlly!), 33) + dotR * 2 + 6 : 0;
  const enemyScoreW = showScores ? Math.max(scoreW(data.scoreEnemy!), 33) + dotR * 2 + 6 : 0;
  const contentW =
    (showScores ? allyScoreW + groupGap : 0) +
    (chips.length ? capsW + groupGap : 0) +
    (showScores ? groupGap + enemyScoreW : 0);
  const padX = 22;
  const pillW = contentW + padX * 2;
  const pillX = (w - pillW) / 2;
  // ── Pill chrome (the scorebar’s grey glass) ──────────────────────────
  g.beginPath();
  g.roundRect(pillX, pillY, pillW, pillH, 18);
  g.fillStyle = rgba(palette.surface, 0.6);
  g.fill();
  g.strokeStyle = rgba(palette.text, 0.22);
  g.lineWidth = 1;
  g.stroke();
  // ── Pill content, flowing left→right (explicit mirroring: no flipped
  //    transform, or the glyphs themselves would mirror) ───────
  let cx = pillX + padX;
  const scoreBlock = (score: number, ink: string, side: "ally" | "enemy"): void => {
    const right = side === "enemy";
    const blockW = right ? enemyScoreW : allyScoreW;
    g.fillStyle = rgba(ink, 0.95);
    g.beginPath();
    const dotX = right ? cx + blockW - dotR : cx + dotR;
    g.arc(dotX, pillCy, dotR, 0, Math.PI * 2);
    g.fill();
    g.font = scoreFont;
    g.fillStyle = rgba(ink, 0.98);
    g.textAlign = right ? "right" : "left";
    const tx = right ? cx + blockW - dotR * 2 - 6 : cx + dotR * 2 + 6;
    g.fillText(String(score), tx, pillCy);
  };
  if (showScores) scoreBlock(data.scoreAlly!, ALLY_INK, "ally");
  if (showScores) cx += allyScoreW + groupGap;
  // Cap chips: idle = square stroke (roomier letter), capturing/
  // contested = the diamond with the capture-side progress ring — the
  // scorebar’s CapChip geometry, path-identical.
  for (const cap of chips) {
    const ink = ownerInk(cap.owner);
    const ringInk = ownerInk(cap.captureSide ?? cap.owner);
    const active = cap.capturing || cap.contested;
    const x0 = cx;
    const y0 = pillCy - chipSize / 2;
    const k = chipSize / 30;
    if (active) {
      // Diamond outline (30-unit viewBox scaled to chipSize): starts at
      // the TOP corner, runs clockwise; tint fill + owner outline.
      const diamond = new Path2D(
        "M " + 15 * k + " " + 1.5 * k +
        " L " + 28.5 * k + " " + 15 * k +
        " L " + 15 * k + " " + 28.5 * k +
        " L " + 1.5 * k + " " + 15 * k + " Z",
      );
      g.save();
      g.translate(x0, y0);
      g.fillStyle = rgba(ink, 0.18);
      g.fill(diamond);
      g.strokeStyle = rgba(ink, 0.95);
      g.lineWidth = 2.4 * k;
      g.stroke(diamond);
      // Progress ring: the SAME path, dash segment from the top corner —
      // the scorebar's single-uniform-ring rule (outline and ring share
      // one stroke width, so the ring reads as the outline lighting up).
      const progress = Math.min(1, Math.max(0, cap.progress));
      const ring = 4 * Math.hypot(13.5 * k, 13.5 * k);
      g.strokeStyle = rgba(ringInk, 0.95);
      g.lineWidth = 2.4 * k;
      g.setLineDash([ring * progress, ring]);
      g.stroke(diamond);
      g.setLineDash([]);
      // Letter: white on the tinted diamond, thin black keyline.
      g.font = font(12, 800);
      g.textAlign = "center";
      g.lineWidth = 1.3;
      g.strokeStyle = "rgba(0, 0, 0, 0.85)";
      g.strokeText(cap.letter, chipSize / 2, chipSize / 2 + 1);
      g.fillStyle = "rgba(255, 255, 255, 0.95)";
      g.fillText(cap.letter, chipSize / 2, chipSize / 2 + 1);
      g.restore();
    } else {
      // Idle square (5..25 of the 30-unit box) + owner letter.
      g.strokeStyle = rgba(ink, 0.9);
      g.lineWidth = 2.4 * k;
      g.strokeRect(x0 + 5 * k, y0 + 5 * k, 20 * k, 20 * k);
      g.font = font(12, 800);
      g.textAlign = "center";
      g.fillStyle = rgba(ink, 0.95);
      g.fillText(cap.letter, x0 + chipSize / 2, y0 + chipSize / 2 + 1);
    }
    cx += chipSize + chipGap;
  }
  if (chips.length) cx += groupGap - chipGap;
  if (showScores) {
    cx += groupGap;
    scoreBlock(data.scoreEnemy!, ENEMY_INK, "enemy");
  }
  // Clock UNDER the caps (the 2026-11-20 report: beside the chips it
  // crowded the third cap). Mono, centered, export-only — the app reads
  // the time off its transport bar.
  const clockCy = pillY + pillH + 12;
  g.font = font(17, 700, true);
  g.fillStyle = rgba(palette.text, 0.92);
  g.textAlign = "center";
  g.fillText(data.clock, w / 2, clockCy);
  // ── Ship-icon strip row (the scorebar’s __ships) ───────────────
  const stripTop = pillY + pillH + 24;
  g.fillStyle = rgba(palette.text, 0.12);
  g.fillRect(0, stripTop, w, 1);
  const stripCy = (stripTop + h) / 2;
  const iconSize = 15;
  const iconGap = 2;
  const sepGap = 8;
  const allies = data.ships.filter((s) => s.role !== "enemy");
  const enemies = data.ships.filter((s) => s.role === "enemy");
  const sepW = allies.length && enemies.length ? 1 + sepGap * 2 : 0;
  const stripW =
    data.ships.length * iconSize + Math.max(0, data.ships.length - 1) * iconGap + sepW;
  let ix = (w - stripW) / 2;
  const drawSlot = (slot: PlaybackShipSlot): void => {
    if (allies.length && enemies.length && slot.role === "enemy" && ix - (w - stripW) / 2 <= allies.length * (iconSize + iconGap)) {
      // The team divider: a single hairline tick between the fleets.
      g.fillStyle = rgba(palette.text, 0.3);
      g.fillRect(ix + sepGap - 0.5, stripCy - iconSize / 2, 1, iconSize);
      ix += sepW;
    }
    const img = shipIconFor(slot.shipType, slotVariant(slot.role, slot.dead));
    if (img) {
      const hurt = !slot.dead && slot.hpFrac != null && slot.hpFrac < 1;
      g.save();
      if (slot.dead) {
        g.globalAlpha = 0.55;
        g.filter = "grayscale(0.85)";
      }
      // Letterbox into the 15px slot (object-fit: contain, the DOM
      // scorebar's rule) — the class art is a wide glyph, a square draw
      // would stretch it ~1.8x vertically.
      const natW = img.naturalWidth || iconSize;
      const natH = img.naturalHeight || iconSize;
      const fit = Math.min(iconSize / natW, iconSize / natH);
      const dw = natW * fit;
      const dh = natH * fit;
      g.drawImage(
        img,
        ix + (iconSize - dw) / 2,
        stripCy - iconSize / 2 + (iconSize - dh) / 2,
        dw,
        dh,
      );
      g.restore();
      // Hurt-only mini bar under the icon (full hulls hide it, sunk slots
      // read through the greyed icon — the game strip’s rule).
      if (hurt) {
        g.fillStyle = rgba(palette.text, 0.18);
        g.fillRect(ix, stripCy + iconSize / 2 + 2, iconSize, 2.5);
        g.fillStyle = rgba(slotInk(slot.role), 0.9);
        g.fillRect(ix, stripCy + iconSize / 2 + 2, iconSize * Math.min(1, Math.max(0, slot.hpFrac!)), 2.5);
      }
    }
    ix += iconSize + iconGap;
  };
  allies.forEach((s) => drawSlot(s));
  enemies.forEach((s) => drawSlot(s));
  // Bottom hairline closes the band.
  g.fillStyle = rgba(palette.text, 0.12);
  g.fillRect(0, h - 1, w, 1);
}
/** The side column's shared backing: translucent panel over the full map
 *  height plus the inner hairline that separates it from the map. */
function drawColumnBase(
  g: CanvasRenderingContext2D,
  x: number,
  w: number,
  top: number,
  h: number,
  palette: ShotPalette,
  hairlineAt: "left" | "right",
): void {
  g.fillStyle = rgba(palette.surface, 0.75);
  g.fillRect(x, top, w, h);
  g.fillStyle = rgba(palette.text, 0.12);
  const hx = hairlineAt === "left" ? x : x + w - 1;
  g.fillRect(hx, top, 1, h);
}

/** The team-list half of a side column: title row with the side ink, then
 *  one row per ship — player name (bold, side ink, dims when dead) and
 *  the ship name beside a fraction-colored HP bar. */
function drawTeamList(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  rows: PlaybackTeamRow[],
  ink: string,
  title: string,
  palette: ShotPalette,
): void {
  g.textBaseline = "middle";
  g.fillStyle = rgba(ink, 0.95);
  g.beginPath();
  g.arc(x + 14, y + 14, 4.5, 0, Math.PI * 2);
  g.fill();
  g.textAlign = "left";
  g.font = font(13, 700);
  g.fillStyle = rgba(palette.text, 0.92);
  g.fillText(title, x + 26, y + 14);
  const alive = rows.filter((r) => !r.dead).length;
  g.font = font(11, 400);
  g.fillStyle = rgba(palette.text, 0.55);
  g.textAlign = "right";
  g.fillText(`${alive}/${rows.length}`, x + w - 10, y + 14);
  if (rows.length === 0) return;
  const rowH = 34;
  let ry = y + 36;
  for (const row of rows) {
    if (ry + rowH > y + EXPORT_TEAM_H) break;
    const dim = row.dead ? 0.35 : 1;
    g.textAlign = "left";
    // Names read as ordinary text (white on the dark clip), NOT team
    // colours — the HP bar and side title already carry the team; a
    // green/red name was unreadable on the dark panel.
    g.fillStyle = rgba(palette.text, 0.92 * dim);
    const display = row.clan ? `[${row.clan}] ${row.name}` : row.name;
    fillFit(g, display, x + 10, ry + 8, w - 96, 11, 700);
    g.font = font(10, 400);
    g.fillStyle = rgba(palette.text, 0.5 * dim);
    g.textAlign = "right";
    g.fillText(ellipsize(g, row.shipName, 60), x + w - 10, ry + 8);
    if (row.hpFrac != null && !row.dead) {
      g.fillStyle = rgba(palette.text, 0.14);
      g.fillRect(x + 10, ry + 18, w - 20, 5);
      g.fillStyle = rgba(hpInk(row.hpFrac), 0.95);
      g.fillRect(x + 10, ry + 18, (w - 20) * Math.min(1, Math.max(0, row.hpFrac)), 5);
    } else {
      g.fillStyle = rgba(palette.text, 0.1);
      g.fillRect(x + 10, ry + 18, w - 20, 5);
    }
    ry += rowH;
  }
}

/** One stat badge: rounded tint square with a vector glyph — the live
 *  self-stats plaque's icon row (damage burst / frags skull / shield),
 *  drawn by hand because canvas cannot host the lucide components. */
function drawStatBadge(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  ink: string,
  glyph: "burst" | "frag" | "shield",
): void {
  g.save();
  g.fillStyle = rgba(ink, 0.18);
  g.beginPath();
  g.roundRect(x, y, size, size, Math.max(3, size * 0.24));
  g.fill();
  g.strokeStyle = rgba(ink, 0.9);
  g.fillStyle = rgba(ink, 0.95);
  g.lineWidth = 1.3;
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size * 0.26;
  if (glyph === "burst") {
    // Four-point hit burst: two crossing blades.
    g.beginPath();
    g.moveTo(cx - r, cy - r);
    g.lineTo(cx + r, cy + r);
    g.moveTo(cx + r, cy - r);
    g.lineTo(cx - r, cy + r);
    g.stroke();
  } else if (glyph === "frag") {
    // Skull: round cranium + two eye dots.
    g.beginPath();
    g.arc(cx, cy - size * 0.06, size * 0.22, Math.PI * 0.9, Math.PI * 2.1);
    g.stroke();
    g.beginPath();
    g.arc(cx - size * 0.08, cy + size * 0.04, size * 0.035, 0, Math.PI * 2);
    g.arc(cx + size * 0.08, cy + size * 0.04, size * 0.035, 0, Math.PI * 2);
    g.fill();
  } else {
    // Shield: pointed crest.
    g.beginPath();
    g.moveTo(cx, cy - r);
    g.lineTo(cx + r * 0.85, cy - r * 0.45);
    g.lineTo(cx + r * 0.6, cy + r * 0.6);
    g.lineTo(cx, cy + r);
    g.lineTo(cx - r * 0.6, cy + r * 0.6);
    g.lineTo(cx - r * 0.85, cy - r * 0.45);
    g.closePath();
    g.stroke();
  }
  g.restore();
}

/** The recorder's damage block (left column bottom): a title with the
 *  damage badge, the total big and bold, then the frags / taken rows —
 *  each carrying its own badge (the 2026-11-20 「徽章缺失」 report). */
function drawRecorderPanel(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  stats: PlaybackRecorderStats,
  palette: ShotPalette,
  labels: { title: string; frags: string; taken: string },
): void {
  g.textBaseline = "middle";
  g.textAlign = "left";
  const badge = 15;
  drawStatBadge(g, x + 10, y + 7, badge, "255 180 60", "burst");
  g.font = font(12, 700);
  g.fillStyle = rgba(palette.text, 0.72);
  g.fillText(labels.title, x + 10 + badge + 7, y + 14);
  g.font = font(28, 700, true);
  g.fillStyle = rgba(palette.text, 0.96);
  g.fillText(stats.damage.toLocaleString("en-US"), x + 10, y + 50);
  const rowY = (i: number): number => y + 82 + i * 26;
  drawStatBadge(g, x + 10, rowY(0) - badge / 2, badge, "248 92 92", "frag");
  g.font = font(11, 400);
  g.fillStyle = rgba(palette.text, 0.62);
  g.fillText(labels.frags, x + 10 + badge + 7, rowY(0));
  g.font = font(11, 700, true);
  g.fillStyle = rgba(palette.text, 0.9);
  g.textAlign = "right";
  g.fillText(String(stats.frags), x + w - 10, rowY(0));
  drawStatBadge(g, x + 10, rowY(1) - badge / 2, badge, "120 160 255", "shield");
  g.font = font(11, 400);
  g.fillStyle = rgba(palette.text, 0.62);
  // Labels stay left-aligned; only the VALUE columns are right-aligned.
  g.textAlign = "left";
  g.fillText(labels.taken, x + 10 + badge + 7, rowY(1));
  g.font = font(11, 700, true);
  g.fillStyle = rgba(palette.text, 0.9);
  // The value column hugs the right inset (it must not start there and run
  // rightward out of the panel).
  g.textAlign = "right";
  g.fillText(stats.taken.toLocaleString("en-US"), x + w - 10, rowY(1));
  // Hand the alignment back to the callers (left) for the next pass.
  g.textAlign = "left";
}

/** The chat log (right column bottom): the most recent entries drawn from
 *  the bottom edge upward, TWO rows each — [MM:SS] sender on the first
 *  line, the message on the second (the 2026-11-20 layout report). */
function drawChatPanel(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  lines: PlaybackChatLine[],
  palette: ShotPalette,
  title: string,
): void {
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.font = font(12, 700);
  g.fillStyle = rgba(palette.text, 0.6);
  g.fillText(title, x + 10, y + 14);
  const entryH = 34;
  const max = Math.max(0, Math.floor((h - 44) / entryH));
  const shown = lines.slice(-max);
  let ly = y + h - 20 - (shown.length - 1) * entryH;
  for (const line of shown) {
    const mm = Math.floor(line.time / 60);
    const ss = Math.floor(line.time % 60);
    const stamp = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    // Row 1: time + sender (sender tinted by side; the time muted).
    g.font = font(10, 400, true);
    g.fillStyle = rgba(palette.text, 0.45);
    g.fillText(stamp, x + 10, ly);
    const ink = line.side === "enemy" ? ENEMY_INK : ALLY_INK;
    g.font = font(10, 700);
    g.fillStyle = rgba(ink, 0.9);
    fillFit(g, line.sender, x + 46, ly, w - 56, 10, 700);
    // Row 2: the message, full width.
    g.font = font(10, 400);
    g.fillStyle = rgba(palette.text, 0.9);
    g.fillText(ellipsize(g, line.text, w - 20), x + 10, ly + 15);
    ly += entryH;
  }
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
  /** Header content at each frame's battle time (read AFTER the seek). */
  header: (t: number) => PlaybackHeaderData;
  /** Team rows per side at each frame's battle time (read AFTER the seek). */
  team: (t: number) => { allies: PlaybackTeamRow[]; enemies: PlaybackTeamRow[] };
  /** The recorder's damage/frags/taken at each battle time. */
  recorder: (t: number) => PlaybackRecorderStats | null;
  /** Chat lines up to each battle time, oldest first. */
  chat: (t: number) => PlaybackChatLine[];
  /** Ship-class HUD icon resolver for the header strip — the caller
   *  preloads (decodes) every class×variant once before the render loop.
   *  Return null to skip a slot. */
  shipIconFor: (shipType: string | null, variant: PlaybackIconVariant) => HTMLImageElement | null;
  /** Paint the map square for battle time `t` in logical units onto `g`
   *  (already translated to the map's top-left corner and scaled). */
  paintMap: (t: number, g: CanvasRenderingContext2D) => void;
  /** Panel/header word bundle (caller i18n's every word). */
  panelLabels: PlaybackPanelLabels;
  onProgress?: (done: number, total: number) => void;
  /** Coarse phase for the progress card: frames vs the encoder/muxer
   *  flush (the latter reports no percentage — the card goes
   *  indeterminate instead of sitting frozen at 100%). */
  onPhase?: (phase: "render" | "finalize") => void;
  cancelToken?: { cancelled: boolean };
}

export interface PlaybackExportResult {
  blob: Blob;
  /** Container of the produced file. `webm` is inherited from the shared
   *  exporter's type — this clip's ladder only ever yields mp4 (or gif). */
  ext: "mp4" | "webm" | "gif";
  cancelled: boolean;
}

/** Panel/header word bundle (caller i18n's every word). */
export interface PlaybackPanelLabels {
  teamAlly: string;
  teamEnemy: string;
  damage: string;
  dmgFrags: string;
  dmgTaken: string;
  chat: string;
}

/** Compose one full frame (header + map + side panels + footer) in device
 *  px. The map paints FIRST — its seek brings every shared data structure
 *  to `t`, and the header/panels read that state right after. */
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
  // Map square (logical units, translated between the columns). Seeks the
  // shared map internals first — every later band reads post-seek state.
  ctx.save();
  ctx.translate(layout.mapLeft, layout.mapTop);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.rect(0, 0, EXPORT_LOGICAL, EXPORT_LOGICAL);
  ctx.clip();
  req.paintMap(t, ctx);
  ctx.restore();
  // Header band (logical units, full composition width).
  ctx.save();
  ctx.scale(s, s);
  drawPlaybackHeader(ctx, req.header(t), req.palette, req.shipIconFor);
  ctx.restore();
  // Side columns (logical units).
  const colTop = layout.mapTop / s;
  const colH = EXPORT_LOGICAL;
  const colRight = layout.mapLeft / s + EXPORT_LOGICAL;
  const team = req.team(t);
  const recorder = req.recorder(t);
  const chat = req.chat(t);
  ctx.save();
  ctx.scale(s, s);
  drawColumnBase(ctx, 0, EXPORT_SIDE_W, colTop, colH, req.palette, "right");
  drawTeamList(ctx, 0, colTop + 6, EXPORT_SIDE_W, team.allies, ALLY_INK, req.panelLabels.teamAlly, req.palette);
  if (recorder) {
    drawRecorderPanel(ctx, 0, colTop + EXPORT_TEAM_H + 10, EXPORT_SIDE_W, recorder, req.palette, {
      title: req.panelLabels.damage,
      frags: req.panelLabels.dmgFrags,
      taken: req.panelLabels.dmgTaken,
    });
  }
  drawColumnBase(ctx, colRight, EXPORT_SIDE_W, colTop, colH, req.palette, "left");
  drawTeamList(ctx, colRight, colTop + 6, EXPORT_SIDE_W, team.enemies, ENEMY_INK, req.panelLabels.teamEnemy, req.palette);
  drawChatPanel(ctx, colRight, colTop + EXPORT_TEAM_H + 10, EXPORT_SIDE_W, colH - EXPORT_TEAM_H - 16, chat, req.palette, req.panelLabels.chat);
  ctx.restore();
  // Footer band (logical units, share-shot geometry). Wordy locales can
  // need a wider band than the composition (footerMinWidth measures the
  // three text blocks) — the content then scales DOWN into the fixed band
  // instead of colliding, mirroring how share shots widen their canvas.
  // The band's own background is NOT pre-filled here — a downscaled band
  // (wordy locale) is followed by an exact shortfall strip instead.
  if (layout.footerHeight > 0) {
    const footerLogical = Math.max(
      EXPORT_TOTAL_LOGICAL,
      footerMinWidth(req.footerStrings, req.logo != null),
    );
    const fit = (EXPORT_TOTAL_LOGICAL / footerLogical) * s;
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
      onPhase: req.onPhase,
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
    // so the progress surface keeps painting and cancel stays responsive.
    if (i % 3 === 2) await new Promise((r) => setTimeout(r, 0));
  }
  if (encoded === 0) {
    return { blob: new Blob([], { type: "image/gif" }), ext: "gif", cancelled: true };
  }
  req.onPhase?.("finalize");
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
