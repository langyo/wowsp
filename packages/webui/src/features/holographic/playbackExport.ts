/**
 * Replay-playback video/GIF export (the 录像回放 share clip).
 *
 * Renders the match's 2D full-map playback offline — faster than realtime,
 * exactly like the reference clip the feature asks for — into a framed
 * composition that mirrors the in-game replay HUD:
 *
 *   ```mermaid
 *   graph TD
 *       header["score header: ally pts · caps · clock · enemy"]
 *       ally["ally roster header + 3-line rows"] --> rec["recorder damage"]
 *       enemy["enemy roster header + 3-line rows"] --> chat["chat log"]
 *       mid["map square (the same enlarged-map painter)<br/>ship labels over every glyph"]
 *       footer["the fixed WoWSP promo footer (share shots)"]
 *       header --> ally
 *       header --> mid
 *       header --> enemy
 *       rec --> footer
 *       mid --> footer
 *       chat --> footer
 *   ```
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
  drawSealTag,
  sealTagWidth,
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
import { sampleAt } from "./trajectoryMath";
import { hpBarSegments } from "./repairPool";
import { foldDamageStats } from "@/api";
import type { DamageStatSample, EntityTrajectory, ShotKillEvent } from "@/api";

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
/** The header band's corner blocks (map · mode · start time left, duration
 *  · winner right): two dim lines each, clear of the centre pill. The pill
 *  band spans y 6..50, so its own centre is 28; the 2026-11-21 「字太小、位置
 *  太高看不清」 report fixed both blocks to that midline — the title line at
 *  cy-7 and the detail line at cy+9, symmetric about the pill, instead of
 *  the old 10/28 top-hugging baselines. */
export const EXPORT_HEADER_CORNER_INSET = 10;
/** The pill band's vertical centre both corner blocks centre against. */
export const EXPORT_HEADER_CORNER_MID_CY = 28;
/** The two corner baselines, symmetric about the pill's midline: title
 *  above (cy-7), detail below (cy+9). */
export const EXPORT_HEADER_CORNER_CY: readonly [number, number] = [
  EXPORT_HEADER_CORNER_MID_CY - 7,
  EXPORT_HEADER_CORNER_MID_CY + 9,
];
/** Title line 12px, detail 11px (was 10 / 9 — the legibility report). */
export const EXPORT_HEADER_CORNER_FONTS: readonly [number, number] = [12, 11];
export const EXPORT_HEADER_CORNER_ALPHAS: readonly [number, number] = [0.78, 0.6];
/** Team-list portion of a side column; the rest is damage (left) or the
 *  chat log (right). */
export const EXPORT_TEAM_H = 452;

/* Team column metrics ---------------------------------------------------
 * The live roster's FULL mode rebuilt inside the clip's 190 x 452 side
 * column: a two-line header (the configured column labels over the team
 * averages - the live head's own mini table header) plus up to 12
 * three-line entries (nick + medals / class glyph + tier + ship + the
 * first two stats / HP bar). Budget: 6 inset + 26 header + 12 x 34 = 440
 * <= 452, so the damage/chat panels below keep their exact offsets (13
 * entries would need 474; the game fields 12 a side). */
export const EXPORT_TEAM_INSET = 6;
/** Header band: one title row (side name + alive count, the column
 *  labels on the right) over one averages row - ~26px, the live head's
 *  shape. */
export const EXPORT_TEAM_HEADER_H = 26;
/** ONE entry's pitch: 12px nick line, 11px ship line, 5px HP bar. */
export const EXPORT_TEAM_ENTRY_H = 34;
/** Hard row cap (the game's own team size). */
export const EXPORT_TEAM_MAX_ROWS = 12;
/** Header text bands, from the header's own top edge. */
export const EXPORT_TEAM_HEADER_TITLE_CY = 8;
export const EXPORT_TEAM_HEADER_STAT_CY = 19.5;
/** Entry internals, from the entry's top edge. */
export const EXPORT_TEAM_NAME_CY = 8;
export const EXPORT_TEAM_SHIP_CY = 19.5;
export const EXPORT_TEAM_HP_TOP = 26.5;
export const EXPORT_TEAM_HP_H = 5;
/** ONE fixed nickname size for the whole column - the live roster's own
 *  reading. The 2026-11-20 report: per-name fillFit shrink made every row
 *  a different size; names now ellipsize instead of shrinking. */
export const EXPORT_TEAM_NAME_SIZE = 12;
export const EXPORT_TEAM_SHIP_SIZE = 11;
/** Medal badge edge (the live roster's cinnabar seal glyphs at row size). */
export const EXPORT_TEAM_MEDAL_TAG_SCALE = 0.82;
export const EXPORT_TEAM_MEDAL_GAP = 4;
/** Stat text/label sizes and the right-hand track pitch. */
export const EXPORT_TEAM_STAT_TEXT_SIZE = 10;
export const EXPORT_TEAM_STAT_LABEL_SIZE = 8.5;
/** Wide enough for the widest formatted value ("123,456" at 10px) minus
 *  the track's 2px guard; two tracks leave the identity band ~88px. */
export const EXPORT_TEAM_STAT_TRACK_W = 40;
/** Gap between the line-2 identity band and the stat tracks (the stats'
 *  left guard, so a long ship name never touches a value). */
export const EXPORT_TEAM_STAT_GAP = 6;
/** Line 2's FIXED identity cell: class glyph + roman tier live in this
 *  one box and its content is centered inside it, so every row's ship
 *  name starts on the SAME x no matter how wide the tier numeral is
 *  (26px was the report's example; the shipped face needs 36 to hold the
 *  12px glyph and "VIII" at 11px — the tier shrinks to fit the rest). */
export const EXPORT_TEAM_ID_CELL_W = 36;
/** Gap inside that cell (glyph → tier) and after it (cell → ship name). */
export const EXPORT_TEAM_ID_GAP = 4;
/** How many of the user's configured stats params a team column shows:
 *  the FIRST TWO, in the stats config's own order (the live full mode's
 *  order and formatters, trimmed to the clip's width budget). */
export const EXPORT_TEAM_STAT_COLS = 2;
/** Horizontal inset every team-column line keeps (HP bar included). */
export const EXPORT_TEAM_INSET_X = 8;

/** How many entries fit one side's roster area (12 with the shipped
 *  metrics - the layout's own capacity, not the row cap). The stats band
 *  is HORIZONTAL only: turning it off widens the identity band but never
 *  changes the entry pitch, so the capacity (and therefore the 452px
 *  budget) holds identically with the stat band at zero width. */
export function teamEntryCapacity(available = EXPORT_TEAM_H): number {
  const forRows = available - EXPORT_TEAM_INSET - EXPORT_TEAM_HEADER_H;
  return Math.max(0, Math.floor(forRows / EXPORT_TEAM_ENTRY_H));
}

/** Width of the right-hand stat band for the columns actually painted
 *  under EXPORT_TEAM_STAT_COLS. Zero when the stats toggle is off - the
 *  identity band then runs to the column's right inset. */
export function teamStatBandWidth(columns: readonly unknown[]): number {
  return visibleTeamStats(columns).length * EXPORT_TEAM_STAT_TRACK_W;
}

/** Line 2's fixed identity cell geometry: the class glyph and the roman
 *  tier ride ONE cell and their group is centered inside it, so the ship
 *  name after the cell starts on the SAME x on every row. A tier that
 *  out-measures the cell shrinks first (the caller fits it against the
 *  cell's remaining width); a content group narrower than the cell
 *  centers, a full one starts flush left (never a negative offset). */
export function teamIdentityCell(
  cellX: number,
  cellW: number,
  iconSize: number,
  gap: number,
  tierW: number,
  hasIcon: boolean,
): { iconX: number; tierX: number; contentW: number } {
  const contentW =
    (hasIcon ? iconSize : 0) + (tierW > 0 ? (hasIcon ? gap : 0) + tierW : 0);
  const cx = cellX + Math.max(0, (cellW - contentW) / 2);
  return {
    iconX: cx,
    tierX: cx + (hasIcon ? iconSize + gap : 0),
    contentW,
  };
}

/** The first `EXPORT_TEAM_STAT_COLS` entries of a configured column list -
 *  the slice BOTH the header and the entries paint, so the averages and
 *  the cells can never drift onto different columns. */
export function visibleTeamStats<T>(columns: readonly T[]): T[] {
  return columns.slice(0, EXPORT_TEAM_STAT_COLS);
}

/* Recorder panel metrics ------------------------------------------------
 * The left column's bottom block: the recorder's damage headline, then
 * their FULL ribbon set and the two damage-source columns (the 2026-11-21
 * 「勋带弄齐全 + 造成/受到伤害来源」 request). It sits under the roster band
 * exactly like the chat log: the roster keeps EXPORT_TEAM_H, then a 10px
 * top gap and a 6px bottom inset — 760 - 452 - 10 - 6 = 292 logical px, the
 * budget every band below must fit.
 *
 * Stack, from the panel's top edge:
 *   0   .. 118  the existing block: title badge, the 28px total, then the
 *               frag / taken rows (each with its own badge)
 *   128 .. 192  ribbon strip: a 10px caption + THREE 17px rows of icon+count
 *               cells, 3 per row — 9 cells cover the app's whole
 *               authoritative set (7 kinds, RIBBON_SOURCES). The 2026-11-21
 *               「勋带放大 + 去掉自绘底板」 report: the bundled art is drawn
 *               30px wide (was 20) and the painter draws NO capsule/plate of
 *               its own — a 30px art + its count needs ~56px, so the cells
 *               went 4-per-row to 3.
 *   202 .. 285  two damage-source columns: a 10px caption + 5 rows at 14px
 *   => 285 <= 292: 7px of slack, so no band can clip the column's bottom.
 */
/** Top gap between the roster band and the recorder panel (the chat log's
 *  own offset). */
export const EXPORT_RECORDER_TOP_GAP = 10;
/** Bottom inset the column keeps under the panel (the chat log's own). */
export const EXPORT_RECORDER_BOTTOM_INSET = 6;
/** The panel's height budget in logical units: 292 with the shipped
 *  metrics. The optional argument is the column height the caller has. */
export function recorderPanelHeight(available = EXPORT_LOGICAL): number {
  return (
    available -
    EXPORT_TEAM_H -
    EXPORT_RECORDER_TOP_GAP -
    EXPORT_RECORDER_BOTTOM_INSET
  );
}
/** Bottom edge of the existing headline block, from the panel's top (the
 *  second row's badge bottom is 115.5; 118 keeps a hair of pad). */
export const EXPORT_RECORDER_BLOCK_H = 118;
/** Gap between the bands. */
export const EXPORT_RECORDER_BAND_GAP = 10;
/** Ribbon strip: caption band + three cell rows. */
export const EXPORT_RECORDER_RIBBON_CAPTION_H = 13;
export const EXPORT_RECORDER_RIBBON_ROW_H = 17;
export const EXPORT_RECORDER_RIBBON_ROWS = 3;
export const EXPORT_RECORDER_RIBBON_COLS = 3;
/** Icon WIDTH (the bundled ribbon art is 40 x 15 — the wide end-screen
 *  strip). The 2026-11-21 「勋带放大」 report took it from 20 to 30 logical
 *  px, which is why a row holds three cells (30px art + a plain count needs
 *  the ~56px a third of the 170px inner width gives it). */
export const EXPORT_RECORDER_RIBBON_ICON_W = 30;
export const EXPORT_RECORDER_RIBBON_ICON_H =
  (EXPORT_RECORDER_RIBBON_ICON_W * 15) / 40;
/** Gap between a cell's art and its plain count (the count's own left edge
 *  when no art could be decoded). */
export const EXPORT_RECORDER_RIBBON_COUNT_PAD = 3;
/** Count face (shrunk only when a 4-digit count needs the room). */
export const EXPORT_RECORDER_RIBBON_COUNT_SIZE = 9;
export const EXPORT_RECORDER_RIBBON_COUNT_MIN_SIZE = 7.5;
/** Source columns: caption band + five 14px rows each. */
export const EXPORT_RECORDER_SOURCE_CAPTION_H = 13;
export const EXPORT_RECORDER_SOURCE_ROW_H = 14;
/** Rows per column — the DISPLAY clamp (see foldRecorderSources): the
 *  ledger keeps every counterparty; the panel lists the top five. */
export const EXPORT_RECORDER_SOURCE_ROWS = 5;
export const EXPORT_RECORDER_SOURCE_COLUMNS = 2;
/** Horizontal inset of every panel line (the existing headline block's
 *  10px) and the gap between the two source columns. */
export const EXPORT_RECORDER_INSET_X = 10;
export const EXPORT_RECORDER_SOURCE_GAP = 6;
/** Text faces inside the two added bands. The values sit one step smaller
 *  than the names: at 82px per column a 6-digit figure at 10px would leave
 *  the roster name barely four characters. */
export const EXPORT_RECORDER_CAPTION_SIZE = 10;
export const EXPORT_RECORDER_SOURCE_SIZE = 10;
export const EXPORT_RECORDER_SOURCE_VALUE_SIZE = 9;

/** Height of the ribbon strip's band (caption + the cell rows). */
export function recorderRibbonBandHeight(): number {
  return (
    EXPORT_RECORDER_RIBBON_CAPTION_H +
    EXPORT_RECORDER_RIBBON_ROWS * EXPORT_RECORDER_RIBBON_ROW_H
  );
}

/** Height of the two source columns' band (caption + the row stack). */
export function recorderSourceBandHeight(): number {
  return (
    EXPORT_RECORDER_SOURCE_CAPTION_H +
    EXPORT_RECORDER_SOURCE_ROWS * EXPORT_RECORDER_SOURCE_ROW_H
  );
}

/** One width available to a source column: the panel's inner width minus
 *  the inter-column gap, halved (82 with the shipped metrics). */
export function recorderSourceColumnWidth(): number {
  return (
    (EXPORT_SIDE_W -
      2 * EXPORT_RECORDER_INSET_X -
      (EXPORT_RECORDER_SOURCE_COLUMNS - 1) * EXPORT_RECORDER_SOURCE_GAP) /
    EXPORT_RECORDER_SOURCE_COLUMNS
  );
}

/** The bands' top edges, from the panel's top edge, plus the stack height
 *  they occupy — the single source both the painter and the budget test
 *  read, so a metric change can never drift the two apart. */
export interface RecorderPanelBands {
  ribbonsTop: number;
  sourcesTop: number;
  stackH: number;
}

export function recorderPanelBands(): RecorderPanelBands {
  const ribbonsTop = EXPORT_RECORDER_BLOCK_H + EXPORT_RECORDER_BAND_GAP;
  const sourcesTop =
    ribbonsTop + recorderRibbonBandHeight() + EXPORT_RECORDER_BAND_GAP;
  return {
    ribbonsTop,
    sourcesTop,
    stackH: sourcesTop + recorderSourceBandHeight(),
  };
}

/** Does the whole stack fit the panel's budget? (The 292px assertion.) */
export function recorderPanelFits(available = recorderPanelHeight()): boolean {
  return recorderPanelBands().stackH <= available;
}

/** Export formats offered by the modal. */
export type PlaybackExportFormat = "video" | "gif";

/** Export map-square views offered by the modal: the 2D tactical painting
 *  (the clip's original map layer) or the replay's own three.js scene from
 *  a fixed god camera. ONLY the map square swaps — the score pill, both
 *  team columns, the recorder/chat panels, the footer band and the corner
 *  info are byte-identical between the two modes. */
export type PlaybackExportView = "2d" | "3d";

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
  /** Map-square layer: "2d" = today's tactical painting (default), "3d" =
   *  the replay's three.js scene from the fixed god camera (see
   *  exportGodCamera). Layout around the square is unchanged. */
  view: PlaybackExportView;
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
  /** Paint the live roster's configured stat columns (labels + team
   *  averages + the first two values per row). Off = no stat band at
   *  all: entries take the full column width and the clip never pays the
   *  roster-stats lookup. */
  stats: boolean;
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
    // A view outside the two known layers (stale settings, hand-edited
    // state) falls back to the tactical painting — never a blank square.
    view: s.view === "3d" ? "3d" : "2d",
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

/* ── 3D export camera (the 上帝俯瞰 slightly-tilted god view) ────────────
 *  The 3D export renders the replay's OWN three.js scene, framed once per
 *  take by a FIXED camera: high above the full-map centre, tilted just off
 *  vertical (15–25° is the user's 「上帝俯瞰稍微有点倾斜」 reading; 18° sits in
 *  that band) and fitted so the whole map rectangle fits the square with a
 *  small margin. No orbit, no follow, no recorded pose: the same pose
 *  every frame, and the same pose for the same replay every time.
 *
 *  Input bounds are the WORLD-space rectangle computeFullMapBounds returns.
 *  The scene mirrors z (scene z = −world z, the same convention as
 *  sceneMapRect and every marker), so the returned pose is SCENE-space. */
export const EXPORT_GOD_TILT_DEG = 18;
/** Vertical field of view of the export camera — the replay view's own 50°. */
export const EXPORT_GOD_FOV_DEG = 50;
/** Pose margin: the map fills at most 1/1.06 of the half-frame per axis. */
export const EXPORT_GOD_MARGIN = 1.06;

/** Fixed export camera pose in scene units. */
export interface ExportGodCameraPose {
  position: { x: number; y: number; z: number };
  lookAt: { x: number; y: number; z: number };
  /** Camera-to-target distance along the tilted axis (tests/diagnostics). */
  distance: number;
  /** Tilt off the vertical, radians (the pose's own pitch). */
  tilt: number;
}

/** Fit the FIXED god camera to a map rectangle (see the block comment).
 *  Null for a missing / degenerate (non-finite) rectangle — the caller
 *  then keeps the 2D layer rather than framing an empty square. */
export function exportGodCamera(
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null | undefined,
): ExportGodCameraPose | null {
  if (!bounds) return null;
  const { minX, maxX, minZ, maxZ } = bounds;
  if (![minX, maxX, minZ, maxZ].every((n) => Number.isFinite(n))) return null;
  const cx = (minX + maxX) / 2;
  // Scene z mirrors the world's, so the same centre in scene space.
  const cz = -(minZ + maxZ) / 2;
  const halfW = Math.max(Math.abs(maxX - minX), 2) / 2;
  const halfD = Math.max(Math.abs(maxZ - minZ), 2) / 2;
  const tilt = (EXPORT_GOD_TILT_DEG * Math.PI) / 180;
  const tanHalfFov = Math.tan((EXPORT_GOD_FOV_DEG * Math.PI) / 360);
  // Perspective fit in the square viewport (aspect 1). At tilt θ the ground
  // plane's screen-up axis is foreshortened by cosθ; the NEAR edge (the one
  // closest to the camera) is the binding constraint on both axes:
  //   near depth = distance − halfD·sinθ
  //   halfW            / (near depth · tanHalfFov) ≤ 1/margin
  //   halfD·cosθ       / (near depth · tanHalfFov) ≤ 1/margin
  const limit = 1 / EXPORT_GOD_MARGIN;
  const nearDepth =
    Math.max(halfW, halfD * Math.cos(tilt)) / (limit * tanHalfFov);
  // The camera sits on the +z side, looking north — the replay view's own
  // opening direction (fitCamera starts at cz + span/2 too).
  const distance = halfD * Math.sin(tilt) + nearDepth;
  const height = distance * Math.cos(tilt);
  const back = distance * Math.sin(tilt);
  return {
    position: { x: cx, y: height, z: cz + back },
    lookAt: { x: cx, y: 0, z: cz },
    distance,
    tilt,
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
  /** Top-LEFT corner block, up to two small dim lines: map name · mode on
   *  the first, the real-world battle start time on the second. The words
   *  are the caller's (localized); the canvas only paints them. Empty /
   *  omitted = nothing painted. */
  infoLines?: readonly string[];
  /** Top-RIGHT corner block, up to two small dim lines: the replay's
   *  total in-game duration on the first, the winner verdict on the
   *  second (omitted when the payload carries no verdict). */
  outcomeLines?: readonly string[];
}

/** Ship-class HUD icon variant for a strip slot (the scorebar's direction
 *  contract: each side carries its own face, dead ships their own sunk
 *  face — casualties never flip direction). */
export type PlaybackIconVariant = "ally" | "enemy" | "sunk" | "sunk-enemy";

/** One formatted stat value - a row's cell or the header's team mean.
 *  The caller formats and colours it with the LIVE roster's own
 *  formatters (postBattleShare's rosterShotCells), so the canvas side
 *  paints strings only and the clip can never disagree with the panel. */
export interface PlaybackTeamStat {
  /** Display text ("52.3%", "1,234", "-"). */
  text: string;
  /** Explicit ink (the live roster's tier colours); undefined = the
   *  panel's default text ink. */
  color?: string;
}

/** One header column: the stats config's own label over the team's
 *  average (the live roster full mode's two-line column head). */
export interface PlaybackTeamStatColumn extends PlaybackTeamStat {
  /** The stats config's own column label ("winrate" / "solo PR" ...). */
  label: string;
}

/** One team-list row for a side column: the live roster full mode's
 *  three-line identity, rebuilt for the clip. */
export interface PlaybackTeamRow {
  name: string;
  /** Clan tag WITHOUT brackets (rendered as `[TAG] name`), or null. */
  clan?: string | null;
  shipName: string;
  /** Roman tier numeral ("VIII"); null = unknown. */
  tier?: string | null;
  /** WG ship type (the class glyph key: "Battleship", ...); null =
   *  unknown (the drawer falls back to the battleship face). */
  shipType?: string | null;
  /** The seal/medal kinds the live roster's full mode presses beside the
   *  nickname (the career verdict first, then the composition tags). The
   *  seal customizer's LABELS (stampWording over sealLabels) — the small
   *  tag face's text. Deliberately WORDING, not pictures: a user-imported
   *  seal image never enters the clip (the tag form is the whole point). */
  medals?: readonly string[];
  /** The FIRST TWO configured stat columns' values, in the stats
   *  config's own order (see EXPORT_TEAM_STAT_COLS). */
  stats?: readonly PlaybackTeamStat[];
  /** 0..1, or null when unknown (row dims instead of a bar). */
  hpFrac: number | null;
  /** Repair-Party recoverable pool as a fraction of maxHp (0..1), or null
   *  when the replay carried no repair-party activation for this hull (the
   *  bar keeps its two-layer form). 0 = repairs exist, pool exhausted: the
   *  bar shows green + red only. PLAYHEAD-DERIVED — the caller re-reads it
   *  per frame (see repairPool.ts), so it can never be frozen into a take. */
  hpRecoverableFrac?: number | null;
  dead: boolean;
}

/** One side of the roster as the clip paints it: the header's column
 *  labels + team averages over the entry list. */
export interface PlaybackTeamSide {
  columns: readonly PlaybackTeamStatColumn[];
  rows: readonly PlaybackTeamRow[];
}

/** One ribbon counter the recorder earned — the settlement's 勋章 strip:
 *  the parser's ribbon kind key (postBattle RIBBON_SOURCES → the bundled
 *  art) plus its count. */
export interface PlaybackRecorderRibbon {
  key: string;
  value: number;
}

/** One damage-source row: a counterparty's name and the cumulative damage
 *  exchanged with the recorder. */
export interface PlaybackDamageSource {
  label: string;
  amount: number;
}

export interface PlaybackRecorderStats {
  /** Damage DEALT at this playhead — the server-exact fold of the
   *  timestamped updates ≤ t (foldPlaybackRecorderStats), never a final
   *  total. */
  damage: number;
  /** Kills credited at or before this playhead. */
  frags: number;
  /** Damage TAKEN at this playhead (the hull's HP drops ≤ t). */
  taken: number;
  /** The recorder's ribbon set in the settlement's own order (the list the
   *  post-battle report paints; time-invariant, so it is folded once). */
  ribbons: readonly PlaybackRecorderRibbon[];
  /** Damage the recorder DEALT, per target ship, descending — display
   *  clamped (see foldRecorderSources); the ledger keeps every ship. */
  dealTargets: readonly PlaybackDamageSource[];
  /** Damage the recorder TOOK, per attacker, descending (same clamp). */
  takeSources: readonly PlaybackDamageSource[];
}

/* Recorder damage attribution ------------------------------------------
 * The two source columns. The authoritative streams cannot answer "who did
 * this damage": receiveDamageStat is the recorder's OWN running total per
 * weapon (no target), and receiveShieldDamageInfo carries a victim+attacker
 * only for shield-absorbed damage (15.10+). The hit stream answers it the
 * way the app's calibrated self-statistics do (liveSelfStats.ts): every
 * victim's HP-loss timeline is PARTITIONED among the ship impacts that sat
 * near it — each drop is credited once, split evenly across its covering
 * impacts — so a salvo cannot multiply a drop and a focused hull's loss is
 * shared with the crossfiring attackers instead of re-credited per shell
 * (the old per-impact walk summed to a 2.4x median of the results screen).
 * Fire/flooding inside a window rides the shell that landed there, an
 * attacker id 0 (the game's withheld sentinel) is dropped rather than shown
 * under a fake row, and the headline total keeps the server's exact figure
 * (foldDamageStats). Ally hulls never appear under 造成伤害 (a grazed
 * teammate is not damage dealt — the same rule the self-statistics ledger
 * applies), while their shells still dilute the claim partitions and can
 * appear under 受到伤害.
 */
/** The impact window (the same envelope as liveSelfStats.ts, whose copies
 *  stay private — this panel keeps its own). */
const SOURCE_IMPACT_RADIUS = 500;
const SOURCE_HP_BEFORE_S = 0.4;
const SOURCE_HP_AFTER_S = 0.6;
const SOURCE_HP_DROP_MIN = 50;

export type RecorderSourceKind = "dealt" | "taken";

/** One attributed hit in the recorder's damage ledger. */
export interface RecorderSourceHit {
  time: number;
  /** The OTHER party's vehicle entity id (the target when dealt, the
   *  attacker when taken). */
  counterpartyId: number;
  amount: number;
  kind: RecorderSourceKind;
}

export interface RecorderSourceParams {
  shotKills: readonly ShotKillEvent[];
  trajectories: readonly EntityTrajectory[];
  /** The recorder's own ship vehicle entity id (joins trajectories). */
  selfEntityId: number;
  /** The recorder's teammates' vehicle ids: their hulls are excluded from
   *  the DEALT ledger (their shells still dilute the partitions). */
  allyIds?: readonly number[];
}

/** One hull's HP-loss timeline: every sample that fell by at least
 *  SOURCE_HP_DROP_MIN since the previous one (time-ascending; heals never
 *  produce drops). The drops' sum is the hull's real HP loss — the budget
 *  its covering impacts share. */
function sourceDropsOf(tr: EntityTrajectory): { time: number; delta: number }[] {
  const hp = tr.hpSamples;
  const out: { time: number; delta: number }[] = [];
  if (!hp || hp.length < 2) return out;
  for (let i = 1; i < hp.length; i++) {
    const d = hp[i - 1].value - hp[i].value;
    if (d >= SOURCE_HP_DROP_MIN) out.push({ time: hp[i].time, delta: d });
  }
  return out;
}

/** Partition `victim`'s HP drops evenly across the impacts covering each
 *  drop (the liveSelfStats claim model), and return the recorder-owned
 *  shares as ledger rows. A drop is covered by an impact when the drop's
 *  sample time sits inside the impact's envelope. */
function partitionSourceDrops(
  victim: EntityTrajectory,
  impacts: readonly { e: ShotKillEvent; selfOwned: boolean }[],
  selfEntityId: number,
  kind: RecorderSourceKind,
  out: RecorderSourceHit[],
): void {
  if (impacts.length === 0) return;
  const drops = sourceDropsOf(victim);
  if (drops.length === 0) return;
  const poses = impacts.map(({ e }) => sampleAt(victim, e.time));
  const share = new Array<number>(impacts.length).fill(0);
  let lo = 0; // impacts ascend in time alongside the drops — sliding window
  for (const drop of drops) {
    while (lo < impacts.length && impacts[lo].e.time + SOURCE_HP_AFTER_S < drop.time) lo++;
    const covering: number[] = [];
    for (let i = lo; i < impacts.length && impacts[i].e.time - SOURCE_HP_BEFORE_S < drop.time; i++) {
      const at = poses[i];
      if (!at) continue;
      if (Math.hypot(at.x - impacts[i].e.x, at.z - impacts[i].e.z) > SOURCE_IMPACT_RADIUS) continue;
      covering.push(i);
    }
    if (covering.length === 0) continue;
    const per = drop.delta / covering.length;
    for (const i of covering) share[i] += per;
  }
  for (let i = 0; i < impacts.length; i++) {
    // dealt rows ride the RECORDER's own impacts; taken rows ride everyone
    // else's (their shares were partitioned over the victim's drops).
    const owns = kind === "dealt" ? impacts[i].selfOwned : true;
    if (!owns || share[i] <= 0) continue;
    out.push({
      time: impacts[i].e.time,
      counterpartyId:
        kind === "dealt" ? victim.entityId : impacts[i].e.ownerId,
      amount: share[i],
      kind,
    });
  }
}

/** Build the recorder's attributed damage ledger — once per replay, like the
 *  self-shot ledger, since the streams are immutable. Rows are time-ordered
 *  and cumulative folding happens per playhead (foldRecorderSources). */
export function buildRecorderSourceHits({
  shotKills,
  trajectories,
  selfEntityId,
  allyIds,
}: RecorderSourceParams): RecorderSourceHit[] {
  const ships = trajectories.filter((tr) => tr.kind?.entityType === 2);
  const self = ships.find((tr) => tr.entityId === selfEntityId) ?? null;
  if (!self) return [];
  const allies = new Set(allyIds ?? []);
  const shipIds = new Set(ships.map((tr) => tr.entityId));
  // The claim candidates: any SHIP's impacts except the victim's own (a
  // hull's shells cannot hurt it). Ship-id membership also drops the
  // game's withheld attacker 0 — it names no hull here.
  const shipImpacts = shotKills.filter((e) => shipIds.has(e.ownerId));
  const out: RecorderSourceHit[] = [];
  // dealt: the recorder's shares of every enemy hull's drops (allies are
  // excluded as targets but their shells still claim their slices).
  for (const victim of ships) {
    if (victim.entityId === selfEntityId || allies.has(victim.entityId)) continue;
    const impacts = shipImpacts
      .filter((e) => e.ownerId !== victim.entityId)
      .map((e) => ({ e, selfOwned: e.ownerId === selfEntityId }));
    partitionSourceDrops(victim, impacts, selfEntityId, "dealt", out);
  }
  // taken: everyone else's impacts partition the recorder's own drops.
  {
    const impacts = shipImpacts
      .filter((e) => e.ownerId !== selfEntityId)
      .map((e) => ({ e, selfOwned: false }));
    partitionSourceDrops(self, impacts, selfEntityId, "taken", out);
  }
  out.sort((a, b) => a.time - b.time || a.counterpartyId - b.counterpartyId);
  return out;
}


/** A counterparty's display label: the roster join's name, or the raw id as
 *  a hash-prefixed fallback when the id is not on the roster (a wave NPC, a
 *  withheld id). */
export function recorderSourceLabel(
  id: number,
  nameOf: (id: number) => string | null | undefined,
): string {
  const name = nameOf(id)?.trim();
  return name ? name : "#" + String(id);
}

/** The panel's two lists: the counterparties' cumulative damage at battle
 *  time t, descending, clamped to "cap" rows for DISPLAY. The ledger keeps
 *  everything — a larger cap (or Infinity) returns the whole set, so the
 *  clamp costs no data. */
export function foldRecorderSources(
  hits: readonly RecorderSourceHit[],
  t: number,
  kind: RecorderSourceKind,
  nameOf: (id: number) => string | null | undefined,
  cap = EXPORT_RECORDER_SOURCE_ROWS,
): PlaybackDamageSource[] {
  const sums = new Map<number, number>();
  for (const hit of hits) {
    if (hit.kind !== kind || hit.time > t) continue;
    sums.set(hit.counterpartyId, (sums.get(hit.counterpartyId) ?? 0) + hit.amount);
  }
  const rows: PlaybackDamageSource[] = [];
  for (const [id, amount] of sums) {
    const rounded = Math.round(amount);
    if (rounded > 0) {
      rows.push({ label: recorderSourceLabel(id, nameOf), amount: rounded });
    }
  }
  rows.sort(
    (a, b) =>
      b.amount - a.amount ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
  return rows.slice(0, Math.max(0, cap));
}

/* Recorder headline timeline -------------------------------------------
 * The panel's headline numbers are a FOLD of timestamped streams at the
 * frame's own playhead — never a final/cumulative read. The dealt family
 * comes from the server's damage-stat updates (cumulative running totals
 * per weapon/category, each stamped with its battle time), the frags from
 * the shot ledger's kill instants, and 承受伤害 from the hull's HP samples.
 * foldPlaybackRecorderStats is the ONE fold the export feed calls, so the
 * clip's recorder panel and the tactical board's bottom strip read the same
 * semantics at the same battle time (only the playhead differs). */

/** The recorder's timestamped fold source — frozen once per take. */
export interface PlaybackRecorderTimeline {
  /** Server damage-stat updates (`receiveDamageStat`): cumulative running
   *  totals per (weapon, category), timestamped in battle seconds. Mutable
   *  (not `readonly`) because the shared fold takes the stream's own array
   *  without copying it per frame. */
  damageStats?: DamageStatSample[] | null;
  /** Kill instants credited to the recorder — one entry per frag (the shot
   *  ledger stamps each credited kill with its impact time). */
  killTimes?: readonly number[] | null;
  /** The recorder hull's own HP samples (the 承受伤害 source). */
  hpSamples?: readonly { time: number; value: number }[] | null;
}

/** The recorder panel's headline numbers at one playhead. */
export interface PlaybackRecorderFold {
  /** Damage DEALT — the server-exact fold of the damage-stat updates ≤ t. */
  damage: number;
  /** Kills credited to the recorder at or before t. */
  frags: number;
  /** Damage TAKEN — every HP point the recorder hull lost ≤ t. */
  taken: number;
}

/** Fold the recorder's timestamped timeline to battle time `t`.
 *  Pure and O(n) over the frozen timeline; early playheads therefore read
 *  the early numbers (≪ the final totals), the exact class of bug the
 *  「左下角伤害数字异常」 report described. */
export function foldPlaybackRecorderStats(
  timeline: PlaybackRecorderTimeline,
  t: number,
): PlaybackRecorderFold {
  // Dealt family: the SAME server-exact fold the tactical board's bottom
  // strip runs at the live playhead (api/modules/replay.ts foldDamageStats);
  // only the playhead argument differs, so the two can never disagree.
  const damage = foldDamageStats(timeline.damageStats ?? [], t).damage;
  // Frags: kill events at or before the playhead.
  let frags = 0;
  for (const killAt of timeline.killTimes ?? []) {
    if (killAt <= t) frags += 1;
  }
  // 承受伤害: every point of HP the recorder lost up to the playhead — the
  // strip's own HP-sample fold (drop between consecutive samples).
  let taken = 0;
  const hps = timeline.hpSamples ?? [];
  for (let i = 1; i < hps.length; i++) {
    if (hps[i].time > t) break;
    const drop = hps[i - 1].value - hps[i].value;
    if (drop > 0) taken += drop;
  }
  return { damage, frags, taken };
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
/** Repair Party's grey recoverable pool — the same grey the hull plaque's
 *  repairable segment uses — and the red lost-for-good remainder. */
const HP_REPAIR = "200 208 220";
const HP_REPAIR_LOST = "248 92 92";

/** Canvas-independent text measure at a given face size (canvas's own
 *  measureText, wrapped so the fit rules below stay unit-testable). */
export type TeamTextMeasure = (text: string, size: number) => number;

/** The shrink decision behind fillFit, split out pure: the face size is
 *  `size` while the string fits `maxW`, and only a string PAST that cap
 *  shrinks — 0.5px steps down to `minSize`. Used for LINE 2's ship name
 *  (the one overflow slot); nicknames use fitTeamName and never shrink. */
export function fitShrinkSize(
  measure: TeamTextMeasure,
  text: string,
  maxW: number,
  size: number,
  minSize = 8.5,
): number {
  let s = size;
  while (s > minSize && measure(text, s) > maxW) {
    s = Math.max(minSize, s - 0.5);
  }
  return s;
}

/** The nickname fit rule — ONE fixed size for every name in the column
 *  (the live roster's own reading). The 2026-11-20 report: per-name
 *  shrink left every row at a different size, so the face is now fixed and
 *  a name that still overflows ellipsizes instead. */
export interface TeamNameFit {
  /** The face size — ALWAYS the column size (never per-name). */
  size: number;
  /** The string to paint (ellipsized only when it overflowed). */
  text: string;
  /** True when `text` lost characters to the ellipsis. */
  ellipsized: boolean;
}

export function fitTeamName(
  measure: TeamTextMeasure,
  text: string,
  maxW: number,
  size = EXPORT_TEAM_NAME_SIZE,
): TeamNameFit {
  if (maxW <= 0) return { size, text: "", ellipsized: text !== "" };
  if (measure(text, size) <= maxW) return { size, text, ellipsized: false };
  // Ellipsize at the SAME size: the face never changes mid-column.
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const head = chars.slice(0, mid).join("");
    if (measure(head + "\u2026", size) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return {
    size,
    text: lo > 0 ? chars.slice(0, lo).join("") + "\u2026" : "\u2026",
    ellipsized: true,
  };
}

/** Draw text fitted into `maxW` at a size from fitShrinkSize. */
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
  const s = fitShrinkSize(
    (t, px) => {
      g.font = font(px, weight, mono);
      return g.measureText(t).width;
    },
    text,
    maxW,
    size,
    minSize,
  );
  g.font = font(s, weight, mono);
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

/* Header pill metrics ---------------------------------------------------
 * The scorebar pill is ONE row: [ally score | cap chips | enemy score],
 * centred on the frame as a group. Both score blocks share ONE width and
 * one gap, so the chip cluster — the row's pivot — keeps its centre on the
 * frame centre whatever the live cap count (2, 3, 4 …). Nothing here
 * reserves a fixed slot row: the pill's width is the measured sum of the
 * LIVE chips plus the two symmetric score blocks. */
export const EXPORT_HEADER_CHIP_SIZE = 26;
export const EXPORT_HEADER_CHIP_GAP = 6;
/** Gap between the pill's three groups (score · chips · score). */
export const EXPORT_HEADER_GROUP_GAP = 24;
/** The pill's own horizontal padding. */
export const EXPORT_HEADER_PILL_PAD = 22;
/** Score text size and its dot radius (the scorebar's own read). */
export const EXPORT_HEADER_SCORE_SIZE = 20;
export const EXPORT_HEADER_SCORE_DOT_R = 4;
/** Minimum score-block text width — the scorebar's `min-width: 3ch`. */
export const EXPORT_HEADER_SCORE_MIN_W = 33;
/** Display cap: five control points is the game's maximum. */
export const EXPORT_HEADER_MAX_CHIPS = 5;

/** Measured geometry of the header's pill row — the single source the
 *  painter uses, so the layout is unit-testable without a real canvas. */
export interface PlaybackHeaderPillLayout {
  /** The glass pill's left edge and width (the group is frame-centred). */
  x: number;
  w: number;
  /** The pill's horizontal padding. */
  padX: number;
  /** Both scores are present (the digits hide in operations). */
  showScores: boolean;
  /** The SHARED width of both score blocks (0 while the scores are hidden). */
  scoreBlockW: number;
  /** The measured LIVE chip count (0..EXPORT_HEADER_MAX_CHIPS). */
  chipCount: number;
  chipSize: number;
  chipGap: number;
  groupGap: number;
  /** The live chip cluster's width and left edge. */
  capsW: number;
  capsX: number;
  /** The cluster's centre — the frame centre whenever chips are present. */
  capsCenterX: number;
  /** The ally block's left edge, then the enemy block's. */
  allyX: number;
  enemyX: number;
}

/** Measure the header pill for one frame: the LIVE chip count/width is the
 *  pivot, so a 2-cap map and a 4-cap map both keep the [score | chips |
 *  score] group centred on the frame (the two score blocks share one width,
 *  sitting symmetrically around the cluster). Reads only `g.font` for the
 *  score measurement and restores it. */
export function playbackHeaderPillLayout(
  g: CanvasRenderingContext2D,
  capCount: number,
  scoreAlly: number | null,
  scoreEnemy: number | null,
): PlaybackHeaderPillLayout {
  const w = EXPORT_TOTAL_LOGICAL;
  const chipCount = Math.max(0, Math.floor(capCount));
  const capsW = chipCount
    ? chipCount * EXPORT_HEADER_CHIP_SIZE +
      (chipCount - 1) * EXPORT_HEADER_CHIP_GAP
    : 0;
  const showScores = scoreAlly != null && scoreEnemy != null;
  let scoreBlockW = 0;
  if (showScores) {
    const prevFont = g.font;
    g.font = font(EXPORT_HEADER_SCORE_SIZE, 700);
    const widest = Math.max(
      g.measureText(String(scoreAlly)).width,
      g.measureText(String(scoreEnemy)).width,
      EXPORT_HEADER_SCORE_MIN_W,
    );
    g.font = prevFont;
    scoreBlockW = widest + EXPORT_HEADER_SCORE_DOT_R * 2 + 6;
  }
  const mid = w / 2;
  const capsX = mid - capsW / 2;
  // The content span: scores flank the cluster (or, with no chips, the
  // centre line) with ONE shared gap each; with no scores the cluster
  // alone is the span.
  let contentLeft = capsX;
  let contentRight = capsX + capsW;
  if (showScores) {
    contentLeft = (chipCount ? capsX : mid) - EXPORT_HEADER_GROUP_GAP - scoreBlockW;
    contentRight = (chipCount ? capsX + capsW : mid) + EXPORT_HEADER_GROUP_GAP + scoreBlockW;
  }
  return {
    x: contentLeft - EXPORT_HEADER_PILL_PAD,
    w: contentRight - contentLeft + EXPORT_HEADER_PILL_PAD * 2,
    padX: EXPORT_HEADER_PILL_PAD,
    showScores,
    scoreBlockW,
    chipCount,
    chipSize: EXPORT_HEADER_CHIP_SIZE,
    chipGap: EXPORT_HEADER_CHIP_GAP,
    groupGap: EXPORT_HEADER_GROUP_GAP,
    capsW,
    capsX,
    capsCenterX: capsX + capsW / 2,
    allyX: contentLeft,
    enemyX: contentRight - scoreBlockW,
  };
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
  // ── Pill content metrics: the LIVE chip cluster is the pivot ────────
  // The chip count/width is measured from this frame's own caps (never a
  // pre-reserved slot row), and both score blocks share ONE width so the
  // pair sits symmetrically around the cluster: the cluster's centre is
  // the frame centre for 2, 3, 4 … chips alike.
  const chips = data.caps.slice(0, EXPORT_HEADER_MAX_CHIPS);
  const pill = playbackHeaderPillLayout(
    g,
    chips.length,
    data.scoreAlly,
    data.scoreEnemy,
  );
  // ── Pill chrome (the scorebar’s grey glass) ──────────────────────────
  g.beginPath();
  g.roundRect(pill.x, pillY, pill.w, pillH, 18);
  g.fillStyle = rgba(palette.surface, 0.6);
  g.fill();
  g.strokeStyle = rgba(palette.text, 0.22);
  g.lineWidth = 1;
  g.stroke();
  // ── Pill content, placed from the measured layout (explicit mirroring:
  //    no flipped transform, or the glyphs themselves would mirror) ─────
  const drawScore = (
    x: number,
    score: number,
    ink: string,
    side: "ally" | "enemy",
  ): void => {
    const right = side === "enemy";
    const blockW = pill.scoreBlockW;
    g.fillStyle = rgba(ink, 0.95);
    g.beginPath();
    const dotX = right
      ? x + blockW - EXPORT_HEADER_SCORE_DOT_R
      : x + EXPORT_HEADER_SCORE_DOT_R;
    g.arc(dotX, pillCy, EXPORT_HEADER_SCORE_DOT_R, 0, Math.PI * 2);
    g.fill();
    g.font = font(EXPORT_HEADER_SCORE_SIZE, 700);
    g.fillStyle = rgba(ink, 0.98);
    g.textAlign = right ? "right" : "left";
    const tx = right
      ? x + blockW - EXPORT_HEADER_SCORE_DOT_R * 2 - 6
      : x + EXPORT_HEADER_SCORE_DOT_R * 2 + 6;
    g.fillText(String(score), tx, pillCy);
  };
  if (pill.showScores) drawScore(pill.allyX, data.scoreAlly!, ALLY_INK, "ally");
  // Cap chips: idle = square stroke (roomier letter), capturing/
  // contested = the diamond with the capture-side progress ring — the
  // scorebar’s CapChip geometry, path-identical. The cluster starts at the
  // measured centre slot (pill.capsX) — the frame's own chip count, never a
  // reserved three-slot row.
  const chipSize = pill.chipSize;
  const chipGap = pill.chipGap;
  let cx = pill.capsX;
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
  if (pill.showScores) {
    drawScore(pill.enemyX, data.scoreEnemy!, ENEMY_INK, "enemy");
  }
  // Clock UNDER the caps (the 2026-11-20 report: beside the chips it
  // crowded the third cap). Mono, centered, export-only — the app reads
  // the time off its transport bar.
  const clockCy = pillY + pillH + 12;
  g.font = font(17, 700, true);
  g.fillStyle = rgba(palette.text, 0.92);
  g.textAlign = "center";
  g.fillText(data.clock, w / 2, clockCy);
  // ── Corner blocks: the map/mode/start-time identity on the LEFT, the
  //    total duration + winner verdict on the RIGHT. Two lines each
  //    (12px/700 over 11px/400), centred on the pill band's midline
  //    (EXPORT_HEADER_CORNER_CY) and clamped to the gap between the frame
  //    edge and the pill so they can never run under it (the pill keeps
  //    the centre). ────────────────────────────────────────────────────
  const cornerInset = EXPORT_HEADER_CORNER_INSET;
  const leftMax = Math.max(0, pill.x - cornerInset * 2);
  const rightMax = Math.max(0, w - (pill.x + pill.w) - cornerInset * 2);
  const drawCorner = (
    lines: readonly string[] | undefined,
    align: "left" | "right",
    maxW: number,
  ): void => {
    if (!lines || lines.length === 0 || maxW <= 4) return;
    g.textAlign = align;
    lines.slice(0, 2).forEach((line, i) => {
      if (!line) return;
      g.font = font(EXPORT_HEADER_CORNER_FONTS[i], i === 0 ? 700 : 400);
      g.fillStyle = rgba(palette.text, EXPORT_HEADER_CORNER_ALPHAS[i]);
      g.fillText(
        ellipsize(g, line, maxW),
        align === "left" ? cornerInset : w - cornerInset,
        EXPORT_HEADER_CORNER_CY[i],
      );
    });
  };
  drawCorner(data.infoLines, "left", leftMax);
  drawCorner(data.outcomeLines, "right", rightMax);
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

/** The team-list half of a side column: the live roster full mode rebuilt
 *  on canvas - a two-line header (the configured column labels over the
 *  team averages) above up to 12 three-line entries:
 *
 *    [nick] [medal] [medal]        <- ONE fixed name size, LEFT at the inset
 *      (glyph) VIII | 雷电 52.3% 1450 <- fixed cell + left ship, stats right
 *    =====================================    <- slim full-width HP bar
 *
 *  Everything identity-shaped is LEFT-aligned (the 2026-11-21 report:
 *  centered groups made the nick/ship columns read ragged): the nick
 *  starts at the column's left inset with its seals after it, and line 2
 *  starts with a FIXED-WIDTH cell whose class-glyph + roman-tier content
 *  centers inside that cell, so every ship name begins on the same x.
 *  The first two configured stat columns keep their fixed 40px tracks -
 *  values right-aligned inside a track, header labels centered OVER the
 *  same track (the live head's own columns). With `showStats` off the
 *  stat band disappears entirely: no labels, no averages, no values, and
 *  the identity band runs to the column's right inset.
 *
 *  Exported for the layout tests, which drive it with a recording 2D
 *  context (canvas-free). */
export function drawPlaybackTeamColumn(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  side: PlaybackTeamSide,
  role: "ally" | "enemy",
  ink: string,
  title: string,
  palette: ShotPalette,
  labels: PlaybackPanelLabels,
  shipIconFor: (
    shipType: string | null,
    variant: PlaybackIconVariant,
  ) => HTMLImageElement | null,
  showStats = true,
): void {
  g.textBaseline = "middle";
  const columns = showStats ? visibleTeamStats(side.columns) : [];
  const statBandW = teamStatBandWidth(columns);
  const inset = EXPORT_TEAM_INSET_X;
  const right = x + w - inset;
  // Left edge of the stat band; with the band off this is the column's
  // right inset (the identity band then owns the whole width).
  const statsLeft = right - statBandW;
  const bandRight = statBandW > 0 ? statsLeft - EXPORT_TEAM_STAT_GAP : right;
  // Header row 1: side dot + name + alive count on the left, the column
  // labels CENTERED over their own tracks (the values underneath stay
  // right-aligned inside those same tracks).
  g.fillStyle = rgba(ink, 0.95);
  g.beginPath();
  g.arc(x + 10, y + EXPORT_TEAM_HEADER_TITLE_CY, 3.6, 0, Math.PI * 2);
  g.fill();
  g.textAlign = "left";
  g.font = font(12, 700);
  g.fillStyle = rgba(palette.text, 0.92);
  g.fillText(title, x + 18, y + EXPORT_TEAM_HEADER_TITLE_CY);
  const titleW = g.measureText(title).width;
  const alive = side.rows.filter((r) => !r.dead).length;
  g.font = font(9.5, 400);
  g.fillStyle = rgba(palette.text, 0.5);
  g.fillText(
    `${alive}/${side.rows.length}`,
    x + 18 + titleW + 6,
    y + EXPORT_TEAM_HEADER_TITLE_CY,
  );
  g.font = font(EXPORT_TEAM_STAT_LABEL_SIZE, 400);
  // Labels share the values' right edge — a centered label sits left of
  // the number it names and reads as a different column.
  g.textAlign = "right";
  columns.forEach((col, i) => {
    g.fillStyle = rgba(palette.text, 0.5);
    g.fillText(
      ellipsize(g, col.label, EXPORT_TEAM_STAT_TRACK_W - 2),
      statsLeft + (i + 1) * EXPORT_TEAM_STAT_TRACK_W,
      y + EXPORT_TEAM_HEADER_TITLE_CY,
    );
  });
  // Header row 2: the team averages under their own columns - captioned
  // so they cannot be misread as one player's numbers. The caption rides
  // the column's left inset; every average stays right-aligned INSIDE its
  // track exactly like the row values below (the toggle-off layout paints
  // no label/average row at all).
  if (showStats) {
    g.textAlign = "left";
    g.font = font(EXPORT_TEAM_STAT_LABEL_SIZE, 400);
    g.fillStyle = rgba(palette.text, 0.42);
    g.fillText(
      ellipsize(g, columns.length > 0 ? labels.teamAvg : labels.noStats, w - inset * 2),
      x + inset,
      y + EXPORT_TEAM_HEADER_STAT_CY,
    );
    g.textAlign = "right";
    g.font = font(EXPORT_TEAM_STAT_TEXT_SIZE, 700);
    columns.forEach((col, i) => {
      // A dash cell keeps the live head's muted gray (a bright dash reads
      // as a value).
      g.fillStyle =
        col.color ?? (col.text === "—"
          ? rgba(palette.text, 0.45)
          : rgba(palette.text, 0.88));
      g.fillText(
        ellipsize(g, col.text, EXPORT_TEAM_STAT_TRACK_W - 2),
        statsLeft + (i + 1) * EXPORT_TEAM_STAT_TRACK_W,
        y + EXPORT_TEAM_HEADER_STAT_CY,
      );
    });
  }
  // Entries: the header band, then one fixed-pitch entry each.
  const listTop = y + EXPORT_TEAM_HEADER_H;
  const count = Math.min(
    side.rows.length,
    Math.min(EXPORT_TEAM_MAX_ROWS, teamEntryCapacity()),
  );
  for (let i = 0; i < count; i += 1) {
    const row = side.rows[i];
    const ry = listTop + i * EXPORT_TEAM_ENTRY_H;
    const dim = row.dead ? 0.35 : 1;
    const cy1 = ry + EXPORT_TEAM_NAME_CY;
    const cy2 = ry + EXPORT_TEAM_SHIP_CY;
    // Line 1: the clan-tagged nick starts at the column's LEFT inset (the
    // 2026-11-21 「全体左对齐」 report - the centered group read ragged),
    // the seal TAGS (StampTag's small face redrawn: cinnabar wording in a
    // rounded border, scaled down to the entry band) following right
    // after it, still capped at three. ONE fixed name size (never
    // per-name shrink).
    const medals = (row.medals ?? []).slice(0, 3);
    const tagWs = medals.map((label) => sealTagWidth(g, label) * EXPORT_TEAM_MEDAL_TAG_SCALE);
    const medalW =
      tagWs.length > 0
        ? tagWs.reduce((a, b) => a + b, 0) + (tagWs.length - 1) * EXPORT_TEAM_MEDAL_GAP + 6
        : 0;
    const display = row.clan ? `[${row.clan}] ${row.name}` : row.name;
    const nameMaxW = Math.max(24, w - inset * 2 - medalW);
    const nameFit = fitTeamName(
      (text, size) => {
        g.font = font(size, 700);
        return g.measureText(text).width;
      },
      display,
      nameMaxW,
    );
    g.font = font(nameFit.size, 700);
    const nameW = Math.min(g.measureText(nameFit.text).width, nameMaxW);
    const gx = x + inset;
    g.textAlign = "left";
    // Names read as ordinary text (white on the dark clip), NOT team
    // colours - the HP bar and side title already carry the team.
    g.fillStyle = rgba(palette.text, 0.94 * dim);
    g.fillText(nameFit.text, gx, cy1);
    if (medals.length > 0) {
      g.save();
      g.globalAlpha = dim;
      let mx = gx + nameW + 6;
      medals.forEach((label, i) => {
        g.save();
        g.translate(mx + tagWs[i] / 2, cy1);
        g.scale(EXPORT_TEAM_MEDAL_TAG_SCALE, EXPORT_TEAM_MEDAL_TAG_SCALE);
        drawSealTag(g, 0, 0, label);
        g.restore();
        mx += tagWs[i] + EXPORT_TEAM_MEDAL_GAP;
      });
      g.restore();
    }
    // Line 2: a FIXED-WIDTH identity cell (class glyph + roman tier, the
    // content centered INSIDE the cell) then the ship name, LEFT-aligned
    // right after it. The cell keeps every ship name on the same x even
    // when the tier numeral is wide; the name shrinks/ellipsizes before
    // the stat tracks. With the stats toggle off, `bandRight` is the
    // column's right inset, so the identity band owns the full width.
    const cellX = x + inset;
    // 10 logical px: the live roster's BattleIcon is 14 CSS px on a ~46px
    // row (~30% of the row); 12 read a size larger than the app's.
    const iconSize = 10;
    const tier = row.tier ?? "";
    const cellGap = EXPORT_TEAM_ID_GAP;
    // The tier shrinks to the cell's remaining width first, so the fixed
    // cell can always center its content (a one-char numeral keeps size).
    const tierMaxW = Math.max(0, EXPORT_TEAM_ID_CELL_W - iconSize - cellGap);
    const tierSize =
      tier !== ""
        ? fitShrinkSize(
            (text, size) => {
              g.font = font(size, 700);
              return g.measureText(text).width;
            },
            tier,
            tierMaxW,
            EXPORT_TEAM_SHIP_SIZE,
            8,
          )
        : EXPORT_TEAM_SHIP_SIZE;
    g.font = font(tierSize, 700);
    const tierW = tier !== "" ? Math.min(g.measureText(tier).width, tierMaxW) : 0;
    const shipX = cellX + EXPORT_TEAM_ID_CELL_W + cellGap;
    const shipMaxW = Math.max(20, bandRight - shipX);
    // Line 2 keeps the shrink-to-fit rule (fitShrinkSize + ellipsize): the
    // ONE slot allowed to shrink (a long ship
    // name ellipsizes at the floor rather than painting over the stats).
    const shipSize = fitShrinkSize(
      (text, size) => {
        g.font = font(size, 400);
        return g.measureText(text).width;
      },
      row.shipName,
      shipMaxW,
      EXPORT_TEAM_SHIP_SIZE,
    );
    const variant: PlaybackIconVariant = row.dead
      ? role === "enemy"
        ? "sunk-enemy"
        : "sunk"
      : role;
    const icon = shipIconFor(row.shipType ?? null, variant);
    const cell = teamIdentityCell(
      cellX,
      EXPORT_TEAM_ID_CELL_W,
      iconSize,
      cellGap,
      tierW,
      icon != null,
    );
    if (icon) {
      g.save();
      g.globalAlpha = dim;
      // Letterbox into the 12px slot (object-fit: contain - the class
      // art is a wide glyph; a square draw would stretch it).
      const natW = icon.naturalWidth || iconSize;
      const natH = icon.naturalHeight || iconSize;
      const fit = Math.min(iconSize / natW, iconSize / natH);
      const dw = natW * fit;
      const dh = natH * fit;
      g.drawImage(icon, cell.iconX + (iconSize - dw) / 2, cy2 - dh / 2, dw, dh);
      g.restore();
    }
    if (tierW > 0) {
      g.font = font(tierSize, 700);
      g.fillStyle = rgba(palette.text, 0.82 * dim);
      g.textAlign = "left";
      g.fillText(ellipsize(g, tier, tierMaxW), cell.tierX, cy2);
    }
    g.font = font(shipSize, 400);
    g.fillStyle = rgba(palette.text, 0.62 * dim);
    g.textAlign = "left";
    g.fillText(ellipsize(g, row.shipName, shipMaxW), shipX, cy2);
    const stats = showStats ? visibleTeamStats(row.stats ?? []) : [];
    g.font = font(EXPORT_TEAM_STAT_TEXT_SIZE, 700);
    g.textAlign = "right";
    stats.forEach((stat, si) => {
      // Values stay RIGHT-aligned inside their own 40px track.
      g.save();
      g.globalAlpha = dim;
      g.fillStyle = stat.color ?? rgba(palette.text, 0.82);
      g.fillText(
        ellipsize(g, stat.text, EXPORT_TEAM_STAT_TRACK_W - 2),
        statsLeft + (si + 1) * EXPORT_TEAM_STAT_TRACK_W,
        cy2,
      );
      g.restore();
    });
    // Line 3: the slim full-width HP bar (team ink; dead rows keep the
    // empty rail, exactly as before). A row carrying a Repair Party pool
    // renders the game's three layers instead — green (current HP) | grey
    // (recoverable) | red (lost for good), left to right — and the grey takes
    // its width OUT OF the red remainder, never out of green.
    const barX = x + inset;
    const barW = w - inset * 2;
    g.fillStyle = rgba(palette.text, 0.14);
    g.fillRect(barX, ry + EXPORT_TEAM_HP_TOP, barW, EXPORT_TEAM_HP_H);
    if (row.hpFrac != null && !row.dead) {
      const frac = Math.min(1, Math.max(0, row.hpFrac));
      if (row.hpRecoverableFrac != null) {
        const seg = hpBarSegments(frac, row.hpRecoverableFrac);
        // The lost-for-good red rail first, then the grey pool over it: the
        // green fill below still owns the bar's left end untouched.
        g.fillStyle = rgba(HP_REPAIR_LOST, 0.45);
        g.fillRect(
          barX + barW * (seg.green + seg.gray),
          ry + EXPORT_TEAM_HP_TOP,
          barW * seg.red,
          EXPORT_TEAM_HP_H,
        );
        g.fillStyle = rgba(HP_REPAIR, 0.85);
        g.fillRect(
          barX + barW * seg.green,
          ry + EXPORT_TEAM_HP_TOP,
          barW * seg.gray,
          EXPORT_TEAM_HP_H,
        );
      }
      g.fillStyle = rgba(hpInk(frac), 0.95);
      g.fillRect(barX, ry + EXPORT_TEAM_HP_TOP, barW * frac, EXPORT_TEAM_HP_H);
    }
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
 *  each carrying its own badge (the 2026-11-20 「徽章缺失」 report) — and,
 *  under them, the recorder's ribbon strip + the two damage-source columns
 *  (the 2026-11-21 「勋带弄齐全 + 来源列表」 request). */
export function drawRecorderPanel(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  stats: PlaybackRecorderStats,
  palette: ShotPalette,
  labels: PlaybackPanelLabels,
  ribbonIconFor: (key: string) => HTMLImageElement | null,
): void {
  g.textBaseline = "middle";
  g.textAlign = "left";
  const badge = 15;
  drawStatBadge(g, x + 10, y + 7, badge, "255 180 60", "burst");
  g.font = font(12, 700);
  g.fillStyle = rgba(palette.text, 0.72);
  g.fillText(labels.damage, x + 10 + badge + 7, y + 14);
  g.font = font(28, 700, true);
  g.fillStyle = rgba(palette.text, 0.96);
  g.fillText(stats.damage.toLocaleString("en-US"), x + 10, y + 50);
  const rowY = (i: number): number => y + 82 + i * 26;
  drawStatBadge(g, x + 10, rowY(0) - badge / 2, badge, "248 92 92", "frag");
  g.font = font(11, 400);
  g.fillStyle = rgba(palette.text, 0.62);
  g.fillText(labels.dmgFrags, x + 10 + badge + 7, rowY(0));
  g.font = font(11, 700, true);
  g.fillStyle = rgba(palette.text, 0.9);
  g.textAlign = "right";
  g.fillText(String(stats.frags), x + w - 10, rowY(0));
  drawStatBadge(g, x + 10, rowY(1) - badge / 2, badge, "120 160 255", "shield");
  g.font = font(11, 400);
  g.fillStyle = rgba(palette.text, 0.62);
  // Labels stay left-aligned; only the VALUE columns are right-aligned.
  g.textAlign = "left";
  g.fillText(labels.dmgTaken, x + 10 + badge + 7, rowY(1));
  g.font = font(11, 700, true);
  g.fillStyle = rgba(palette.text, 0.9);
  // The value column hugs the right inset (it must not start there and run
  // rightward out of the panel).
  g.textAlign = "right";
  g.fillText(stats.taken.toLocaleString("en-US"), x + w - 10, rowY(1));
  // Hand the alignment back to the callers (left) for the next pass.
  g.textAlign = "left";
  // ── The ribbon strip + the two damage-source columns ──────────────────
  // Both bands' offsets come from recorderPanelBands(), the same helper the
  // budget test asserts against 292px — the painter cannot drift off it.
  const bands = recorderPanelBands();
  const innerX = x + EXPORT_RECORDER_INSET_X;
  const innerW = w - EXPORT_RECORDER_INSET_X * 2;
  drawRecorderRibbons(
    g,
    innerX,
    y + bands.ribbonsTop,
    innerW,
    stats.ribbons,
    palette,
    labels.ribbonsTitle,
    ribbonIconFor,
  );
  // Rows the band can hold (a defensive min: the fold's display cap is what
  // normally binds, so this only matters if the metrics ever shrink).
  const rowsThatFit = Math.max(
    0,
    Math.floor(
      (h - bands.sourcesTop - EXPORT_RECORDER_SOURCE_CAPTION_H) /
        EXPORT_RECORDER_SOURCE_ROW_H,
    ),
  );
  const rows = Math.min(EXPORT_RECORDER_SOURCE_ROWS, rowsThatFit);
  const colW = recorderSourceColumnWidth();
  drawRecorderSourceColumn(
    g,
    innerX,
    y + bands.sourcesTop,
    colW,
    labels.dmgDealtSources,
    stats.dealTargets.slice(0, rows),
    palette,
  );
  drawRecorderSourceColumn(
    g,
    innerX + colW + EXPORT_RECORDER_SOURCE_GAP,
    y + bands.sourcesTop,
    colW,
    labels.dmgTakenSources,
    stats.takeSources.slice(0, rows),
    palette,
  );
}

/** The recorder's ribbon strip: a caption over THREE rows of icon+count
 *  cells (3 per row), painted in the settlement's own order. The bundled
 *  end-screen art identifies the kind (no per-ribbon word is needed, and the
 *  art is language-neutral) and is drawn at its own 30px width with a plain
 *  count beside it: the painter adds NO self-drawn chrome — no count capsule,
 *  no plate, no border (the 2026-11-21 「去掉自绘图标」 report). A cell whose
 *  art was not preloaded therefore keeps the count alone, on the panel. */
function drawRecorderRibbons(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  ribbons: readonly PlaybackRecorderRibbon[],
  palette: ShotPalette,
  caption: string,
  ribbonIconFor: (key: string) => HTMLImageElement | null,
): void {
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.font = font(EXPORT_RECORDER_CAPTION_SIZE, 700);
  g.fillStyle = rgba(palette.text, 0.6);
  g.fillText(caption, x, y + EXPORT_RECORDER_RIBBON_CAPTION_H / 2 + 1);
  const cellW = w / EXPORT_RECORDER_RIBBON_COLS;
  const firstCy =
    y + EXPORT_RECORDER_RIBBON_CAPTION_H + EXPORT_RECORDER_RIBBON_ROW_H / 2;
  const cells = EXPORT_RECORDER_RIBBON_COLS * EXPORT_RECORDER_RIBBON_ROWS;
  if (ribbons.length === 0) {
    // No settlement counters (a replay without BattleResults): keep the
    // caption's dash, like the two source columns do.
    g.font = font(EXPORT_RECORDER_SOURCE_SIZE, 400, true);
    g.fillStyle = rgba(palette.text, 0.32);
    g.fillText("—", x, firstCy);
    return;
  }
  // The app's authoritative set is 7 kinds, so the 3 x 3 = 9 cells hold it
  // without a cut; the slice is the contract the budget test asserts
  // against RIBBON_SOURCES.
  ribbons.slice(0, cells).forEach((rib, i) => {
    const cx = x + (i % EXPORT_RECORDER_RIBBON_COLS) * cellW;
    const cy = firstCy + Math.floor(i / EXPORT_RECORDER_RIBBON_COLS) * EXPORT_RECORDER_RIBBON_ROW_H;
    // The bundled art, plain and larger: the official end-screen strip
    // already carries its own face — the painter lays NO capsule / plate /
    // border around it (nor around a missing one).
    const icon = ribbonIconFor(rib.key);
    if (icon) {
      g.drawImage(
        icon,
        cx,
        cy - EXPORT_RECORDER_RIBBON_ICON_H / 2,
        EXPORT_RECORDER_RIBBON_ICON_W,
        EXPORT_RECORDER_RIBBON_ICON_H,
      );
    }
    // The count rides IMMEDIATELY after its icon: a right-aligned count
    // would sit next to the FOLLOWING cell's icon and read as that icon's
    // number. The remaining cell width is the count's cap; with no art the
    // count simply starts at the cell's own left edge.
    const countX =
      cx +
      (icon
        ? EXPORT_RECORDER_RIBBON_ICON_W + EXPORT_RECORDER_RIBBON_COUNT_PAD
        : EXPORT_RECORDER_RIBBON_COUNT_PAD);
    const countW = Math.max(6, cx + cellW - countX - 2);
    const text = String(rib.value);
    const size = fitShrinkSize(
      (t, s) => {
        g.font = font(s, 700, true);
        return g.measureText(t).width;
      },
      text,
      countW,
      EXPORT_RECORDER_RIBBON_COUNT_SIZE,
      EXPORT_RECORDER_RIBBON_COUNT_MIN_SIZE,
    );
    g.font = font(size, 700, true);
    g.textAlign = "left";
    g.fillStyle = rgba(palette.text, 0.82);
    g.fillText(ellipsize(g, text, countW), countX, cy + 0.5);
  });
  g.textAlign = "left";
}

/** One damage-source column: a muted caption over up to five rows of
 *  "name left, value right" (the user's 两列 layout) — names at 10px, the
 *  figures one step smaller so a six-digit number does not eat the name.
 *  The value track reserves the widest figure and names ellipsize into what
 *  is left; an empty column keeps a dim dash so the caption never floats
 *  alone. */
function drawRecorderSourceColumn(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  caption: string,
  rows: readonly PlaybackDamageSource[],
  palette: ShotPalette,
): void {
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.font = font(EXPORT_RECORDER_CAPTION_SIZE, 700);
  g.fillStyle = rgba(palette.text, 0.6);
  g.fillText(caption, x, y + EXPORT_RECORDER_SOURCE_CAPTION_H / 2 + 1);
  const firstCy =
    y + EXPORT_RECORDER_SOURCE_CAPTION_H + EXPORT_RECORDER_SOURCE_ROW_H / 2;
  if (rows.length === 0) {
    g.font = font(EXPORT_RECORDER_SOURCE_SIZE, 400, true);
    g.fillStyle = rgba(palette.text, 0.32);
    g.fillText("—", x, firstCy);
    return;
  }
  // The value track never takes more than half the column (a 7+-digit
  // figure shrinks instead of pushing every name out); the widest figure it
  // actually paints is what the names give room to.
  const maxValueW = w * 0.5;
  const valueText = (r: PlaybackDamageSource): string => r.amount.toLocaleString("en-US");
  let valueW = 0;
  for (const r of rows) {
    const text = valueText(r);
    const size = fitShrinkSize(
      (t, s) => {
        g.font = font(s, 700, true);
        return g.measureText(t).width;
      },
      text,
      maxValueW,
      EXPORT_RECORDER_SOURCE_VALUE_SIZE,
      7.5,
    );
    g.font = font(size, 700, true);
    valueW = Math.max(valueW, g.measureText(text).width);
  }
  rows.forEach((r, i) => {
    const cy = firstCy + i * EXPORT_RECORDER_SOURCE_ROW_H;
    const text = valueText(r);
    g.font = font(
      fitShrinkSize(
        (t, s) => {
          g.font = font(s, 700, true);
          return g.measureText(t).width;
        },
        text,
        maxValueW,
        EXPORT_RECORDER_SOURCE_VALUE_SIZE,
        7.5,
      ),
      700,
      true,
    );
    g.textAlign = "right";
    g.fillStyle = rgba(palette.text, 0.88);
    g.fillText(text, x + w, cy);
    g.font = font(EXPORT_RECORDER_SOURCE_SIZE, 400);
    g.textAlign = "left";
    g.fillStyle = rgba(palette.text, 0.66);
    g.fillText(ellipsize(g, r.label, Math.max(8, w - valueW - 4)), x, cy);
  });
  g.textAlign = "left";
}

/* Chat log metrics ------------------------------------------------------
 * The right column's bottom block: a caption band, then one entry per line —
 * [MM:SS] sender on the first row, the message on the second (the 2026-11-20
 * layout report). The list is anchored to the TOP of the entry area (the
 * 2026-11-21 「聊天记录从开头渲染而不是从最下头往上渲染」 report): the oldest
 * visible entry starts right under the caption and the entries flow DOWN,
 * so the transcript reads like the live chat panel; the newest entry ends
 * nearest the panel's bottom edge. The window is still the NEWEST
 * chatEntryCapacity(h) lines — only the anchor direction changed.
 */
/** Caption band at the panel's top (the localized "聊天记录" word). */
export const EXPORT_CHAT_TITLE_H = 20;
/** One entry's pitch: the 12px time+sender row over the 10px message row. */
export const EXPORT_CHAT_ENTRY_H = 34;
/** The message row's offset inside an entry (second line). */
export const EXPORT_CHAT_ENTRY_TEXT_H = 15;
/** Breathing room kept under the newest entry. */
export const EXPORT_CHAT_BOTTOM_PAD = 8;

/** How many entries the chat panel's height shows — the newest window the
 *  painter slices (the feed hands it every line up to the playhead). */
export function chatEntryCapacity(h: number): number {
  const usable =
    h - EXPORT_CHAT_TITLE_H - EXPORT_CHAT_ENTRY_TEXT_H - EXPORT_CHAT_BOTTOM_PAD;
  if (usable < 0) return 0;
  return Math.floor(usable / EXPORT_CHAT_ENTRY_H) + 1;
}

/** The chat log (right column bottom): the newest window of entries, drawn
 *  from the TOP of the entry area downward, TWO rows each — [MM:SS] sender
 *  on the first line, the message on the second (the 2026-11-20 layout
 *  report). Exported for the layout tests' recording context. */
export function drawChatPanel(
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
  const max = chatEntryCapacity(h);
  // slice(-0) would return EVERY line (a zero-height panel must show
  // nothing), so the empty window is spelled out.
  const shown = max > 0 ? lines.slice(-max) : [];
  // Top anchor: the first (oldest visible) entry starts at the entry
  // area's top edge and the list flows DOWNWARD.
  let ly = y + EXPORT_CHAT_TITLE_H;
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
    g.fillText(ellipsize(g, line.text, w - 20), x + 10, ly + EXPORT_CHAT_ENTRY_TEXT_H);
    ly += EXPORT_CHAT_ENTRY_H;
  }
}

/** Coarse phase the export progress card renders.
 *
 *  `feed` and `models` are the PRE-RENDER stages: the caller assembles the
 *  clip's feed (roster batch, medal composition lookup, recorder ledger +
 *  ribbon art, ship-icon decode) and, for the 3D view, drains the scene's
 *  lazily loaded ship hulls BEFORE the encode loop starts. Neither has a
 *  percentage of its own — the card shows the stage label over an
 *  indeterminate bar instead of sitting frozen at 0% · 0/N while that work
 *  runs (the 2026-11-22 「一直卡着不导出」 report). `render` is the frame
 *  loop (the only phase with a percentage) and `finalize` the
 *  encoder/muxer flush. The caller adds its own final `save` stage. */
export type PlaybackExportPhase = "feed" | "models" | "render" | "finalize";

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
  /** Each side's roster + its header columns (label + team average) at
   *  each frame's battle time (read AFTER the seek). */
  team: (t: number) => { allies: PlaybackTeamSide; enemies: PlaybackTeamSide };
  /** The recorder's damage/frags/taken at each battle time. */
  recorder: (t: number) => PlaybackRecorderStats | null;
  /** Chat lines up to each battle time, oldest first (the painter keeps
   *  the newest chatEntryCapacity(h) of them, top-anchored). */
  chat: (t: number) => PlaybackChatLine[];
  /** Ship-class HUD icon resolver for the header strip — the caller
   *  preloads (decodes) every class×variant once before the render loop.
   *  Return null to skip a slot. */
  shipIconFor: (shipType: string | null, variant: PlaybackIconVariant) => HTMLImageElement | null;
  /** Ribbon-art resolver for the recorder's strip — the caller preloads the
   *  bundled settlement icons once (bundledRibbonUrl). Null skips the art
   *  (the cell keeps its plain count — the painter draws no plate). */
  ribbonIconFor: (key: string) => HTMLImageElement | null;
  /** Paint the map square for battle time `t` in logical units onto `g`
   *  (already translated to the map's top-left corner and scaled).
   *  `mapSizePx` is the square's edge in DEVICE pixels — the 3D view renders
   *  the live WebGL scene at exactly that resolution so it lands 1:1. */
  paintMap: (t: number, g: CanvasRenderingContext2D, mapSizePx: number) => void;
  /** Panel/header word bundle (caller i18n's every word). */
  panelLabels: PlaybackPanelLabels;
  /** Paint the team columns' stat band (labels + averages + values).
   *  False = no stat tracks anywhere in the clip. */
  showStats: boolean;
  onProgress?: (done: number, total: number) => void;
  /** Coarse phase for the progress card: frames vs the encoder/muxer
   *  flush (the latter reports no percentage — the card goes
   *  indeterminate instead of sitting frozen at 100%). The renderer only
   *  ever raises `render` / `finalize`; the card's pre-render stages
   *  (`feed` / `models`) are the caller's own. */
  onPhase?: (phase: PlaybackExportPhase) => void;
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
  /** Caption of the header's team-averages row ("Avg"). */
  teamAvg: string;
  /** Shown instead of the averages when the stats config has no
   *  columns left (every stat column removed / PR master off). */
  noStats: string;
  damage: string;
  dmgFrags: string;
  dmgTaken: string;
  /** Caption over the recorder's ribbon strip. */
  ribbonsTitle: string;
  /** The two damage-source column captions (dealt / taken). */
  dmgDealtSources: string;
  dmgTakenSources: string;
  chat: string;
}

/** Compose one full frame (header + map + side panels + footer) in device
 *  px. The map paints FIRST — its seek brings every shared data structure
 *  to `t`, and the header/panels read that state right after.
 *
 *  The map layer is painted with `g` ALREADY translated to the square's
 *  top-left and scaled, and clipped to the square: `paintMap` must paint in
 *  that space (logical 0..EXPORT_LOGICAL), never under the identity
 *  transform — the 3D bridge's WebGL blit depends on this origin contract.
 *  Exported so the contract is unit-tested. */
export function composePlaybackFrame(
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
  req.paintMap(t, ctx, layout.mapSize);
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
  drawPlaybackTeamColumn(
    ctx,
    0,
    colTop + EXPORT_TEAM_INSET,
    EXPORT_SIDE_W,
    team.allies,
    "ally",
    ALLY_INK,
    req.panelLabels.teamAlly,
    req.palette,
    req.panelLabels,
    req.shipIconFor,
    req.showStats,
  );
  if (recorder) {
    drawRecorderPanel(
      ctx,
      0,
      colTop + EXPORT_TEAM_H + EXPORT_RECORDER_TOP_GAP,
      EXPORT_SIDE_W,
      recorderPanelHeight(colH),
      recorder,
      req.palette,
      req.panelLabels,
      req.ribbonIconFor,
    );
  }
  drawColumnBase(ctx, colRight, EXPORT_SIDE_W, colTop, colH, req.palette, "left");
  drawPlaybackTeamColumn(
    ctx,
    colRight,
    colTop + EXPORT_TEAM_INSET,
    EXPORT_SIDE_W,
    team.enemies,
    "enemy",
    ENEMY_INK,
    req.panelLabels.teamEnemy,
    req.palette,
    req.panelLabels,
    req.shipIconFor,
    req.showStats,
  );
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
        composePlaybackFrame(g, layout, req, t);
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
    composePlaybackFrame(ctx, layout, req, t);
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
