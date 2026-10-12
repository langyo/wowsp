/**
 * Pure derivation for the 游玩时间 page's PR trend chart: turns the cached
 * per-ship history points (`read_ship_stats_history`) plus the wows-numbers
 * expected-values table (`get_expected_pr_table`) into per-interval PR
 * points a line chart can plot, for any subset of the ships (all / one
 * type / one ship). The rating is the wows-numbers formula ported from
 * Rust `wg_api::expected_pr_from_totals` — the constants here MUST stay in
 * lockstep with it, and the subset aggregation mirrors
 * `wg_api::expected_account_pr` (battle-weighted expected sums, never a
 * mean of per-ship PRs). Everything is deterministic and side-effect-free;
 * the section component owns loading/localization/rendering, the tests pin
 * the math (same contract as playtimeAgg / battleBreakdown).
 *
 * Ship identity (type / tier / name) resolves through the offline ship DB
 * (`src/data/ship_names.json`) for the same no-three.js reason
 * battleBreakdown states: this module must stay cheap to import.
 */
import type { ExpectedPrEntry, ShipStatsHistoryPoint } from "@/api";
import shipNamesDbRaw from "../../data/ship_names.json";

// ── Ship identity (offline DB) ────────────────────────────────────────────

interface ShipDbEntry {
  tier?: number | null;
  type?: string | null;
  nation?: string | null;
  names?: Record<string, string> | null;
}

const SHIP_DB = shipNamesDbRaw as Record<string, ShipDbEntry>;

/** The game's five ship-type strings the offline DB carries (same set as
 *  battleBreakdown's — no key is a prefix of another, so the startsWith
 *  match never mis-buckets). Anything else (event ships, unknown ids) is
 *  "unknown". */
const TYPE_KEYS = ["AirCarrier", "Battleship", "Destroyer", "Submarine", "Cruiser"];

function dbEntryOf(shipId: number): ShipDbEntry | null {
  return SHIP_DB[String(shipId)] ?? null;
}

/** The ship's type key ("Battleship" / … / "unknown") for type filtering. */
export function prTrendShipType(shipId: number): string {
  const type = dbEntryOf(shipId)?.type ?? "";
  return TYPE_KEYS.find((k) => type.startsWith(k)) ?? "unknown";
}

/** The ship's tier (null when unknown) — the filter pill's "T10 ·" prefix. */
export function prTrendShipTier(shipId: number): number | null {
  return dbEntryOf(shipId)?.tier ?? null;
}

/** Localized ship name: the locale's entry, else en-US, else any, else the
 * * raw id (the chart must never render an empty pill). */
export function prTrendShipName(shipId: number, locale: string): string {
  const names = dbEntryOf(shipId)?.names;
  if (!names) return String(shipId);
  return names[locale] ?? names["en-US"] ?? Object.values(names)[0] ?? String(shipId);
}

// ── Interval deltas ───────────────────────────────────────────────────────

/** One interval's per-ship career delta — the battles (with wins / damage /
 *  frags) played between two adjacent history observations. */
export interface PrTrendDelta {
  shipId: number;
  battles: number;
  wins: number;
  damage: number;
  frags: number;
}

/** One history interval: the LATER point's timestamp (when the totals were
 *  observed — the x the chart plots) plus the per-ship deltas since the
 *  previous observation. */
export interface PrTrendInterval {
  t: number;
  deltas: PrTrendDelta[];
}

/** History points → per-interval deltas. Career totals are monotonic, so a
 *  delta is `now − last seen`; the baseline is each ship's LAST SEEN row,
 *  not merely the previous point's — upstream retention drops rows between
 *  fetches, and rebasing a returning ship on zero would resurrect its whole
 *  career as one interval. Deltas clamp at zero (a cache written by an
 *  older build must not poison a negative interval) and ships with no new
 *  battles stay out of the interval. The first observation's full totals
 *  become the first interval — everything before WoWSP started caching is
 *  the career baseline the trend grows from. */
export function prTrendIntervals(history: ShipStatsHistoryPoint[]): PrTrendInterval[] {
  const lastSeen = new Map<
    number,
    { battles: number; wins: number; damage: number; frags: number }
  >();
  const out: PrTrendInterval[] = [];
  for (const p of [...history].sort((a, b) => a.timestamp - b.timestamp)) {
    const deltas: PrTrendDelta[] = [];
    for (const s of p.ships) {
      const prev = lastSeen.get(s.shipId);
      const delta = {
        shipId: s.shipId,
        battles: Math.max(0, s.battles - (prev?.battles ?? 0)),
        wins: Math.max(0, s.wins - (prev?.wins ?? 0)),
        damage: Math.max(0, s.damageCaused - (prev?.damage ?? 0)),
        frags: Math.max(0, s.frags - (prev?.frags ?? 0)),
      };
      lastSeen.set(s.shipId, {
        battles: s.battles,
        wins: s.wins,
        damage: s.damageCaused,
        frags: s.frags,
      });
      if (delta.battles > 0) deltas.push(delta);
    }
    out.push({ t: p.timestamp, deltas });
  }
  return out;
}

// ── The PR formula (port of wg_api::expected_pr_from_totals) ──────────────

/** wows-numbers personal rating from actual/expected totals: each ratio is
 *  normalized — damage (r−0.4)/0.6, frags (r−0.1)/0.9, wins (r−0.7)/0.3,
 *  each floored at zero — and combined as PR = 700·nDmg + 300·nFrags +
 *  150·nWins (playing exactly at the server average lands on 1150).
 *  Rounded and clamped to [0, 10000]. Null when an expected total is
 *  unusable. Keep in lockstep with the Rust original. */
export function expectedPrFromTotals(
  actualDamage: number,
  actualFrags: number,
  actualWins: number,
  expectedDamage: number,
  expectedFrags: number,
  expectedWins: number,
): number | null {
  if (expectedDamage <= 0 || expectedFrags <= 0 || expectedWins <= 0) return null;
  const normalize = (ratio: number, floor: number, span: number) =>
    Math.max(0, (ratio - floor) / span);
  const pr =
    700 * normalize(actualDamage / expectedDamage, 0.4, 0.6) +
    300 * normalize(actualFrags / expectedFrags, 0.1, 0.9) +
    150 * normalize(actualWins / expectedWins, 0.7, 0.3);
  return Math.min(10_000, Math.max(0, Math.round(pr)));
}

// ── Interval → plottable point ────────────────────────────────────────────

/** One plottable point of the PR line. */
export interface PrTrendPoint {
  /** Unix seconds of the interval's later history point. */
  t: number;
  pr: number;
  /** Battles played in the interval over the selected ships. */
  battles: number;
  /** Interval winrate in percent (hover hint). */
  winrate: number;
}

/** The expected table as a ship-id map (one build, many lookups). */
export function expectedPrMap(entries: ExpectedPrEntry[]): Map<number, ExpectedPrEntry> {
  return new Map(entries.map((e) => [e.shipId, e]));
}

/** Aggregate one interval's deltas over the SELECTED ships into a PR point.
 *  Expected sums are battle-weighted per ship — the aggregation
 *  `expected_account_pr` performs, NOT a mean of per-ship PRs — and ships
 *  missing from the expected table are skipped on BOTH sides (their battles
 *  don't count toward `battles` either, keeping the hint honest). Null when
 *  no selected ship carries expected values (an unrated interval). */
export function prOfInterval(
  interval: PrTrendInterval,
  expected: ReadonlyMap<number, ExpectedPrEntry>,
  include: (shipId: number) => boolean,
): PrTrendPoint | null {
  let aDmg = 0;
  let aFrags = 0;
  let aWins = 0;
  let eDmg = 0;
  let eFrags = 0;
  let eWins = 0;
  let battles = 0;
  for (const d of interval.deltas) {
    if (!include(d.shipId)) continue;
    const ev = expected.get(d.shipId);
    if (!ev) continue;
    battles += d.battles;
    aDmg += d.damage;
    aFrags += d.frags;
    aWins += d.wins;
    eDmg += ev.avgDamage * d.battles;
    eFrags += ev.avgFrags * d.battles;
    eWins += (ev.winrate / 100) * d.battles;
  }
  const pr = expectedPrFromTotals(aDmg, aFrags, aWins, eDmg, eFrags, eWins);
  if (pr == null) return null;
  return { t: interval.t, pr, battles, winrate: battles > 0 ? (aWins / battles) * 100 : 0 };
}

// ── Time-range window ─────────────────────────────────────────────────────

/** The chart's time-range presets (the segmented tabs). */
export type PrTrendRangeKey = "7d" | "30d" | "90d" | "all" | "custom";

const DAY_SECONDS = 86_400;

/** Keep the intervals whose observation time (`t`, the LATER point of each
 *  pair) falls inside the window: presets cut N days back from `nowSec`;
 *  `custom` keeps the inclusive `[fromSec, toSec]` local-day window (the
 *  shape `isoDayWindowSec` returns); `all` is the identity. Intervals are
 *  timestamp-sorted already, but the filter stays a plain scan — the
 *  boundary inclusivity is the contract the tests pin. */
export function filterIntervalsByRange(
  intervals: PrTrendInterval[],
  range: {
    key: PrTrendRangeKey;
    fromSec?: number | null;
    toSec?: number | null;
  },
  nowSec: number,
): PrTrendInterval[] {
  if (range.key === "all") return intervals;
  let fromSec: number;
  let toSec = Number.POSITIVE_INFINITY;
  if (range.key === "custom") {
    if (range.fromSec == null || range.toSec == null) return [];
    fromSec = range.fromSec;
    toSec = range.toSec;
  } else {
    const days = range.key === "7d" ? 7 : range.key === "30d" ? 30 : 90;
    fromSec = nowSec - days * DAY_SECONDS;
  }
  return intervals.filter((iv) => iv.t >= fromSec && iv.t <= toSec);
}

// ── Filter catalog ────────────────────────────────────────────────────────

/** One ship offered by the chart's filters, aggregated over the selected
 *  range: the popup row shows the battles / winrate / average damage these
 *  deltas carry. */
export interface PrTrendShip {
  shipId: number;
  /** Total delta battles over the history window (the row's sort key). */
  battles: number;
  wins: number;
  damage: number;
  /** Resolved type key ("Battleship" / … / "unknown"). */
  type: string;
  tier: number | null;
}

/** The ships worth offering in the chart's filter list: every ship with
 *  battles in at least one interval, most-played first (ties by ship id,
 *  keeping the row order stable as selections toggle). */
export function prTrendShipCatalog(intervals: PrTrendInterval[]): PrTrendShip[] {
  const agg = new Map<number, { battles: number; wins: number; damage: number }>();
  for (const iv of intervals) {
    for (const d of iv.deltas) {
      const a = agg.get(d.shipId) ?? { battles: 0, wins: 0, damage: 0 };
      a.battles += d.battles;
      a.wins += d.wins;
      a.damage += d.damage;
      agg.set(d.shipId, a);
    }
  }
  return [...agg.entries()]
    .filter(([, a]) => a.battles > 0)
    .map(([shipId, a]) => ({
      shipId,
      battles: a.battles,
      wins: a.wins,
      damage: a.damage,
      type: prTrendShipType(shipId),
      tier: prTrendShipTier(shipId),
    }))
    .sort((a, b) => b.battles - a.battles || a.shipId - b.shipId);
}

/** The tier brackets the ship popup's second button group offers — the
 *  water-meter bar's own grouping (ShipFilterBar's TIER_FILTERS), kept in
 *  lockstep so both popups read the same. Ships outside every bracket
 *  (tier unknown / ★-less curios) never match a concrete pick. */
export const PR_TREND_TIER_BRACKETS: { key: string; label: string; tiers: number[] }[] = [
  { key: "I-V", label: "I – V", tiers: [1, 2, 3, 4, 5] },
  { key: "VI-VII", label: "VI – VII", tiers: [6, 7] },
  { key: "VIII-IX", label: "VIII – IX", tiers: [8, 9] },
  { key: "X-star", label: "X – ★", tiers: [10, 11] },
];

/** Whether a ship's tier falls in the bracket (null tiers match nothing —
 *  the same face an unclassifiable ship had before brackets existed). */
export function prTrendTierMatches(tier: number | null, bracketKey: string): boolean {
  if (tier == null) return false;
  const b = PR_TREND_TIER_BRACKETS.find((x) => x.key === bracketKey);
  return b != null && b.tiers.includes(tier);
}

// ── Chart geometry ────────────────────────────────────────────────────────

/** The line chart's frame (mirrors playtimeAgg's TREND_FRAME role). */
export const PR_TREND_FRAME = {
  width: 640,
  height: 220,
  /** Left pad carrying the y-axis labels. */
  sidePad: 46,
  topPad: 14,
  bottomPad: 26,
} as const;

/** PR tier thresholds (utils/winrate prTier's bands) that draw a faint
 *  horizontal guide when they fall inside the y domain — reading progress
 *  against the community scale, not just against yourself. */
export const PR_TREND_GUIDES = [750, 1350, 1750, 2100, 2450] as const;

/** One rendered vertex of the line. */
export interface PrTrendVertex {
  x: number;
  y: number;
}

export interface PrTrendLayout {
  width: number;
  height: number;
  sidePad: number;
  topPad: number;
  baselineY: number;
  /** Y domain actually plotted (padded to a 250 multiple, ≥500 tall). */
  yMin: number;
  yMax: number;
  /** Tier guides inside the domain: y position + the threshold value. */
  guides: { y: number; pr: number }[];
  /** Evenly spaced x tick positions with their timestamps (labeling is the
   *  caller's — locale lives there). */
  xTicks: { x: number; t: number }[];
  vertices: PrTrendVertex[];
  /** Polyline through the vertices (empty when fewer than two points). */
  path: string;
}

/** Points → chart geometry. The y domain pads the value range to a 250
 *  multiple and never spans less than 500, so a flat line doesn't fill the
 *  frame with zoomed-in noise; the x axis is linear in time (single-point
 *  series center on the frame). Pure and unit-tested like trendBars. */
export function prTrendLayout(
  points: readonly { t: number; pr: number }[],
  opts: { width?: number; height?: number } = {},
): PrTrendLayout {
  const { width, height, sidePad, topPad, bottomPad } = {
    ...PR_TREND_FRAME,
    ...opts,
  };
  const baselineY = height - bottomPad;
  const plotH = baselineY - topPad;
  const plotW = width - 2 * sidePad;

  const prs = points.map((p) => p.pr);
  const rawMin = prs.length > 0 ? Math.min(...prs) : 0;
  const rawMax = prs.length > 0 ? Math.max(...prs) : 1000;
  let yMin = Math.floor((rawMin - 125) / 250) * 250;
  let yMax = Math.ceil((rawMax + 125) / 250) * 250;
  yMin = Math.max(0, yMin);
  if (yMax - yMin < 500) yMax = yMin + 500;
  const yOf = (pr: number) => baselineY - ((pr - yMin) / (yMax - yMin)) * plotH;

  const t0 = points.length > 0 ? points[0].t : 0;
  const t1 = points.length > 0 ? points[points.length - 1].t : 1;
  const span = Math.max(1, t1 - t0);
  const xOf = (t: number) =>
    points.length <= 1 ? sidePad + plotW / 2 : sidePad + ((t - t0) / span) * plotW;

  const vertices = points.map((p) => ({
    x: fmtN(xOf(p.t)),
    y: fmtN(yOf(p.pr)),
  }));
  const path =
    vertices.length >= 2
      ? vertices.map((v, i) => `${i === 0 ? "M" : "L"} ${v.x} ${v.y}`).join(" ")
      : "";

  const guidePrs = PR_TREND_GUIDES.filter((g) => g > yMin && g <= yMax);
  const guides = guidePrs.map((pr) => ({ y: fmtN(yOf(pr)), pr }));

  const tickCount = Math.min(5, points.length);
  const xTicks = Array.from({ length: tickCount }, (_, i) => {
    const f = tickCount === 1 ? 0 : i / (tickCount - 1);
    const t = t0 + f * span;
    return { x: fmtN(xOf(t)), t: Math.round(t) };
  });

  return {
    width,
    height,
    sidePad,
    topPad,
    baselineY,
    yMin,
    yMax,
    guides,
    xTicks,
    vertices,
    path,
  };
}

/** Trim float noise so path strings stay short and deterministic. */
function fmtN(n: number): number {
  return Math.round(n * 100) / 100;
}
