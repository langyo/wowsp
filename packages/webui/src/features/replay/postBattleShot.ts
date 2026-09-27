/**
 * Share-shot renderer for the post-battle panels: paints the two-column
 * result matrix onto an offscreen canvas and returns PNG bytes, ready for the
 * clipboard copy (`api.copyImageToClipboard`) or a save-file fallback.
 *
 * The image is a hand-drawn canvas composite (same approach as the tactical
 * board's exporters) rather than a DOM rasterization on purpose: the share
 * shot must be deterministic (no hover states, no scrollbars, no ship
 * parameters ever), must apply the nickname masking the user chose, and must
 * carry the fixed WoWSP watermark footer — a camera-watermark-style promo
 * strip — regardless of the window state the panel happens to be in.
 *
 * Theme colors are read live from the app's CSS custom properties (so the
 * shot follows the light/dark mode) with hard dark-theme fallbacks; ship
 * class icons are the same bundled HUD-marker PNGs the minimap canvas draws
 * (same-origin vite assets, so the canvas never taints).
 */
import { shipIconUrl, type ShipIconVariant } from "@/features/holographic/shipIcons";

/** One right-aligned stat cell of a row (WR / PR / avg damage / base XP). */
export interface ShotStat {
  text: string;
  /** Tier color for the value (winrateColor / prTier / damageColor output). */
  color?: string;
}

/** One player row. `nick` arrives ALREADY masked by the caller — the
 * renderer never sees a hidden nickname, so one cannot leak into the image. */
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
  stats: ShotStat[];
}

/** One label+value pair of the column-title aggregate (team mean WR / mean
 * PR): `col` is the stat column index whose x-origin the value right-aligns
 * onto, so the header numbers line up with the cells below them. */
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
  /** Short bot marker label appended after masked/plain nicks (t("replay.bot")). */
  botLabel?: string;
  columns: ShotColumn[];
}

/** App palette snapshot: CSS var triplets ("R G B") resolved at render time. */
interface Palette {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
}

const DEFAULT_PALETTE: Palette = {
  bg: "12 17 27",
  surface: "22 30 46",
  text: "233 238 246",
  muted: "150 160 175",
  border: "255 255 255",
};

const FONT_STACK =
  'ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
const MONO_STACK =
  'ui-monospace, "Cascadia Mono", Consolas, "Segoe UI", monospace, sans-serif';

/** Canvas logical width of one roster column (the image renders 2× for
 * crispness, so these are pre-scale units). */
const COL_WIDTH = 620;
const COL_GAP = 16;
const PAD = 28;
const ROW_H = 44;
const HEAD_H = 66;
const COL_TITLE_H = 34;
/** Footer band: tall enough for the logo block and the two centered
 * disclaimer lines to breathe. */
const FOOT_H = 88;
const GITHUB_URL = "github.com/langyo/wowsp";
/** The bundled pig-mascot brand mark (public/ asset — same-origin, so the
 * canvas never taints; same pattern as the HUD marker PNGs). */
const LOGO_URL = "/logo.webp";

/** Localized strings the fixed promo footer carries (all resolved by the
 * caller; the QQ number itself comes from about.qqGroupNumber). */
export interface ShotFooterStrings {
  tagline: string;
  disclaimer1: string;
  disclaimer2: string;
  qqGroup: string;
}

function readPalette(el?: HTMLElement | null): Palette {
  if (!el) return DEFAULT_PALETTE;
  const style = getComputedStyle(el);
  const pick = (name: string, fallback: string): string => {
    const v = style.getPropertyValue(name).trim();
    // CSS vars here are "R G B" triplets (rgb(var(--x) / a) usage in the app).
    return /^\d{1,3} \d{1,3} \d{1,3}$/.test(v) ? v : fallback;
  };
  return {
    bg: pick("--color-background", DEFAULT_PALETTE.bg),
    surface: pick("--color-surface", DEFAULT_PALETTE.surface),
    text: pick("--color-text", DEFAULT_PALETTE.text),
    muted: pick("--color-muted", DEFAULT_PALETTE.muted),
    border: pick("--color-text", DEFAULT_PALETTE.border),
  };
}

const rgba = (triplet: string, alpha: number): string =>
  `rgba(${triplet.split(" ").join(",")},${alpha})`;

/** Image cache for the bundled HUD marker PNGs (a full matrix reuses the
 * same handful of class icons dozens of times). */
const imageCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(url: string | null): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  let entry = imageCache.get(url);
  if (!entry) {
    entry = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    imageCache.set(url, entry);
  }
  return entry;
}

function font(size: number, weight = 400, mono = false): string {
  return `${weight} ${size}px ${mono ? MONO_STACK : FONT_STACK}`;
}

/** Measure the widest right-aligned stat cell per column index so every row's
 * cells share one x-origin — the aligned-table look of the live panel. */
function statOrigins(
  ctx: CanvasRenderingContext2D,
  columns: ShotColumn[],
): number[] {
  const origins: number[] = [];
  let x = 0;
  const count = Math.max(...columns.map((c) => c.rows[0]?.stats.length ?? 0), 0);
  for (let i = 0; i < count; i++) {
    let w = 0;
    for (const col of columns) {
      for (const row of col.rows) {
        const s = row.stats[i];
        if (s) w = Math.max(w, ctx.measureText(s.text).width);
      }
    }
    origins.push(x);
    x += w + 26;
  }
  return origins;
}

/** Draw the camera-watermark promo footer: pig logo + brand + localized
 * tagline left, the two fixed disclaimers centered (data is reference-only;
 * the software is free — never pay for it), QQ group + project URL right —
 * the fixed WoWSP signature on every share shot. */
function drawFooter(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  width: number,
  footer: ShotFooterStrings,
  logo: HTMLImageElement | null,
): void {
  const y = ctx.canvas.height / SCALE - FOOT_H;
  ctx.fillStyle = rgba(palette.surface, 0.75);
  ctx.fillRect(0, y, width, FOOT_H);
  ctx.fillStyle = rgba(palette.text, 0.12);
  ctx.fillRect(0, y, width, 1);

  ctx.textBaseline = "middle";
  const cy = y + FOOT_H / 2;

  // Left: the mascot logo in a rounded frame, brand + tagline beside it.
  let lx = PAD;
  if (logo) {
    const size = 46;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(lx, cy - size / 2, size, size, 10);
    ctx.clip();
    ctx.drawImage(logo, lx, cy - size / 2, size, size);
    ctx.restore();
    lx += size + 12;
  }
  ctx.textAlign = "left";
  ctx.font = font(19, 700);
  ctx.fillStyle = rgba(palette.text, 1);
  ctx.fillText("WoWSP", lx, cy - 11);
  ctx.font = font(12, 400);
  ctx.fillStyle = rgba(palette.text, 0.6);
  ctx.fillText(footer.tagline, lx, cy + 12);

  // Center: the two disclaimers.
  ctx.textAlign = "center";
  ctx.font = font(11.5, 400);
  ctx.fillStyle = rgba(palette.text, 0.48);
  ctx.fillText(footer.disclaimer1, width / 2, cy - 12);
  ctx.fillText(footer.disclaimer2, width / 2, cy + 12);

  // Right: QQ group over the project URL.
  ctx.textAlign = "right";
  ctx.font = font(12, 600);
  ctx.fillStyle = rgba(palette.text, 0.72);
  ctx.fillText(footer.qqGroup, width - PAD, cy - 11);
  ctx.font = font(12, 400);
  ctx.fillStyle = rgba(palette.text, 0.55);
  ctx.fillText(GITHUB_URL, width - PAD, cy + 12);
}

/** Fixed 2× supersampling: the share shot keeps crisp small text when pasted
 * into HiDPI chat clients. All draw code below works in logical units. */
const SCALE = 2;

/** Paint the share shot and return PNG bytes. `el` (any live panel element)
 * supplies the theme palette; the footer strings are the localized watermark
 * lines (see ShotFooterStrings). */
export async function renderPostBattleShot(
  model: ShotModel,
  opts: { el?: HTMLElement | null } & ShotFooterStrings,
): Promise<Uint8Array> {
  const palette = readPalette(opts.el);
  const cols = model.columns;
  const width = PAD * 2 + cols.length * COL_WIDTH + (cols.length - 1) * COL_GAP;
  const maxRows = Math.max(...cols.map((c) => c.rows.length), 0);
  const height = HEAD_H + COL_TITLE_H + maxRows * (ROW_H + 6) + 10 + FOOT_H;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * SCALE);
  canvas.height = Math.round(height * SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.scale(SCALE, SCALE);

  // Background + subtle panel surface behind the matrix.
  ctx.fillStyle = rgba(palette.bg, 1);
  ctx.fillRect(0, 0, width, height);

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
  if (model.mapLabel) {
    ctx.textAlign = "right";
    ctx.font = font(14, 400);
    ctx.fillStyle = rgba(palette.muted, 1);
    ctx.fillText(model.mapLabel, width - PAD, HEAD_H / 2 + 2);
    ctx.textAlign = "left";
  }
  ctx.fillStyle = rgba(palette.text, 0.1);
  ctx.fillRect(PAD, HEAD_H - 6, width - PAD * 2, 1);

  // Pre-measure stat cell widths with the row font active. The block's
  // total width also bounds the nick text (see the row loop) — and the
  // same origins anchor the column-title aggregate values.
  ctx.font = font(13.5, 600, true);
  const origins = statOrigins(ctx, cols);
  const statsW = (origins[origins.length - 1] ?? 0) + 24;

  // Column titles (+ aggregate) and rows. The footer's logo loads alongside
  // the class icons so the paint never waits twice on the network.
  const icons = await Promise.all([
    ...cols.flatMap((c) =>
      c.rows.map((r) => loadImage(shipIconUrl(r.shipType, r.iconVariant ?? "plain"))),
    ),
    loadImage(LOGO_URL),
  ]);
  const logo = icons.pop() ?? null;
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
      ctx.globalAlpha = 1;
      y += ROW_H + 6;
    }
  }

  drawFooter(ctx, palette, width, opts, logo);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) throw new Error("PNG encode failed");
  return new Uint8Array(await blob.arrayBuffer());
}
