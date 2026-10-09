/**
 * Share-shot renderer for the live self-stats panel (我的战绩): paints the
 * personal battle-so-far report onto an offscreen canvas and returns PNG
 * bytes for the clipboard copy — the same hand-drawn-canvas approach and
 * shared kit as the post-battle matrix shot (postBattleShot.ts): no DOM
 * rasterization, nicknames arrive already masked, and the watermarked footer
 * rides along regardless of window state.
 *
 * Layout mirrors the panel: head (title + mode pill + map/同步至 line), the
 * self identity line, a summary stat strip (damage / plane damage / hits /
 * taken / frags — exp once final), the achievements run, then the two
 * per-ship damage columns (dealt / received) with the shared estimate
 * footnote.
 */
import { shipIconUrl, type ShipIconVariant } from "@/features/holographic/shipIcons";
import {
  FOOT_H,
  LOGO_URL,
  PAD,
  canvasToPngBytes,
  drawFooter,
  font,
  footerMinWidth,
  loadImage,
  newShotCanvas,
  readPalette,
  rgba,
  type ShotFooterStrings,
} from "@/features/share/shotKit";

/** One label+value cell of the summary strip. */
export interface SelfShotStat {
  label: string;
  value: string;
  color?: string;
}

/** One per-ship row of the dealt/received columns. `nick` arrives ALREADY
 *  masked by the caller — the renderer never sees a hidden nickname. */
export interface SelfShotRow {
  nick: string;
  shipName: string;
  bot?: boolean;
  /** The ship is down (dimmed row). */
  sunk?: boolean;
  /** I sank this ship — the kill marker paints after the damage figure. */
  killed?: boolean;
  shipType?: string | null;
  iconVariant?: ShipIconVariant;
  /** Formatted damage figure (mono right-aligned). */
  damage: string;
}

export interface SelfShotColumn {
  title: string;
  rows: SelfShotRow[];
  /** Placeholder when the column has no rows yet. */
  emptyLabel?: string;
}

export interface SelfShotModel {
  title: string;
  mode?: { label: string; color?: string; background?: string } | null;
  mapLabel?: string | null;
  /** Right-aligned provenance line (同步至 M:SS / 结算完成). */
  metaLine?: string | null;
  /** My nick · ship line under the title. */
  selfLine: string;
  summary: SelfShotStat[];
  /** The damage-composition line (伤害组成 chips), already localized. */
  compLine?: string | null;
  /** Localized achievement names (duplicates already folded by the caller). */
  achievements?: string[];
  columns: SelfShotColumn[];
  /** The estimate footnote (attribution by hit points is approximate). */
  estimateNote?: string | null;
  botLabel?: string;
  killLabel?: string;
}

const COL_WIDTH = 460;
const COL_GAP = 16;
const ROW_H = 40;
const HEAD_H = 66;
const SELF_LINE_H = 30;
const SUMMARY_H = 52;
const COMP_H = 30;
const ACH_H = 30;
const COL_TITLE_H = 30;
const NOTE_H = 24;

/** Paint the self-stats share shot and return PNG bytes. `el` supplies the
 *  theme palette; the footer strings are the localized watermark lines. */
export async function renderLiveSelfShot(
  model: SelfShotModel,
  opts: { el?: HTMLElement | null } & ShotFooterStrings,
): Promise<Uint8Array> {
  const palette = readPalette(opts.el);
  const width = Math.max(PAD * 2 + 2 * COL_WIDTH + COL_GAP, footerMinWidth(opts, true));
  // The height budget must count each column's placeholder row too — an
  // empty column still paints its emptyLabel card (a both-empty early-battle
  // shot would otherwise overflow into the estimate note and footer).
  const maxRows = Math.max(
    ...model.columns.map((c) => c.rows.length + (c.rows.length === 0 && c.emptyLabel ? 1 : 0)),
    0,
  );
  const hasAch = (model.achievements?.length ?? 0) > 0;
  const hasComp = !!model.compLine;
  const height =
    HEAD_H +
    SELF_LINE_H +
    SUMMARY_H +
    (hasComp ? COMP_H : 0) +
    (hasAch ? ACH_H : 0) +
    COL_TITLE_H +
    maxRows * (ROW_H + 6) +
    10 +
    (model.estimateNote ? NOTE_H : 0) +
    FOOT_H;

  const { canvas, ctx } = newShotCanvas(width, height, palette);
  ctx.textBaseline = "middle";

  // ── head: title + mode pill left, map/meta right (postBattleShot's look).
  ctx.textAlign = "left";
  ctx.font = font(21, 700);
  ctx.fillStyle = rgba(palette.text, 1);
  let hx = PAD;
  ctx.fillText(model.title, hx, HEAD_H / 2 + 2);
  hx += ctx.measureText(model.title).width + 16;
  if (model.mode) {
    ctx.font = font(12.5, 600);
    const tw = ctx.measureText(model.mode.label).width;
    const pillH = 24;
    const pillY = HEAD_H / 2 - pillH / 2 + 2;
    ctx.fillStyle = model.mode.background ?? rgba(palette.text, 0.14);
    ctx.beginPath();
    ctx.roundRect(hx, pillY, tw + 18, pillH, pillH / 2);
    ctx.fill();
    ctx.fillStyle = model.mode.color ?? rgba(palette.text, 1);
    ctx.fillText(model.mode.label, hx + 9, pillY + pillH / 2);
  }
  if (model.mapLabel || model.metaLine) {
    ctx.textAlign = "right";
    const rx = width - PAD;
    ctx.font = font(14, 400);
    ctx.fillStyle = rgba(palette.muted, 1);
    ctx.fillText((model.mapLabel ?? model.metaLine)!, rx, HEAD_H / 2 - 8);
    if (model.mapLabel && model.metaLine) {
      ctx.font = font(11, 400);
      ctx.fillStyle = rgba(palette.muted, 0.72);
      ctx.fillText(model.metaLine, rx, HEAD_H / 2 + 12);
    }
    ctx.textAlign = "left";
  }
  ctx.fillStyle = rgba(palette.text, 0.1);
  ctx.fillRect(PAD, HEAD_H - 6, width - PAD * 2, 1);

  // ── self line + summary strip.
  let y = HEAD_H;
  ctx.font = font(15, 700);
  ctx.fillStyle = rgba(palette.text, 0.92);
  ctx.fillText(model.selfLine, PAD, y + SELF_LINE_H / 2);
  y += SELF_LINE_H;

  // Summary cells: label over mono value, evenly spread over the width.
  ctx.textAlign = "center";
  const cellW = (width - PAD * 2) / Math.max(model.summary.length, 1);
  model.summary.forEach((s, i) => {
    const cx = PAD + cellW * (i + 0.5);
    ctx.font = font(10.5, 400);
    ctx.fillStyle = rgba(palette.text, 0.5);
    ctx.fillText(s.label, cx, y + 14);
    ctx.font = font(15, 700, true);
    ctx.fillStyle = s.color ?? rgba(palette.text, 0.9);
    ctx.fillText(s.value, cx, y + 34);
  });
  ctx.textAlign = "left";
  y += SUMMARY_H;

  // ── damage-composition line (the same muted chips style as the
  //    achievements run below).
  if (hasComp) {
    ctx.font = font(11.5, 500);
    ctx.fillStyle = rgba(palette.text, 0.62);
    ctx.fillText(model.compLine!, PAD, y + COMP_H / 2, width - PAD * 2);
    y += COMP_H;
  }

  // ── achievements run (muted chips, single ellipsized line).
  if (hasAch) {
    const names = model.achievements!.join("  ·  ");
    ctx.font = font(11.5, 500);
    ctx.fillStyle = rgba(palette.text, 0.62);
    ctx.fillText(names, PAD, y + ACH_H / 2, width - PAD * 2);
    y += ACH_H;
  }

  // ── damage columns.
  const icons = await Promise.all([
    ...model.columns.flatMap((c) =>
      c.rows.map((r) => loadImage(shipIconUrl(r.shipType, r.iconVariant ?? "plain"))),
    ),
    loadImage(LOGO_URL),
  ]);
  const logo = icons.pop() ?? null;
  let iconIdx = 0;
  for (let ci = 0; ci < model.columns.length; ci++) {
    const col = model.columns[ci];
    const cx = PAD + ci * (COL_WIDTH + COL_GAP);
    const cy0 = y;
    ctx.font = font(13, 600);
    ctx.fillStyle = rgba(palette.text, 0.55);
    ctx.fillText(col.title, cx, cy0 + COL_TITLE_H / 2);
    let ry = cy0 + COL_TITLE_H;
    if (col.rows.length === 0 && col.emptyLabel) {
      ctx.font = font(12, 400);
      ctx.fillStyle = rgba(palette.text, 0.38);
      ctx.fillText(col.emptyLabel, cx, ry + ROW_H / 2, COL_WIDTH);
      ry += ROW_H + 6;
    }
    for (const row of col.rows) {
      const rcy = ry + ROW_H / 2;
      ctx.globalAlpha = row.sunk ? 0.55 : 1;
      ctx.fillStyle = rgba(palette.text, 0.05);
      ctx.beginPath();
      ctx.roundRect(cx, ry, COL_WIDTH, ROW_H, 8);
      ctx.fill();

      let tx = cx + 12;
      const icon = icons[iconIdx++];
      if (icon) ctx.drawImage(icon, tx, rcy - 9, 18, 18);
      tx += 26;

      // Damage figure (mono, right-aligned) + kill marker after it.
      ctx.font = font(13.5, 700, true);
      ctx.textAlign = "right";
      const dmgX = cx + COL_WIDTH - 14;
      ctx.fillStyle = rgba(palette.text, 0.88);
      ctx.fillText(row.damage, dmgX, rcy);
      let rightW = ctx.measureText(row.damage).width + 10;
      if (row.killed && model.killLabel) {
        ctx.font = font(11, 700);
        ctx.fillStyle = "rgb(239 68 68)";
        ctx.fillText(model.killLabel, dmgX - rightW, rcy);
        rightW += ctx.measureText(model.killLabel).width + 6;
      }
      ctx.textAlign = "left";

      // Nick (+bot) over ship name, bounded before the damage figure.
      const textW = Math.max(cx + COL_WIDTH - 14 - rightW - 8 - tx, 56);
      ctx.font = font(14, 600);
      ctx.fillStyle = rgba(palette.text, 1);
      let nick = row.nick;
      if (row.bot) nick += `  · ${model.botLabel ?? "AI"}`;
      ctx.fillText(nick, tx, rcy - 8, textW);
      ctx.font = font(11.5, 400);
      ctx.fillStyle = rgba(palette.text, 0.5);
      ctx.fillText(row.shipName, tx, rcy + 9, textW);
      ctx.globalAlpha = 1;
      ry += ROW_H + 6;
    }
  }
  y += COL_TITLE_H + maxRows * (ROW_H + 6) + 10;

  // ── estimate footnote + footer.
  if (model.estimateNote) {
    ctx.font = font(10.5, 400);
    ctx.fillStyle = rgba(palette.muted, 0.8);
    ctx.fillText(model.estimateNote, PAD, y + NOTE_H / 2, width - PAD * 2);
  }
  drawFooter(ctx, palette, width, opts, logo);
  return canvasToPngBytes(canvas);
}
