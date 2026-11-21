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
 *   │ roster   │   map square (the same   │ roster │
 *   │ header + │   enlarged-map painter)  │ header +
 *   │ 3-line   │  ship labels over every  │ 3-line │
 *   │ rows     │        glyph             │ rows   │
 *   │ ──────── │                          │ ───────│
 *   │ recorder │                          │ chat   │
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
import type { EntityTrajectory, ShotKillEvent } from "@/api";

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
 *  · winner right): two small dim lines each, clear of the centre pill. */
export const EXPORT_HEADER_CORNER_INSET = 10;
export const EXPORT_HEADER_CORNER_CY: readonly [number, number] = [10, 28];
export const EXPORT_HEADER_CORNER_FONTS: readonly [number, number] = [10, 9];
export const EXPORT_HEADER_CORNER_ALPHAS: readonly [number, number] = [0.62, 0.5];
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
 *   128 .. 171  ribbon strip: a 10px caption + TWO 15px rows of icon+count
 *               cells, 4 per row — 8 cells cover the app's whole
 *               authoritative set (7 kinds, RIBBON_SOURCES)
 *   181 .. 264  two damage-source columns: a 10px caption + 5 rows at 14px
 *   => 264 <= 292: 28px of slack, so no band can clip the column's bottom.
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
/** Ribbon strip: caption band + two cell rows. */
export const EXPORT_RECORDER_RIBBON_CAPTION_H = 13;
export const EXPORT_RECORDER_RIBBON_ROW_H = 15;
export const EXPORT_RECORDER_RIBBON_ROWS = 2;
export const EXPORT_RECORDER_RIBBON_COLS = 4;
/** Icon height (the bundled ribbon art is 40 x 15 — the wide end-screen
 *  strip, so a cell gives the icon ~20px and the count the rest). */
export const EXPORT_RECORDER_RIBBON_ICON_H = 7.5;
export const EXPORT_RECORDER_RIBBON_ICON_W =
  (EXPORT_RECORDER_RIBBON_ICON_H * 40) / 15;
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
  damage: number;
  frags: number;
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
  // ── Corner blocks: the map/mode/start-time identity on the LEFT, the
  //    total duration + winner verdict on the RIGHT. Two small dim lines
  //    each, sized to the gap between the frame edge and the pill so they
  //    can never run under it (the pill keeps the centre). ─────────────
  const cornerInset = EXPORT_HEADER_CORNER_INSET;
  const leftMax = Math.max(0, pillX - cornerInset * 2);
  const rightMax = Math.max(0, w - (pillX + pillW) - cornerInset * 2);
  const drawCorner = (
    lines: readonly string[] | undefined,
    align: "left" | "right",
    maxW: number,
  ): void => {
    if (!lines || lines.length === 0 || maxW <= 4) return;
    g.textAlign = align;
    lines.slice(0, 2).forEach((line, i) => {
      if (!line) return;
      g.font = font(EXPORT_HEADER_CORNER_FONTS[i], i === 0 ? 600 : 400);
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
    // empty rail, exactly as before).
    const barX = x + inset;
    const barW = w - inset * 2;
    g.fillStyle = rgba(palette.text, 0.14);
    g.fillRect(barX, ry + EXPORT_TEAM_HP_TOP, barW, EXPORT_TEAM_HP_H);
    if (row.hpFrac != null && !row.dead) {
      const frac = Math.min(1, Math.max(0, row.hpFrac));
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

/** The recorder's ribbon strip: a caption over TWO rows of icon+count cells
 *  (4 per row), painted in the settlement's own order. The bundled end-screen
 *  art identifies the kind (no per-ribbon word is needed, and the art is
 *  language-neutral); a cell whose art was not preloaded keeps a neutral
 *  capsule in the slot so the count still lands in place. */
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
  // The app's authoritative set is 7 kinds, so 8 cells hold it without a
  // cut; the slice is the contract the budget test asserts against
  // RIBBON_SOURCES.
  ribbons.slice(0, cells).forEach((rib, i) => {
    const cx = x + (i % EXPORT_RECORDER_RIBBON_COLS) * cellW;
    const cy = firstCy + Math.floor(i / EXPORT_RECORDER_RIBBON_COLS) * EXPORT_RECORDER_RIBBON_ROW_H;
    const icon = ribbonIconFor(rib.key);
    if (icon) {
      g.drawImage(
        icon,
        cx,
        cy - EXPORT_RECORDER_RIBBON_ICON_H / 2,
        EXPORT_RECORDER_RIBBON_ICON_W,
        EXPORT_RECORDER_RIBBON_ICON_H,
      );
    } else {
      g.fillStyle = rgba(palette.text, 0.12);
      g.beginPath();
      g.roundRect(
        cx,
        cy - EXPORT_RECORDER_RIBBON_ICON_H / 2,
        EXPORT_RECORDER_RIBBON_ICON_W,
        EXPORT_RECORDER_RIBBON_ICON_H,
        2,
      );
      g.fill();
    }
    // The count rides IMMEDIATELY after its icon: a right-aligned count
    // would sit next to the FOLLOWING cell's icon and read as that icon's
    // number. The remaining cell width is the count's cap.
    const countW = Math.max(6, cellW - EXPORT_RECORDER_RIBBON_ICON_W - 3);
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
    g.fillText(
      ellipsize(g, text, countW),
      cx + EXPORT_RECORDER_RIBBON_ICON_W + 3,
      cy + 0.5,
    );
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
  /** Each side's roster + its header columns (label + team average) at
   *  each frame's battle time (read AFTER the seek). */
  team: (t: number) => { allies: PlaybackTeamSide; enemies: PlaybackTeamSide };
  /** The recorder's damage/frags/taken at each battle time. */
  recorder: (t: number) => PlaybackRecorderStats | null;
  /** Chat lines up to each battle time, oldest first. */
  chat: (t: number) => PlaybackChatLine[];
  /** Ship-class HUD icon resolver for the header strip — the caller
   *  preloads (decodes) every class×variant once before the render loop.
   *  Return null to skip a slot. */
  shipIconFor: (shipType: string | null, variant: PlaybackIconVariant) => HTMLImageElement | null;
  /** Ribbon-art resolver for the recorder's strip — the caller preloads the
   *  bundled settlement icons once (bundledRibbonUrl). Null skips the art
   *  and keeps the cell's neutral capsule. */
  ribbonIconFor: (key: string) => HTMLImageElement | null;
  /** Paint the map square for battle time `t` in logical units onto `g`
   *  (already translated to the map's top-left corner and scaled). */
  paintMap: (t: number, g: CanvasRenderingContext2D) => void;
  /** Panel/header word bundle (caller i18n's every word). */
  panelLabels: PlaybackPanelLabels;
  /** Paint the team columns' stat band (labels + averages + values).
   *  False = no stat tracks anywhere in the clip. */
  showStats: boolean;
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
