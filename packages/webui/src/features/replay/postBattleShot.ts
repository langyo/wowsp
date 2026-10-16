/**
 * Share-shot renderer for the post-battle panels: paints the two-column
 * result matrix onto an offscreen canvas and returns PNG bytes, ready for the
 * clipboard copy (`api.copyImageToClipboard`) or a save-file fallback.
 *
 * The image is a hand-drawn canvas composite built on the shared share-shot
 * kit (features/share/shotKit.ts — palette, fonts, seal painter and the
 * fixed WoWSP watermark footer) rather than a DOM rasterization on purpose:
 * the share shot must be deterministic (no hover states, no scrollbars, no
 * ship parameters ever), must apply the nickname masking the user chose, and
 * must carry the watermark footer regardless of the window state the panel
 * happens to be in.
 *
 * Ship class icons are the same bundled HUD-marker PNGs the minimap canvas
 * draws (same-origin vite assets, so the canvas never taints).
 */
import { shipIconUrl, type ShipIconVariant } from "@/features/holographic/shipIcons";
import {
  FOOT_H,
  LOGO_URL,
  PAD,
  STAMP_URL,
  canvasToPngBytes,
  drawFooter,
  drawStampSeal,
  font,
  footerMinWidth,
  loadImage,
  newShotCanvas,
  readPalette,
  rgba,
  statCellOrigins,
  type ShotFooterStrings,
} from "@/features/share/shotKit";
import type { CareerStamp } from "@/utils/winrate";

/** One right-aligned stat cell of a row (WR / PR / battles / avg damage
 *  / base XP — whichever columns the chip toggles admit). */
export interface ShotStat {
  text: string;
  /** Tier color for the value (winrateColor / prTier / damageColor output). */
  color?: string;
}

/** One player row. `nick` arrives ALREADY masked by the caller — the
 *  renderer never sees a hidden nickname, so one cannot leak into the image. */
export interface ShotRow {
  nick: string;
  clanTag?: string | null;
  shipName: string;
  bot?: boolean;
  /** Sunk / dead: the whole row renders dimmed, like the panel's dead cells. */
  dim?: boolean;
  /** Ship-class HUD icon (bundled PNG url) + its variant. */
  shipType?: string | null;
  iconVariant?: ShipIconVariant;
  /** Career seal (神了/猴/蛆/过街老鼠) pressed onto the row-end slot the
   *  renderer reserves whenever ANY row carries one — the caller applies
   *  the settings gates, so a disabled seal never arrives here. */
  stamp?: CareerStamp | null;
  stats: ShotStat[];
}

/** One label+value pair of the column-title aggregate (team mean WR / mean
 *  PR): `col` is the stat column index whose x-origin the value right-aligns
 *  onto, so the header numbers line up with the cells below them. */
export interface ShotAgg {
  col: number;
  label: string;
  value: string;
  valueColor?: string;
}

/** Column aggregate riding the title, like the panels' column captions. */
export interface ShotColumn {
  title: string;
  agg?: ShotAgg[];
  rows: ShotRow[];
}

export interface ShotModel {
  title: string;
  /** Mode pill: text color + pill background (modeColor() output). */
  mode?: { label: string; color?: string; background?: string } | null;
  mapLabel?: string | null;
  /** Provenance line under the map label (server · game version · battle
   *  time · duration); composed by the caller, absent parts drop out. */
  metaLine?: string | null;
  /** Short bot marker label appended after masked/plain nicks (t("replay.bot")). */
  botLabel?: string;
  columns: ShotColumn[];
}

/** Canvas logical width of one roster column (the image renders 2× for
 *  crispness, so these are pre-scale units). */
const COL_WIDTH = 620;
const COL_GAP = 16;
/** Visual gap between adjacent stat cells of a row. At 26 the widest mono
 *  neighbors (PR digits against the damage figure, e.g. "1880 104,751")
 *  read as one merged number in the pasted image — the columns need this
 *  much air before the eye separates them. */
const STAT_GAP = 36;
/** Career-seal column: a fixed slot after the last stat cell, reserved
 *  whenever any row carries a stamp so the stat columns stay put. */
const STAMP_SIZE = 34;
const STAMP_SLOT = STAMP_SIZE + 4;
const ROW_H = 44;
const HEAD_H = 66;
const COL_TITLE_H = 34;

/** Measure the widest right-aligned stat cell per column index so every row's
 *  cells share one x-origin — the aligned-table look of the live panel. */
function statOrigins(
  ctx: CanvasRenderingContext2D,
  columns: ShotColumn[],
): number[] {
  return statCellOrigins(
    ctx,
    columns.flatMap((c) => c.rows.map((r) => r.stats.map((s) => s.text))),
    STAT_GAP,
  );
}

/** Paint the share shot and return PNG bytes. `el` (any live panel element)
 * supplies the theme palette; the footer strings are the localized watermark
 * lines (see ShotFooterStrings). */
export async function renderPostBattleShot(
  model: ShotModel,
  opts: { el?: HTMLElement | null } & ShotFooterStrings,
): Promise<Uint8Array> {
  const palette = readPalette(opts.el);
  const cols = model.columns;
  // A single-team column lands below the footer's no-overlap minimum —
  // floor the content width on it so the watermark lines never collide.
  // Sized for the logo present: it loads for the footer in the normal path.
  const width = Math.max(
    PAD * 2 + cols.length * COL_WIDTH + (cols.length - 1) * COL_GAP,
    footerMinWidth(opts, true),
  );
  const maxRows = Math.max(...cols.map((c) => c.rows.length), 0);
  const height = HEAD_H + COL_TITLE_H + maxRows * (ROW_H + 6) + 10 + FOOT_H;

  const { canvas, ctx } = newShotCanvas(width, height, palette);

  // Header: title, mode pill, map (right).
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = font(21, 700);
  ctx.fillStyle = rgba(palette.text, 1);
  let hx = PAD;
  ctx.fillText(model.title, hx, HEAD_H / 2 + 2);
  hx += ctx.measureText(model.title).width + 16;
  if (model.mode) {
    ctx.font = font(12.5, 600);
    const label = model.mode.label;
    const tw = ctx.measureText(label).width;
    const pillH = 24;
    const pillY = HEAD_H / 2 - pillH / 2 + 2;
    ctx.fillStyle = model.mode.background ?? rgba(palette.text, 0.14);
    ctx.beginPath();
    ctx.roundRect(hx, pillY, tw + 18, pillH, pillH / 2);
    ctx.fill();
    ctx.fillStyle = model.mode.color ?? rgba(palette.text, 1);
    ctx.fillText(label, hx + 9, pillY + pillH / 2);
    hx += tw + 18 + 14;
  }
  if (model.mapLabel || model.metaLine) {
    ctx.textAlign = "right";
    const rx = width - PAD;
    if (model.mapLabel && model.metaLine) {
      // Two stacked lines: the map stays the headline, the provenance line
      // rides beneath it in a smaller muted face.
      ctx.font = font(14, 400);
      ctx.fillStyle = rgba(palette.muted, 1);
      ctx.fillText(model.mapLabel, rx, HEAD_H / 2 - 8);
      ctx.font = font(11, 400);
      ctx.fillStyle = rgba(palette.muted, 0.72);
      ctx.fillText(model.metaLine, rx, HEAD_H / 2 + 12);
    } else {
      ctx.font = font(14, 400);
      ctx.fillStyle = rgba(palette.muted, 1);
      ctx.fillText((model.mapLabel ?? model.metaLine)!, rx, HEAD_H / 2 + 2);
    }
    ctx.textAlign = "left";
  }
  ctx.fillStyle = rgba(palette.text, 0.1);
  ctx.fillRect(PAD, HEAD_H - 6, width - PAD * 2, 1);

  // Pre-measure stat cell widths with the row font active. The block's
  // total width also bounds the nick text (see the row loop) — and the
  // same origins anchor the column-title aggregate values.
  ctx.font = font(13.5, 600, true);
  const origins = statOrigins(ctx, cols);
  // The seal column rides the right edge: reserve its slot only when some
  // row actually carries a stamp, so seal-less shots keep today's metrics.
  const hasStamps = cols.some((c) => c.rows.some((r) => r.stamp));
  const statsW = (origins[origins.length - 1] ?? 0) + 24 + (hasStamps ? STAMP_SLOT : 0);

  // Column titles (+ aggregate) and rows. The footer's logo loads alongside
  // the class icons so the paint never waits twice on the network.
  const icons = await Promise.all([
    ...cols.flatMap((c) =>
      c.rows.map((r) => loadImage(shipIconUrl(r.shipType, r.iconVariant ?? "plain"))),
    ),
    loadImage(LOGO_URL),
  ]);
  const logo = icons.pop() ?? null;
  // Seal faces load in a second wave (bundled same-origin PNGs, so this
  // settles near-instantly and only when seals are on at all).
  const stampImages = new Map<CareerStamp, HTMLImageElement | null>();
  if (hasStamps) {
    const kinds = [
      ...new Set(
        cols
          .flatMap((c) => c.rows.map((r) => r.stamp))
          .filter((k): k is CareerStamp => !!k),
      ),
    ];
    await Promise.all(
      kinds.map(async (k) => stampImages.set(k, await loadImage(STAMP_URL[k]))),
    );
  }
  let iconIdx = 0;
  for (let ci = 0; ci < cols.length; ci++) {
    const col = cols[ci];
    const cx = PAD + ci * (COL_WIDTH + COL_GAP);
    let y = HEAD_H;

    // Title + aggregate. The aggregate is a two-line mini table header —
    // tiny label over a mono value — with the value right-aligned onto its
    // stat column (same origins as the row cells below). A single-line
    // label-before-value run cannot work here: the inter-column gap is
    // narrower than a CJK label, so it would overlap the previous value.
    const ty = y + COL_TITLE_H / 2;
    ctx.textAlign = "left";
    ctx.font = font(13, 600);
    ctx.fillStyle = rgba(palette.text, 0.55);
    ctx.fillText(col.title, cx, ty);
    if (col.agg?.length) {
      const base = cx + COL_WIDTH - 14 - statsW;
      ctx.textAlign = "right";
      for (const part of col.agg) {
        const vx = base + (origins[part.col] ?? 0);
        ctx.font = font(10.5, 400);
        ctx.fillStyle = rgba(palette.text, 0.5);
        ctx.fillText(part.label, vx, ty - 10);
        ctx.font = font(12.5, 600, true);
        ctx.fillStyle = part.valueColor ?? rgba(palette.text, 0.85);
        ctx.fillText(part.value, vx, ty + 7);
      }
      ctx.textAlign = "left";
    }

    y += COL_TITLE_H;

    for (const row of col.rows) {
      const cy = y + ROW_H / 2;
      ctx.globalAlpha = row.dim ? 0.5 : 1;

      // Row card.
      ctx.fillStyle = rgba(palette.text, 0.05);
      ctx.beginPath();
      ctx.roundRect(cx, y, COL_WIDTH, ROW_H, 8);
      ctx.fill();

      // Ship class icon.
      let tx = cx + 12;
      const icon = icons[iconIdx++];
      if (icon) {
        ctx.drawImage(icon, tx, cy - 10, 20, 20);
      }
      tx += 28;

      // Nick (+clan, +bot) and ship name stacked. The draw width stops
      // before the stat cells' left edge (measured above), so a long nick
      // ellipsizes instead of painting over the WR column.
      const statLeft = cx + COL_WIDTH - 14 - statsW;
      const textW = Math.max(statLeft - 8 - tx, 60);
      ctx.textAlign = "left";
      ctx.font = font(14.5, 600);
      ctx.fillStyle = rgba(palette.text, 1);
      let nick = row.nick;
      if (row.clanTag) nick += `  [${row.clanTag}]`;
      if (row.bot) nick += `  · ${model.botLabel ?? "AI"}`;
      ctx.fillText(nick, tx, cy - 8, textW);
      ctx.font = font(12, 400);
      ctx.fillStyle = rgba(palette.text, 0.5);
      ctx.fillText(row.shipName, tx, cy + 10, textW);

      // Right-aligned stat cells, then nothing else — ship parameters are
      // never part of the share model by construction.
      ctx.font = font(13.5, 600, true);
      ctx.textAlign = "right";
      row.stats.forEach((s, i) => {
        const x = cx + COL_WIDTH - 14 - statsW + (origins[i] ?? 0);
        ctx.fillStyle = s.color ?? rgba(palette.text, 0.85);
        ctx.fillText(s.text, x, cy);
      });
      // The career seal: RatingStamp's face redrawn in canvas, pressed onto
      // the row-end slot reserved above (mini variant, see drawStampSeal).
      if (row.stamp) {
        drawStampSeal(
          ctx,
          cx + COL_WIDTH - 14 - STAMP_SIZE / 2,
          cy,
          STAMP_SIZE,
          stampImages.get(row.stamp) ?? null,
          "mini",
        );
      }
      ctx.globalAlpha = 1;
      y += ROW_H + 6;
    }
  }

  drawFooter(ctx, palette, width, opts, logo);
  return canvasToPngBytes(canvas);
}
