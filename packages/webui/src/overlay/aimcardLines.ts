/**
 * Pure HTML builders for the aim card's lines — string-in/string-out so the
 * bare-DOM page's render decisions are unit-testable without a DOM, the
 * same split rowList.ts/chipFit.ts give the table page.
 *
 * The card is FOUR stacked lines under the crosshair (the user's spec):
 *   1. the aimed player's clan tag + nickname;
 *   2. the career (overall average) figures — the same four the tab chips
 *      render, plus the optional fifth K/D figure when the user configured
 *      a K/D column (the tab table's own rule, so the card and the chips
 *      never disagree about which figures exist);
 *   3. the aimed player's per-ship figures for the ship they are sailing
 *      THIS battle, the readable ship name riding as the muted scope tag;
 *   4. the seal cluster (career verdict + composition tags) — the SAME
 *      stamps the tab chips flank their numbers with, as one horizontal
 *      line. Present only when a verdict exists.
 *
 * Lines 2 and 3 share one column grid (see the SCSS — four tracks, five
 * while the K/D figure rides) so the two figure rows read as aligned
 * columns; the builders here emit one row's cells in fixed
 * winrate → PR → battles → damage (+ K/D) order.
 */
import {
  battlesColor,
  damageColor,
  prTier,
  resolveStamps,
  winrateColor,
  type CareerStamp,
  type StampKind,
} from "@/utils/winrate";
import { AI_NAME } from "@/utils/aiNames";

/** Wire shape of one `lookup_players_stats_batch` row (the fields the card
 *  reads; the rest of the row is ignored here). */
export interface BatchStat {
  winrate?: number | null;
  avgDamage?: number | null;
  pr?: number | null;
  battles?: number | null;
  /** Kills / deaths over the randoms career (frags / (battles − survived)
   *  — the game's own caliber, the same wire field the table page reads). */
  kdRatio?: number | null;
  clanTag?: string | null;
  clanId?: number | null;
  accountId?: number | null;
  /** The cluster the stats resolved on — a cross-server Clan-Battles pass
   *  can adopt a foreign-realm account; the per-ship fetch and the hidden
   *  profile's clan gate ride THIS realm, not the window's. */
  realm?: string | null;
  hidden: boolean;
}

/** The per-ship row the card's third line reads (the enriched
 *  `lookup_player_ship_stats` entry — see tauri_shared's PlayerShipStats;
 *  only the fields the card renders are named). */
export interface AimShipRow {
  shipId: number;
  name: string;
  winrate: number;
  avgDamage: number;
  battles: number;
  pr: number | null;
  /** Raw counters the per-ship K/D derives from (frags / (battles −
   *  survived), the game's caliber — same fields the table page's
   *  ship-scoped columns aggregate). */
  frags: number;
  survivedBattles: number;
}

/** One per-ship row's K/D — the game's own frags / (battles − survived)
 *  caliber. null when the row never had a death to divide by (an
 *  all-survive career has no ratio, not a zero). */
export function shipRowKd(row: AimShipRow): number | null {
  return row.battles > row.survivedBattles
    ? row.frags / (row.battles - row.survivedBattles)
    : null;
}

/** Composition-seal verdict from `lookup_players_composition` (mirrors
 *  `wowsp_tauri_shared::PlayerComposition`). */
export interface AimComposition {
  air: boolean;
  sub: boolean;
  airVeteran: boolean;
  subVeteran: boolean;
}

/** The seal-line render options: the prefs' kill switches and the user's
 *  custom seal pictures (kind → asset URL, absent = the plain text seal). */
export interface SealLineOptions {
  disabled: ReadonlySet<StampKind>;
  custom: Partial<Record<StampKind, string>>;
}

/** The aim verdict's display name: the raw name when the target is a
 *  resolvable player, "" when it is judged AI. Two judgment layers,
 *  either suffices: the shared AI-name styles (colon-wrapped bots,
 *  `IDS_*` / `#` scripted units) and the probe's per-battle bot list —
 *  the game's own `isBot` records, which catch the event PvEvP bots
 *  that sail under NORMAL nicknames no style can match. A "" verdict
 *  renders NO card at all: an AI target has nothing worth showing, not
 *  even a bare-headed name. */
export function aimDisplayName(raw: string, bots: ReadonlySet<string>): string {
  return raw && (AI_NAME.test(raw) || bots.has(raw)) ? "" : raw;
}

/** kind → Chinese label, copied verbatim from the table page's STAMP_TEXT
 *  (main.ts) — the seal vocabulary is deliberately locale-free CJK, the
 *  same wording the tab chips and the in-app RatingStamp faces use. */
export const STAMP_TEXT: Record<StampKind, string> = {
  miracle: "神了",
  ape: "猴",
  maggot: "蛆",
  rat: "过街老鼠",
  air: "空中小人",
  sub: "水下小人",
  airVeteran: "空中奶龙",
  subVeteran: "水下奶蛙",
  airMiracle: "空中神人",
  subMiracle: "水下神人",
  airApe: "空中小猴",
  subApe: "水下小猴",
};

/** The dots loader's shared period — 1.2s, the same clock the table
 *  page's .overlay-dots animation names; change the two together. */
const DOTS_PERIOD_MS = 1200;

/** One bold mono figure cell (the tier color arrives inline, the muted
 *  gray `.aim-none` face when there is no value) — the em dash never
 *  becomes a zero, the table chips' same convention. */
function fig(inner: string, color?: string): string {
  return `<b class="aim-num${color ? "" : " aim-none"}"${
    color ? ` style="color:${color}"` : ""
  }>${inner}</b>`;
}

/** Formatters shared with the table page's conventions (aimcard.ts owns
 *  the same pair for its career line — kept local so this module stays
 *  dependency-free of the page). */
function fmtDamage(avg: number): string {
  return avg >= 100000 ? `${Math.round(avg / 1000)}k` : `${(avg / 1000).toFixed(1)}k`;
}

function fmtBattles(n: number): string {
  return n >= 100000 ? `${Math.round(n / 1000)}k` : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** The battle count wearing its locale's unit, split around {n} so the
 *  count stays on the mono face and the unit word drops to the text face —
 *  the table page's battlesText. ONE bold cell wraps both halves (the
 *  figure grid counts cells, not runs), and the optional color rides the
 *  cell so the unit inherits it like the tab's pair. */
export function battlesText(n: number, pattern: string, color?: string): string {
  const at = pattern.indexOf("{n}");
  const style = color ? ` style="color:${color}"` : "";
  if (at < 0) return `<b class="aim-num"${style}>${fmtBattles(n)}</b>`;
  const unit = (text: string) => (text ? `<span class="aim-unit">${text}</span>` : "");
  return (
    `<b class="aim-num"${style}>` +
    unit(pattern.slice(0, at)) +
    fmtBattles(n) +
    unit(pattern.slice(at + 3)) +
    `</b>`
  );
}

/** The career figure cells (line 2) — the four fixed figures plus the
 *  optional K/D one when `showKd` is on (the user configured a K/D column;
 *  aimcard.ts derives the switch off the same prefs the table reads).
 *  Every missing value degrades to the em dash — a hidden profile and an
 *  in-flight lookup render the same face (the card is a glance, not a
 *  status board). */
export function careerLineHtml(
  s: BatchStat | null | undefined,
  battlesPattern: string,
  showKd = false,
): string {
  const wr = !s || s.hidden ? null : s.winrate;
  const pr = !s || s.hidden ? null : s.pr;
  const battles = !s || s.hidden ? null : s.battles;
  const dmg = !s || s.hidden ? null : s.avgDamage;
  const kd = !s || s.hidden ? null : s.kdRatio;
  const prBand = prTier(pr);
  return [
    fig(wr != null ? `${wr.toFixed(1)}%` : "—", wr != null ? winrateColor(wr) : undefined),
    fig(pr != null ? `${Math.round(pr)}` : "—", pr != null ? prBand.color : undefined),
    battles != null
      ? battlesText(battles, battlesPattern, battlesColor(battles))
      : fig("—"),
    fig(dmg != null ? fmtDamage(dmg) : "—", dmg != null ? damageColor(dmg) : undefined),
    // The game's two-decimal K/D face, plain ink — no tier color band
    // exists for a kills/deaths ratio.
    ...(showKd ? [fig(kd != null ? kd.toFixed(2) : "—")] : []),
  ].join("");
}

/** The per-ship figure cells for the battle ship's row, or the per-case
 *  placeholder: `undefined` list = still owed → the chasing dots face
 *  (dashes would read as "never played this ship", which the landing
 *  numbers would contradict a beat later); a landed list without the
 *  ship's row (never played it) renders label + dashes. `null` is the
 *  failed-lookup verdict, same dashes. The readable ship name rides
 *  INSIDE the first cell (the tab scope tag's same trick), so the row
 *  counts exactly as many cells as the career one (four, five with the
 *  K/D figure) and the shared grid keeps its columns;
 *  `shipLabel` is interpolated RAW — the caller escapes it (it is game
 *  data). `now` phase-locks the dots' chase to the shared clock so
 *  render() rebuilds never restart the animation (the table page's
 *  loadingDots math, passed in to keep this module free of the DOM
 *  clock). */
export function shipLineHtml(
  ships: readonly AimShipRow[] | null | undefined,
  shipId: number,
  shipLabel: string,
  battlesPattern: string,
  now = 0,
  showKd = false,
): string {
  const tag = `<span class="aim-ship-tag">${shipLabel}</span>`;
  if (ships === undefined) {
    const period = DOTS_PERIOD_MS;
    const step = period / 3;
    const beads = [0, 1, 2]
      .map(
        (i) =>
          `<i style="animation-delay:${(
            -(((now + i * step) % period) / 1000)
          ).toFixed(3)}s"></i>`,
      )
      .join("");
    return `<span class="aim-ship-cell">${tag}<span class="aim-dots" aria-hidden="true">${beads}</span></span>`;
  }
  const row = ships?.find((r) => r.shipId === shipId) ?? null;
  const wr = row ? row.winrate : null;
  const pr = row?.pr ?? null;
  const battles = row ? row.battles : null;
  const dmg = row ? row.avgDamage : null;
  const kd = row ? shipRowKd(row) : null;
  const prBand = prTier(pr);
  return [
    `<span class="aim-ship-cell">${tag}` +
      fig(wr != null ? `${wr.toFixed(1)}%` : "—", wr != null ? winrateColor(wr) : undefined) +
      `</span>`,
    fig(pr != null ? `${Math.round(pr)}` : "—", pr != null ? prBand.color : undefined),
    // The battle ship's own count carries no thin-sample warning — under
    // 200 battles on one ship is the norm (the career line keeps its red).
    battles != null ? battlesText(battles, battlesPattern) : fig("—"),
    fig(dmg != null ? fmtDamage(dmg) : "—", dmg != null ? damageColor(dmg) : undefined),
    // Same two-decimal plain-ink K/D face as the career line, over the
    // row's own raw counters.
    ...(showKd ? [fig(kd != null ? kd.toFixed(2) : "—")] : []),
  ].join("");
}

/** One seal node: the verdict wording as PLAIN TEXT in the cinnabar plate —
 *  the overlay deliberately skips the calligraphy bitmaps the in-app
 *  RatingStamp faces press (too small at chip scale) — or the user's
 *  custom picture when the seal customizer imported one. A kill-switched
 *  kind renders nothing. */
export function stampNode(kind: StampKind, opts: SealLineOptions): string {
  if (opts.disabled.has(kind)) return "";
  const label = STAMP_TEXT[kind];
  const custom = opts.custom[kind];
  if (custom != null) {
    return `<img class="aim-stamp" data-stamp="${kind}" src="${custom}" alt="${label}" title="${label}">`;
  }
  return `<span class="aim-stamp" data-stamp="${kind}" title="${label}">${label}</span>`;
}

/** The seal cluster (line 4): the career verdict and the composition tags
 *  through the shared merge rule, as one horizontal line. Empty string
 *  when nothing applies (no verdict, or every kind kill-switched). */
export function sealLineHtml(
  career: CareerStamp | null,
  comp: AimComposition | null | undefined,
  opts: SealLineOptions,
): string {
  return resolveStamps(career, comp)
    .map((kind) => stampNode(kind, opts))
    .join("");
}
