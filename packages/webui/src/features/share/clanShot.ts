/**
 * Share-shot renderer for the clan water-table card (the lookup's clan
 * mode): paints the ClanCard's content — [TAG] identity, clan-wide hero
 * winrate / avg PR, the KPI strip and the top of the roster table (current
 * default order: officers first, battles desc, capped by the caller and
 * drawn as two side-by-side columns so a wide roster keeps the poster's
 * aspect sane) — onto an offscreen canvas via the shared shot kit, and
 * returns PNG bytes for the clipboard copy flow (useShareImage).
 *
 * Same contract as the other shots: plain-data model, colors pre-resolved
 * by the caller, live theme palette, fixed WoWSP watermark footer. Hidden
 * members keep their row (dimmed, em-dash stats) exactly like the live
 * card — hiding them from a clan share would misrepresent the roster.
 */
import type { StatsShotKpi } from "./statsShot";
import {
  FOOT_H,
  LOGO_URL,
  PAD,
  canvasToPngBytes,
  drawFooter,
  ellipsize,
  footerMinWidth,
  font,
  loadImage,
  newShotCanvas,
  rainbowFill,
  readPalette,
  rgba,
  shareFooterStrings,
  statCellOrigins,
} from "./shotKit";

/** One roster row: member name + localized role + right-aligned stat cells
 *  (battles / winrate / PR when on / avg damage). */
export interface ClanShotMember {
  name: string;
  role: string;
  /** Hidden profile → the whole row renders dimmed, like the card's rows. */
  dim?: boolean;
  cells: { text: string; color?: string; rainbow?: boolean }[];
}

export interface ClanShotModel {
  /** Page title (水表查询); the clan mode rides the identity row. */
  title: string;
  realm?: string | null;
  name: string;
  tag: string;
  /** One-line clan description (ellipsized by the renderer). */
  description?: string | null;
  /** PR master switch — off hides the PR column and the hero PR block. */
  prOn: boolean;
  hero: {
    winrate: string;
    winrateColor?: string;
    winrateLabel: string;
    battlesText: string;
    pr?: string | null;
    prColor?: string;
    /** 彩表 tier — render the PR number with the rainbow gradient. */
    prRainbow?: boolean;
    prLabel?: string;
  };
  kpis: StatsShotKpi[];
  membersTitle: string;
  membersHead: string[];
  members: ClanShotMember[];
  /** Trailing "+N more members" note when the roster was capped. */
  moreMembers?: string | null;
}

/** Canvas logical width: two roster columns side by side keep the poster's
 *  aspect sane at the caller's member cap (13 rows tall for 25), and every
 *  section — including a roster name clear of the battles column — keeps
 *  room to breathe; floored at the footer's no-overlap minimum so the
 *  watermark lines can never collide. */
const BASE_WIDTH = 1060;
const HEAD_H = 66;
const IDENTITY_H = 48;
const DESC_H = 24;
const HERO_H = 92;
const KPI_CELL_H = 60;
const KPI_GAP = 8;
const MEMBER_TITLE_H = 30;
const MEMBER_HEAD_H = 22;
const ROW_H = 44;
const STAT_GAP = 36;
/** Air between the two roster columns. */
const COL_GAP = 16;

export async function renderClanShot(
  model: ClanShotModel,
  opts: { el?: HTMLElement | null },
): Promise<Uint8Array> {
  const palette = readPalette(opts.el);
  const footer = shareFooterStrings();
  // Logo first: its presence (with the localized watermark copy) decides
  // the width floor before anything is laid out.
  const logo = await loadImage(LOGO_URL);
  const width = Math.max(BASE_WIDTH, footerMinWidth(footer, !!logo));
  const kpiCount = model.kpis.length;
  const memberCount = model.members.length;
  const hasMembers = memberCount > 0;
  const memberRows = Math.ceil(memberCount / 2);

  let height = HEAD_H + IDENTITY_H + (model.description ? DESC_H : 0) + HERO_H;
  if (kpiCount > 0) height += KPI_CELL_H + 8;
  if (hasMembers) {
    height += MEMBER_TITLE_H + MEMBER_HEAD_H + memberRows * (ROW_H + 6);
    if (model.moreMembers) height += 20;
  }
  height += FOOT_H;

  const { canvas, ctx } = newShotCanvas(width, height, palette);

  // Header: title, realm (right), hairline.
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = font(21, 700);
  ctx.fillStyle = rgba(palette.text, 1);
  ctx.fillText(model.title, PAD, HEAD_H / 2 + 2);
  if (model.realm) {
    ctx.textAlign = "right";
    ctx.font = font(14, 400);
    ctx.fillStyle = rgba(palette.muted, 1);
    ctx.fillText(model.realm.toUpperCase(), width - PAD, HEAD_H / 2 + 2);
    ctx.textAlign = "left";
  }
  ctx.fillStyle = rgba(palette.text, 0.1);
  ctx.fillRect(PAD, HEAD_H - 6, width - PAD * 2, 1);

  // Identity row: [TAG] + clan name (clan cards always carry a tag).
  const iy = HEAD_H + IDENTITY_H / 2;
  ctx.font = font(14, 700);
  const tagText = `[${model.tag}]`;
  const tagW = ctx.measureText(tagText).width + 10;
  ctx.fillStyle = rgba(palette.primary, 1);
  ctx.fillText(tagText, PAD, iy);
  ctx.font = font(17, 700);
  ctx.fillStyle = rgba(palette.text, 1);
  ctx.fillText(ellipsize(ctx, model.name, Math.max(width - PAD * 2 - tagW, 60)), PAD + tagW, iy);
  let y = HEAD_H + IDENTITY_H;

  // Optional one-line description.
  if (model.description) {
    ctx.font = font(12, 400);
    ctx.fillStyle = rgba(palette.muted, 0.9);
    ctx.fillText(ellipsize(ctx, model.description, width - PAD * 2), PAD, y + DESC_H / 2);
    y += DESC_H;
  }

  // Hero band: clan-wide winrate + total battles left, avg member PR right.
  ctx.font = font(32, 700);
  ctx.fillStyle = model.hero.winrateColor ?? rgba(palette.text, 1);
  ctx.fillText(model.hero.winrate, PAD, y + 28);
  ctx.font = font(11, 400);
  ctx.fillStyle = rgba(palette.muted, 1);
  ctx.fillText(model.hero.winrateLabel, PAD, y + 56);
  ctx.font = font(12, 400);
  ctx.fillStyle = rgba(palette.muted, 0.8);
  ctx.fillText(model.hero.battlesText, PAD, y + 76);
  // The live card renders the PR block with "—" while the rating is on but
  // unknown — the shot keeps the same shape.
  if (model.prOn) {
    const prText = model.hero.pr ?? "—";
    ctx.textAlign = "right";
    ctx.font = font(26, 700, true);
    if (model.hero.prRainbow) {
      ctx.fillStyle = rainbowFill(ctx, width - PAD, ctx.measureText(prText).width);
    } else {
      ctx.fillStyle = model.hero.prColor ?? rgba(palette.text, 1);
    }
    ctx.fillText(prText, width - PAD, y + 26);
    ctx.font = font(11, 400);
    ctx.fillStyle = rgba(palette.muted, 1);
    if (model.hero.prLabel) ctx.fillText(model.hero.prLabel, width - PAD, y + 52);
    ctx.textAlign = "left";
  }
  y += HERO_H;

  // KPI strip: one row of up to four label-over-value cards.
  if (kpiCount > 0) {
    const cellW = (width - PAD * 2 - KPI_GAP * (kpiCount - 1)) / kpiCount;
    model.kpis.forEach((k, i) => {
      const x = PAD + i * (cellW + KPI_GAP);
      ctx.fillStyle = rgba(palette.text, 0.05);
      ctx.beginPath();
      ctx.roundRect(x, y, cellW, KPI_CELL_H, 8);
      ctx.fill();
      ctx.font = font(10.5, 400);
      ctx.fillStyle = rgba(palette.muted, 1);
      ctx.fillText(k.label, x + 14, y + 18);
      ctx.font = font(15, 600, true);
      ctx.fillStyle = k.color ?? rgba(palette.text, 0.92);
      ctx.fillText(k.value, x + 14, y + 42);
    });
    y += KPI_CELL_H + 8;
  }

  // Roster: section title, right-aligned column labels at the measured
  // stat origins, then the row cards (name + role stacked, stat cells) in
  // two side-by-side columns — column-major, the top half of the ranking
  // reading down the left column and the rest down the right. One shared
  // origin set (measured across every member) keeps both halves' stat
  // cells on the same grid.
  if (hasMembers) {
    ctx.font = font(13, 600);
    ctx.fillStyle = rgba(palette.text, 0.55);
    ctx.fillText(model.membersTitle, PAD, y + MEMBER_TITLE_H / 2);
    y += MEMBER_TITLE_H;

    ctx.font = font(13.5, 600, true);
    const origins = statCellOrigins(
      ctx,
      model.members.map((m) => m.cells.map((c) => c.text)),
      STAT_GAP,
    );
    const statsW = (origins[origins.length - 1] ?? 0) + 24;
    // Widest first stat cell (the battles column) — a row's name must clear
    // it, not just the cell's right-aligned origin, or long ellipsized names
    // run into the digits.
    const firstCellW =
      origins.length > 1 ? origins[1] - origins[0] - STAT_GAP : 0;
    const colW = (width - PAD * 2 - COL_GAP) / 2;
    const columns = [model.members.slice(0, memberRows), model.members.slice(memberRows)];
    const colX = (ci: number) => PAD + ci * (colW + COL_GAP);

    ctx.font = font(10.5, 400);
    ctx.fillStyle = rgba(palette.muted, 0.8);
    ctx.textAlign = "right";
    for (let ci = 0; ci < 2; ci++) {
      const statLeft = colX(ci) + colW - statsW;
      model.membersHead.forEach((label, i) => {
        ctx.fillText(label, statLeft + (origins[i] ?? 0), y + MEMBER_HEAD_H / 2);
      });
    }
    ctx.textAlign = "left";
    y += MEMBER_HEAD_H;

    for (let r = 0; r < memberRows; r++) {
      const ry = y + r * (ROW_H + 6);
      for (let ci = 0; ci < 2; ci++) {
        const member = columns[ci][r];
        if (!member) continue;
        const statLeft = colX(ci) + colW - statsW;
        const cy = ry + ROW_H / 2;
        ctx.globalAlpha = member.dim ? 0.5 : 1;
        ctx.fillStyle = rgba(palette.text, 0.05);
        ctx.beginPath();
        ctx.roundRect(colX(ci), ry, colW, ROW_H, 8);
        ctx.fill();

        const textW = Math.max(
          statLeft - firstCellW - 8 - (colX(ci) + 12),
          60,
        );
        ctx.font = font(14.5, 600);
        ctx.fillStyle = rgba(palette.text, 1);
        ctx.fillText(ellipsize(ctx, member.name, textW), colX(ci) + 12, cy - 8);
        ctx.font = font(11, 400);
        ctx.fillStyle = rgba(palette.text, 0.5);
        ctx.fillText(ellipsize(ctx, member.role, textW), colX(ci) + 12, cy + 10);

        ctx.font = font(13.5, 600, true);
        ctx.textAlign = "right";
        member.cells.forEach((c, i) => {
          const x = statLeft + (origins[i] ?? 0);
          if (c.rainbow) {
            ctx.fillStyle = rainbowFill(ctx, x, ctx.measureText(c.text).width);
          } else {
            ctx.fillStyle = c.color ?? rgba(palette.text, 0.85);
          }
          ctx.fillText(c.text, x, cy);
        });
        ctx.textAlign = "left";
        ctx.globalAlpha = 1;
      }
    }
    y += memberRows * (ROW_H + 6);
    if (model.moreMembers) {
      ctx.font = font(11, 400);
      ctx.fillStyle = rgba(palette.muted, 0.9);
      ctx.fillText(model.moreMembers, PAD, y + 4);
      y += 20;
    }
  }

  drawFooter(ctx, palette, width, footer, logo);
  return canvasToPngBytes(canvas);
}
