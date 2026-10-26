/**
 * Share-shot renderer for the post-battle panels: paints the combined battle
 * sheet onto an offscreen canvas and returns PNG bytes, ready for the
 * clipboard copy (`api.copyImageToClipboard`) or a save-file fallback.
 *
 * One copied image carries BOTH halves the results window otherwise splits:
 * the personal banner (我的战绩 — identity, damage/frag headline, settlement
 * ribbons, one compressed secondary-stat line) rides above the two-column
 * roster matrix, so sharing the team water table no longer takes a second
 * copy from the self view. Hosts without a self model (the incomplete-results
 * fallback, payload edges) render the matrix alone.
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
import { bundledRibbonUrl } from "@/features/holographic/ribbonIcons";
import {
  FOOT_H,
  LOGO_URL,
  PAD,
  STAMP_URL,
  canvasToPngBytes,
  drawFooter,
  drawSealTag,
  drawStampSeal,
  ellipsize,
  font,
  footerMinWidth,
  loadImage,
  newShotCanvas,
  readPalette,
  rgba,
  sealTagWidth,
  statCellOrigins,
  type ShotFooterStrings,
  type ShotPalette,
} from "@/features/share/shotKit";
import { stampTier, type CareerStamp } from "@/utils/winrate";

/** The career verdicts' wording — drawn when a stamp presses as the
 *  horizontal tag face. The shot only ever carries the career verdicts,
 *  ALL of which are primary seals today (utils/winrate stampTier), so the
 *  tag branch below is the tier system's future-proofing, not a live
 *  path; the map stays total over StampKind's career half so a kind can
 *  never arrive unlabelled. */
const STAMP_LABEL: Record<CareerStamp, string> = {
  miracle: "神了",
  ape: "猴",
  maggot: "蛆",
  rat: "过街老鼠",
};

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
   *  the settings gates, so a disabled seal never arrives here. All four
   *  career kinds are PRIMARY seals (utils/winrate stampTier): the square
   *  stamp picture at the row end. A secondary kind (composition/merged,
   *  never produced by the current shot models) would press as the
   *  horizontal StampTag face instead. */
  stamp?: CareerStamp | null;
  stats: ShotStat[];
}

/** One label+value pair compressed onto the personal banner's muted line
 *  (潜在伤害 / 侦察伤害 / …). */
export interface ShotPair {
  label: string;
  value: string;
}

/** The personal banner riding above the roster matrix (我的战绩). It exists
 *  so the team water table and the personal report share ONE copied image:
 *  identity, the damage/frag headline, the settlement ribbon run (勋章) and
 *  the secondary stats compressed onto exactly one muted line. The nick
 *  arrives ALREADY masked by the caller — the same privacy contract as
 *  ShotRow: a hidden nickname cannot leak into the image. */
export interface ShotSelf {
  /** Section caption (我的战绩). */
  title: string;
  nick: string;
  clanTag?: string | null;
  /** Ship display name; null drops the suffix. */
  shipName?: string | null;
  /** Ship-class HUD icon (bundled PNG url) + its variant. */
  shipType?: string | null;
  iconVariant?: ShipIconVariant;
  /** Sunk: the identity carries the caller's localized marker. */
  sunk?: boolean;
  sunkLabel?: string | null;
  /** Big damage figure (pre-formatted; damageColor supplies its tier). */
  damage: string;
  damageColor?: string;
  /** Caption over the damage figure (伤害). */
  damageLabel: string;
  /** Frags pair beside the headline (击沉 N). */
  frags?: ShotPair;
  /** Settlement ribbons (key → bundled icon) with their counts. */
  ribbons: { key: string; value: number }[];
  /** Secondary stats, painted as ONE muted line. */
  aux: ShotPair[];
}

/** One column-title header entry — the team mean of a configured column
 *  (weighted/plain WR, mean PR, mean battles, avg damage, K/D), or a
 *  label-only caption (the XP column): `col` is the stat column index whose
 *  x-origin the value right-aligns onto, so the header lands exactly on its
 *  column below. */
export interface ShotAgg {
  col: number;
  label: string;
  /** Formatted value drawn under the label. Omitted for a label-only header
   *  entry — the XP column carries a caption but no team aggregate (a
   *  single-battle figure has no mean). */
  value?: string;
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
  /** Personal banner above the matrix (我的战绩). Absent on hosts with no
   *  self model — the fallback matrix and legacy payload edges. */
  self?: ShotSelf | null;
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

/** Personal banner geometry, in logical units: the air under the head rule,
 *  the card's inner padding, the identity/headline row, and the optional
 *  ribbon + secondary-stat rows. selfBannerHeight() reserves exactly these
 *  before the canvas exists, so the matrices below can never overlap the
 *  banner. */
const SELF_TOP_GAP = 12;
const SELF_BOTTOM_GAP = 12;
const SELF_INNER_PAD = 8;
const SELF_IDENTITY_ROW_H = 40;
const SELF_RIBBON_ROW_H = 22;
const SELF_AUX_ROW_H = 20;
/** Ribbon icon box in the banner — the DOM 我的战绩 report's own run size. */
const RIBBON_W = 40;
const RIBBON_H = 15;
const RIBBON_COUNT_GAP = 6;
const RIBBON_ITEM_GAP = 16;

/** The banner card's height for the parts this model actually carries: the
 *  single source both the renderer's height reservation and the painter
 *  read, so the two can never disagree. */
function selfBannerHeight(self: ShotSelf): number {
  return (
    SELF_INNER_PAD * 2 +
    SELF_IDENTITY_ROW_H +
    (self.ribbons.length > 0 ? SELF_RIBBON_ROW_H : 0) +
    (self.aux.length > 0 ? SELF_AUX_ROW_H : 0)
  );
}

/** Paint the banner card. `top` is the card's own top edge (the head rule
 *  sits just above it, the roster columns start below SELF_BOTTOM_GAP). The
 *  masked nick / pre-formatted figures arrive from the caller's model; the
 *  renderer only lays them out. */
function drawSelfBanner(
  ctx: CanvasRenderingContext2D,
  palette: ShotPalette,
  width: number,
  self: ShotSelf,
  top: number,
  icon: HTMLImageElement | null,
  ribbonIcons: (HTMLImageElement | null)[],
): void {
  const cardH = selfBannerHeight(self);
  const x = PAD;
  const w = width - PAD * 2;
  ctx.fillStyle = rgba(palette.text, 0.05);
  ctx.beginPath();
  ctx.roundRect(x, top, w, cardH, 10);
  ctx.fill();

  const left = x + 14;
  const right = x + w - 14;
  let y = top + SELF_INNER_PAD;

  // Caption row: the section title left, the damage caption right — the
  // panel's label-over-value header treatment, kept tiny.
  ctx.textAlign = "left";
  ctx.font = font(10.5, 500);
  ctx.fillStyle = rgba(palette.text, 0.5);
  ctx.fillText(self.title, left, y + 6);
  ctx.textAlign = "right";
  ctx.fillText(self.damageLabel, right, y + 6);

  // Headline row: the damage figure anchors the right edge; its width (with
  // the frags pair and their gaps) bounds the identity line on the left, so
  // a long nick ellipsizes instead of painting over the number.
  const cy = y + 24;
  ctx.font = font(22, 700, true);
  const dmgW = ctx.measureText(self.damage).width;
  ctx.fillStyle = self.damageColor ?? rgba(palette.text, 0.9);
  ctx.fillText(self.damage, right, cy + 2);
  let headLeft = right - dmgW;
  if (self.frags) {
    ctx.font = font(11.5, 600);
    const frags = `${self.frags.label} ${self.frags.value}`;
    const fragsW = ctx.measureText(frags).width;
    ctx.fillStyle = rgba(palette.text, 0.62);
    ctx.fillText(frags, headLeft - 18, cy + 3);
    headLeft -= fragsW + 18;
  }
  headLeft -= 14;

  // Identity line: class icon + masked nick (+ clan) + sunk marker + ship.
  ctx.textAlign = "left";
  let tx = left;
  if (icon) {
    ctx.drawImage(icon, tx, cy - 9, 18, 18);
    tx += 26;
  }
  const identityW = Math.max(headLeft - tx, 80);
  let nick = self.nick;
  if (self.clanTag) nick += `  [${self.clanTag}]`;
  ctx.font = font(15.5, 700);
  ctx.fillStyle = rgba(palette.text, 0.95);
  nick = ellipsize(ctx, nick, identityW);
  ctx.fillText(nick, tx, cy);
  tx += ctx.measureText(nick).width + 10;
  if (self.sunk && self.sunkLabel && tx < headLeft) {
    ctx.font = font(10.5, 600);
    ctx.fillStyle = rgba(palette.text, 0.5);
    const label = ellipsize(ctx, self.sunkLabel, headLeft - tx);
    ctx.fillText(label, tx, cy);
    tx += ctx.measureText(label).width + 10;
  }
  if (self.shipName && tx < headLeft) {
    const room = headLeft - tx;
    if (room >= 48) {
      ctx.font = font(12.5, 400);
      ctx.fillStyle = rgba(palette.text, 0.6);
      ctx.fillText(ellipsize(ctx, `· ${self.shipName}`, room), tx, cy + 1);
    }
  }

  // Ribbon run: the settlement 勋章 icons + counts (the DOM report's own
  // order). Unmatched keys drop out exactly like the DOM run's missing art.
  y += SELF_IDENTITY_ROW_H;
  if (self.ribbons.length > 0) {
    const rowCenter = y + SELF_RIBBON_ROW_H / 2;
    let rx = left;
    for (let i = 0; i < self.ribbons.length; i++) {
      const img = ribbonIcons[i];
      const rib = self.ribbons[i];
      if (!img) continue;
      ctx.font = font(11, 600, true);
      const count = String(rib.value);
      const countW = ctx.measureText(count).width;
      const itemW = RIBBON_W + RIBBON_COUNT_GAP + countW;
      // A narrow card (single-team shots) can run out of room before the
      // settlement's ribbon kinds do — say so instead of silently dropping
      // the tail: the muted ellipsis marks the cut (the DOM report wraps;
      // the banner has no second row to spare).
      if (rx + itemW > right) {
        ctx.font = font(12, 600);
        ctx.fillStyle = rgba(palette.text, 0.45);
        ctx.fillText("…", Math.min(rx, right - 8), rowCenter + 1);
        break;
      }
      ctx.drawImage(img, rx, rowCenter - RIBBON_H / 2, RIBBON_W, RIBBON_H);
      ctx.textAlign = "left";
      ctx.fillStyle = rgba(palette.text, 0.72);
      ctx.fillText(count, rx + RIBBON_W + RIBBON_COUNT_GAP, rowCenter + 1);
      rx += itemW + RIBBON_ITEM_GAP;
    }
    y += SELF_RIBBON_ROW_H;
  }

  // Secondary stats, compressed onto exactly one muted line.
  if (self.aux.length > 0) {
    const line = self.aux.map((p) => `${p.label} ${p.value}`).join("  ·  ");
    ctx.textAlign = "left";
    ctx.font = font(11.5, 400);
    ctx.fillStyle = rgba(palette.text, 0.62);
    ctx.fillText(ellipsize(ctx, line, w - 28), left, y + SELF_AUX_ROW_H / 2 + 1);
  }
  ctx.textAlign = "left";
}

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
  const self = model.self ?? null;
  const selfH = self ? selfBannerHeight(self) : 0;
  const selfBlockH = self ? SELF_TOP_GAP + selfH + SELF_BOTTOM_GAP : 0;
  // A single-team column lands below the footer's no-overlap minimum —
  // floor the content width on it so the watermark lines never collide.
  // Sized for the logo present: it loads for the footer in the normal path.
  const width = Math.max(
    PAD * 2 + cols.length * COL_WIDTH + (cols.length - 1) * COL_GAP,
    footerMinWidth(opts, true),
  );
  const maxRows = Math.max(...cols.map((c) => c.rows.length), 0);
  const height =
    HEAD_H + selfBlockH + COL_TITLE_H + maxRows * (ROW_H + 6) + 10 + FOOT_H;

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
  // The slot fits the WIDEST face on any row — a secondary-tier stamp
  // (a horizontal tag, e.g. the 空中小人 family) is wider than the square
  // 34px stamp, so its measured tag width takes the slot when present
  // (no secondary kind is reachable through the current career-only shot
  // models — the branch keeps the renderer tier-honest anyway).
  const hasStamps = cols.some((c) => c.rows.some((r) => r.stamp));
  let tagSlot = 0;
  for (const c of cols) {
    for (const r of c.rows) {
      if (r.stamp && stampTier(r.stamp) === "secondary") {
        tagSlot = Math.max(tagSlot, sealTagWidth(ctx, STAMP_LABEL[r.stamp]));
      }
    }
  }
  const statsW =
    (origins[origins.length - 1] ?? 0) + 24 + (hasStamps ? Math.max(STAMP_SLOT, tagSlot + 8) : 0);

  // Column titles (+ aggregate) and rows. The footer's logo loads alongside
  // the class icons so the paint never waits twice on the network.
  const icons = await Promise.all([
    ...cols.flatMap((c) =>
      c.rows.map((r) => loadImage(shipIconUrl(r.shipType, r.iconVariant ?? "plain"))),
    ),
    loadImage(LOGO_URL),
  ]);
  const logo = icons.pop() ?? null;
  // The banner's own art (its class icon + the settlement ribbon run) joins
  // the same cached wave; both settle instantly when the host had no banner.
  const bannerIcon = self
    ? await loadImage(shipIconUrl(self.shipType, self.iconVariant ?? "white"))
    : null;
  const ribbonIcons = self
    ? await Promise.all(self.ribbons.map((r) => loadImage(bundledRibbonUrl(r.key))))
    : [];
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
  if (self) {
    drawSelfBanner(ctx, palette, width, self, HEAD_H + SELF_TOP_GAP, bannerIcon, ribbonIcons);
  }
  // The matrix starts below the banner (or under the head rule on hosts
  // without one) — the reserved selfBlockH is exactly the banner's budget.
  const columnsTop = HEAD_H + selfBlockH;
  let iconIdx = 0;
  for (let ci = 0; ci < cols.length; ci++) {
    const col = cols[ci];
    const cx = PAD + ci * (COL_WIDTH + COL_GAP);
    let y = columnsTop;

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
        // Label-only entries (the XP column's 经验 caption) stop here: a
        // single-battle figure has no team aggregate to print under it.
        if (part.value != null) {
          ctx.font = font(12.5, 600, true);
          ctx.fillStyle = part.valueColor ?? rgba(palette.text, 0.85);
          ctx.fillText(part.value, vx, ty + 7);
        }
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
      // The career seal, pressed onto the row-end slot reserved above, in
      // the seal-tier faces: a primary kind (the four career verdicts) as
      // RatingStamp's square face redrawn in canvas (mini variant, see
      // drawStampSeal); a secondary kind as the horizontal StampTag face
      // (drawSealTag) — the exact faces the DOM row beside the copy button
      // renders.
      if (row.stamp) {
        if (stampTier(row.stamp) === "secondary") {
          drawSealTag(
            ctx,
            cx + COL_WIDTH - 14 - Math.max(STAMP_SLOT, tagSlot + 8) / 2,
            cy,
            STAMP_LABEL[row.stamp],
          );
        } else {
          drawStampSeal(
            ctx,
            cx + COL_WIDTH - 14 - STAMP_SIZE / 2,
            cy,
            STAMP_SIZE,
            stampImages.get(row.stamp) ?? null,
            "mini",
          );
        }
      }
      ctx.globalAlpha = 1;
      y += ROW_H + 6;
    }
  }

  drawFooter(ctx, palette, width, opts, logo);
  return canvasToPngBytes(canvas);
}
