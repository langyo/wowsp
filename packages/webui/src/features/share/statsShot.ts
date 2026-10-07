/**
 * Share-shot renderer for the personal water-table cards (the dashboard's
 * "我的水表" and the lookup player result): paints the stats card's content —
 * identity, hero winrate/PR with the career seals, division splits, KPI
 * grid, per-type chips and the top of the currently filtered ship table —
 * onto an offscreen canvas via the shared shot kit, and returns PNG bytes
 * for the clipboard copy flow (useShareImage).
 *
 * Same contract as the post-battle shot: a plain-data model with colors and
 * anomaly flags already resolved by the caller, theme palette read live from
 * the host element, and the fixed WoWSP watermark footer. The ship list is
 * the caller's CURRENT view (date range + filter chips applied), capped and
 * trailed by a "more ships" note, so the image shows exactly what the user
 * sees — never hidden parameters or data the view does not show.
 */
import { shipIconUrl } from "@/features/holographic/shipIcons";
import type { CareerStamp, CompositionStamps, StampKind } from "@/utils/winrate";
import {
  FOOT_H,
  LOGO_URL,
  PAD,
  STAMP_URL,
  canvasToPngBytes,
  drawFooter,
  drawStampSeal,
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

/** One KPI cell of the grid: label + pre-formatted value (+ tier color). */
export interface StatsShotKpi {
  label: string;
  value: string;
  color?: string;
}

/** One division-split cell (solo / div2 / div3 / ranked). */
export interface StatsShotDivision {
  label: string;
  /** Pre-formatted ("52.3%" / "—"), already tier-colored by the caller. */
  value: string;
  color?: string;
}

/** One per-ship-type chip (BB / CA / DD / CV / SS). */
export interface StatsShotTypeChip {
  code: string;
  battles: string;
  value: string;
  color?: string;
}

/** One row of the top-ships table: ship name + class icon + right-aligned
 *  stat cells (battles / winrate / avg damage / K-D). */
export interface StatsShotShip {
  name: string;
  /** Canonical ship type, for the bundled HUD class icon. */
  shipType?: string | null;
  cells: { text: string; color?: string }[];
}

export interface StatsShotModel {
  /** Page title (我的水表 / 水表查询). */
  title: string;
  /** Right-aligned provenance under the title: the active date range (+
   *  covers-since date when a delta baseline exists). */
  rangeLabel?: string | null;
  realm?: string | null;
  name: string;
  clanTag?: string | null;
  hidden?: boolean;
  hiddenLabel?: string;
  /** Career seal + composition seals, the caller's settings gates already
   *  applied — a disabled seal never arrives here (post-battle contract). */
  stamp?: CareerStamp | null;
  airSub?: CompositionStamps | null;
  /** PR master switch — off hides the PR block (and, by the gates above,
   *  every seal) exactly like the live card. */
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
  divisions: StatsShotDivision[];
  kpis: StatsShotKpi[];
  typeChips: StatsShotTypeChip[];
  /** Section header + column labels for the ship table. */
  shipsTitle: string;
  shipsHead: string[];
  ships: StatsShotShip[];
  /** Trailing "+N more ships" note when the table was capped. */
  moreShips?: string | null;
}

/** Canvas logical width — one content column, a touch wider than a
 * post-battle roster column so the hero band breathes. */
const BASE_WIDTH = 660;

/** The shot's render width for this session's locale: the base single-
 * column width, or more when the localized watermark copy would otherwise
 * overlap in the footer (see footerMinWidth). */
const shotWidth = (): number =>
  Math.max(BASE_WIDTH, footerMinWidth(shareFooterStrings(), true));
const HEAD_H = 66;
const IDENTITY_H = 48;
const HERO_H = 92;
const DIV_H = 58;
const KPI_CELL_H = 60;
const KPI_GAP = 8;
const TYPE_H = 44;
const SHIP_TITLE_H = 30;
const SHIP_HEAD_H = 22;
const ROW_H = 44;
/** Visual air between adjacent stat cells of a ship row (same value the
 *  post-battle matrix uses — below it, mono neighbors merge visually). */
const STAT_GAP = 36;
const SEAL_SIZE = 54;
const SEAL_SMALL = 42;
/** Horizontal gap between adjacent per-type chips. */
const CHIP_GAP = 8;

/** One per-type chip's outer width (its rounded card), measured under the
 *  fonts the chip draws with — the wrap pass and the draw pass share it. */
function typeChipWidth(ctx: CanvasRenderingContext2D, chip: StatsShotTypeChip): number {
  ctx.font = font(11.5, 700);
  const codeW = ctx.measureText(chip.code).width;
  ctx.font = font(11, 400);
  const battlesW = ctx.measureText(chip.battles).width;
  ctx.font = font(11.5, 600);
  const valW = ctx.measureText(chip.value).width;
  return 14 + codeW + 10 + battlesW + 10 + valW + 14;
}

/** Greedy row-wrap of the per-type chips: a five-class card (BB/CV/CA/DD/SS)
 *  does not fit one content row, and silently dropping a class would misrepre-
 *  sent the career — the chips flow onto a second row instead. Measured on a
 *  scratch context so the canvas height can budget every wrapped row. */
function wrapTypeChips(
  model: StatsShotModel,
  width: number,
): StatsShotTypeChip[][] {
  if (model.typeChips.length === 0) return [];
  const scratch = document.createElement("canvas").getContext("2d");
  if (!scratch) return [model.typeChips];
  const rows: StatsShotTypeChip[][] = [];
  let row: StatsShotTypeChip[] = [];
  let x = 0;
  for (const chip of model.typeChips) {
    const w = typeChipWidth(scratch, chip);
    if (row.length > 0 && x + w > width - PAD * 2) {
      rows.push(row);
      row = [];
      x = 0;
    }
    row.push(chip);
    x += w + CHIP_GAP;
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

export async function renderStatsShot(
  model: StatsShotModel,
  opts: { el?: HTMLElement | null },
): Promise<Uint8Array> {
  const palette = readPalette(opts.el);
  const width = shotWidth();
  const hasDiv = model.divisions.length > 0;
  const kpiRows = Math.ceil(model.kpis.length / 3);
  const chipRows = wrapTypeChips(model, width);
  const shipCount = model.ships.length;
  const hasShips = shipCount > 0;

  let height = HEAD_H + IDENTITY_H + HERO_H;
  if (hasDiv) height += DIV_H;
  if (kpiRows > 0) height += kpiRows * KPI_CELL_H + (kpiRows - 1) * KPI_GAP + 8;
  if (chipRows.length > 0) height += chipRows.length * TYPE_H + 10;
  if (hasShips) {
    height += 8 + SHIP_TITLE_H + SHIP_HEAD_H + shipCount * (ROW_H + 6);
    if (model.moreShips) height += 20;
  }
  height += FOOT_H;

  const { canvas, ctx } = newShotCanvas(width, height, palette);

  // Header: title, range + realm stacked (right), hairline.
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = font(21, 700);
  ctx.fillStyle = rgba(palette.text, 1);
  ctx.fillText(model.title, PAD, HEAD_H / 2 + 2);
  ctx.textAlign = "right";
  const rx = width - PAD;
  if (model.rangeLabel && model.realm) {
    ctx.font = font(14, 400);
    ctx.fillStyle = rgba(palette.muted, 1);
    ctx.fillText(model.rangeLabel, rx, HEAD_H / 2 - 8);
    ctx.font = font(11, 400);
    ctx.fillStyle = rgba(palette.muted, 0.72);
    ctx.fillText(model.realm.toUpperCase(), rx, HEAD_H / 2 + 12);
  } else {
    const single = model.rangeLabel ?? (model.realm ? model.realm.toUpperCase() : null);
    ctx.font = font(14, 400);
    ctx.fillStyle = rgba(palette.muted, 1);
    ctx.fillText(single ?? "", rx, HEAD_H / 2 + 2);
  }
  ctx.textAlign = "left";
  ctx.fillStyle = rgba(palette.text, 0.1);
  ctx.fillRect(PAD, HEAD_H - 6, width - PAD * 2, 1);

  // Identity row: [TAG] + nickname, hidden pill right.
  const iy = HEAD_H + IDENTITY_H / 2;
  // Measure the hidden pill first so the nick's ellipsis budget accounts
  // for the actual localized label (ru-RU's is the widest).
  let pillW = 0;
  if (model.hidden && model.hiddenLabel) {
    ctx.font = font(11.5, 600);
    pillW = ctx.measureText(model.hiddenLabel).width + 16;
  }
  ctx.font = font(14, 700);
  const tagText = model.clanTag ? `[${model.clanTag}]` : "";
  const tagW = tagText ? ctx.measureText(tagText).width + 10 : 0;
  ctx.fillStyle = rgba(palette.primary, 1);
  ctx.fillText(tagText, PAD, iy);
  ctx.font = font(17, 700);
  ctx.fillStyle = rgba(palette.text, 1);
  const nickW = width - PAD * 2 - tagW - (pillW ? pillW + 12 : 0);
  ctx.fillText(ellipsize(ctx, model.name, Math.max(nickW, 60)), PAD + tagW, iy);
  if (pillW > 0 && model.hiddenLabel) {
    ctx.font = font(11.5, 600);
    ctx.fillStyle = "rgba(220,80,80,0.16)";
    ctx.beginPath();
    ctx.roundRect(width - PAD - pillW, iy - 12, pillW, 24, 12);
    ctx.fill();
    ctx.fillStyle = "rgba(220,80,80,0.95)";
    ctx.textAlign = "right";
    ctx.fillText(model.hiddenLabel, width - PAD - 8, iy);
    ctx.textAlign = "left";
  }

  // Hero band: winrate + battles left, PR block right, seals between.
  const heroY = HEAD_H + IDENTITY_H;
  ctx.font = font(32, 700);
  ctx.fillStyle = model.hero.winrateColor ?? rgba(palette.text, 1);
  ctx.fillText(model.hero.winrate, PAD, heroY + 28);
  ctx.font = font(11, 400);
  ctx.fillStyle = rgba(palette.muted, 1);
  ctx.fillText(model.hero.winrateLabel, PAD, heroY + 56);
  ctx.font = font(12, 400);
  ctx.fillStyle = rgba(palette.muted, 0.8);
  ctx.fillText(model.hero.battlesText, PAD, heroY + 76);

  ctx.textAlign = "right";
  let heroRight = width - PAD;
  // The live card renders the PR block with "—" while the rating is on but
  // unknown (hidden profiles) — the shot keeps the same shape.
  if (model.prOn) {
    const prText = model.hero.pr ?? "—";
    ctx.font = font(26, 700, true);
    if (model.hero.prRainbow) {
      ctx.fillStyle = rainbowFill(ctx, heroRight, ctx.measureText(prText).width);
    } else {
      ctx.fillStyle = model.hero.prColor ?? rgba(palette.text, 1);
    }
    ctx.fillText(prText, heroRight, heroY + 26);
    ctx.font = font(11, 400);
    ctx.fillStyle = rgba(palette.muted, 1);
    if (model.hero.prLabel) ctx.fillText(model.hero.prLabel, heroRight, heroY + 52);
    ctx.font = font(26, 700, true);
    heroRight -= ctx.measureText(prText).width + 26;
  }
  ctx.textAlign = "left";

  // Seals ride the hero's free middle: career first, then air/sub, ending
  // `heroRight`-aligned so the cluster keeps clear of the PR block.
  const sealKinds = [
    model.stamp ? { kind: model.stamp, size: SEAL_SIZE } : null,
    model.airSub?.air ? { kind: "air" as const, size: SEAL_SMALL } : null,
    model.airSub?.sub ? { kind: "sub" as const, size: SEAL_SMALL } : null,
  ].filter((s): s is { kind: StampKind; size: number } => !!s);
  const sealImages = new Map<string, HTMLImageElement | null>();
  if (sealKinds.length > 0) {
    await Promise.all(
      sealKinds.map(async ({ kind }) => {
        if (!sealImages.has(kind)) sealImages.set(kind, await loadImage(STAMP_URL[kind]));
      }),
    );
    // Right-align the cluster by measuring its total extent first.
    let sx = heroRight;
    for (let i = sealKinds.length - 1; i >= 0; i--) {
      const { kind, size } = sealKinds[i];
      sx -= size;
      drawStampSeal(ctx, sx + size / 2, heroY + HERO_H / 2, size, sealImages.get(kind) ?? null);
      sx -= 8;
    }
  }

  // Division splits: one even row of cells over the content width.
  let y = heroY + HERO_H;
  if (hasDiv) {
    const n = model.divisions.length;
    const cellW = (width - PAD * 2) / n;
    for (let i = 0; i < n; i++) {
      const d = model.divisions[i];
      const cx = PAD + cellW * i + cellW / 2;
      if (i > 0) {
        ctx.fillStyle = rgba(palette.text, 0.08);
        ctx.fillRect(PAD + cellW * i, y + 10, 1, DIV_H - 20);
      }
      ctx.textAlign = "center";
      ctx.font = font(16, 600);
      ctx.fillStyle = d.color ?? rgba(palette.text, 0.9);
      ctx.fillText(d.value, cx, y + 21);
      ctx.font = font(10.5, 400);
      ctx.fillStyle = rgba(palette.muted, 1);
      ctx.fillText(d.label, cx, y + 42);
    }
    ctx.textAlign = "left";
    y += DIV_H;
  }

  // KPI grid: three columns of label-over-value cards.
  if (kpiRows > 0) {
    y += 8;
    const cellW = (width - PAD * 2 - KPI_GAP * 2) / 3;
    model.kpis.forEach((k, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = PAD + col * (cellW + KPI_GAP);
      const cy = y + row * (KPI_CELL_H + KPI_GAP);
      ctx.fillStyle = rgba(palette.text, 0.05);
      ctx.beginPath();
      ctx.roundRect(x, cy, cellW, KPI_CELL_H, 8);
      ctx.fill();
      ctx.font = font(10.5, 400);
      ctx.fillStyle = rgba(palette.muted, 1);
      ctx.fillText(k.label, x + 14, cy + 18);
      ctx.font = font(15, 600, true);
      ctx.fillStyle = k.color ?? rgba(palette.text, 0.92);
      ctx.fillText(k.value, x + 14, cy + 42);
    });
    y += kpiRows * KPI_CELL_H + (kpiRows - 1) * KPI_GAP;
  }

  // Per-type chips: greedily wrapped rows (see wrapTypeChips), each row
  // measured under its own fonts so every class always makes the image.
  if (chipRows.length > 0) {
    y += 10;
    for (const row of chipRows) {
      const cy = y + TYPE_H / 2;
      let x = PAD;
      for (const chip of row) {
        ctx.font = font(11.5, 700);
        const codeW = ctx.measureText(chip.code).width;
        ctx.font = font(11, 400);
        const battlesW = ctx.measureText(chip.battles).width;
        const w = typeChipWidth(ctx, chip);
        ctx.fillStyle = rgba(palette.text, 0.05);
        ctx.beginPath();
        ctx.roundRect(x, y + 6, w, TYPE_H - 12, 8);
        ctx.fill();
        let tx = x + 14;
        ctx.font = font(11.5, 700);
        ctx.fillStyle = rgba(palette.text, 0.85);
        ctx.fillText(chip.code, tx, cy);
        tx += codeW + 10;
        ctx.font = font(11, 400);
        ctx.fillStyle = rgba(palette.muted, 1);
        ctx.fillText(chip.battles, tx, cy);
        tx += battlesW + 10;
        ctx.font = font(11.5, 600);
        ctx.fillStyle = chip.color ?? rgba(palette.text, 0.9);
        ctx.fillText(chip.value, tx, cy);
        x += w + CHIP_GAP;
      }
      y += TYPE_H;
    }
  }

  // Top ships: section title, right-aligned column labels at the measured
  // stat origins, then the row cards (icon + name + colored stat cells).
  if (hasShips) {
    y += 8;
    ctx.font = font(13, 600);
    ctx.fillStyle = rgba(palette.text, 0.55);
    ctx.fillText(model.shipsTitle, PAD, y + SHIP_TITLE_H / 2);
    y += SHIP_TITLE_H;

    ctx.font = font(13.5, 600, true);
    const origins = statCellOrigins(
      ctx,
      model.ships.map((s) => s.cells.map((c) => c.text)),
      STAT_GAP,
    );
    const statsW = (origins[origins.length - 1] ?? 0) + 24;
    const statLeft = width - PAD - statsW;

    ctx.font = font(10.5, 400);
    ctx.fillStyle = rgba(palette.muted, 0.8);
    ctx.textAlign = "right";
    model.shipsHead.forEach((label, i) => {
      ctx.fillText(label, statLeft + (origins[i] ?? 0), y + SHIP_HEAD_H / 2);
    });
    ctx.textAlign = "left";
    y += SHIP_HEAD_H;

    const icons = await Promise.all(
      model.ships.map((s) => loadImage(shipIconUrl(s.shipType ?? null, "plain"))),
    );
    model.ships.forEach((ship, i) => {
      const cy = y + ROW_H / 2;
      ctx.fillStyle = rgba(palette.text, 0.05);
      ctx.beginPath();
      ctx.roundRect(PAD, y, width - PAD * 2, ROW_H, 8);
      ctx.fill();

      let tx = PAD + 12;
      const icon = icons[i];
      if (icon) ctx.drawImage(icon, tx, cy - 10, 20, 20);
      tx += 28;
      ctx.font = font(14, 600);
      ctx.fillStyle = rgba(palette.text, 1);
      const textW = Math.max(statLeft - 8 - tx, 60);
      ctx.fillText(ellipsize(ctx, ship.name, textW), tx, cy);

      ctx.font = font(13.5, 600, true);
      ctx.textAlign = "right";
      ship.cells.forEach((c, ci) => {
        ctx.fillStyle = c.color ?? rgba(palette.text, 0.85);
        ctx.fillText(c.text, statLeft + (origins[ci] ?? 0), cy);
      });
      ctx.textAlign = "left";
      y += ROW_H + 6;
    });
    if (model.moreShips) {
      ctx.font = font(11, 400);
      ctx.fillStyle = rgba(palette.muted, 0.9);
      ctx.fillText(model.moreShips, PAD, y + 4);
      y += 20;
    }
  }

  const logo = await loadImage(LOGO_URL);
  drawFooter(ctx, palette, width, shareFooterStrings(), logo);
  return canvasToPngBytes(canvas);
}
