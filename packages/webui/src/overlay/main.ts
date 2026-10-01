/**
 * Overlay window bootstrap — deliberately NOT Vue.
 *
 * The Rust Tab watcher shows this window only after the battle-HUD probe
 * passes, and this page must paint instantly, so it is bare DOM: a tiny
 * listener renders per-player chips from two Tauri events:
 *
 *   - `wowsp://arena-info`  → roster snapshot (names, teams) → schedules ONE
 *     batched WG stats lookup (same backend command the main window uses);
 *   - `wowsp://sink-attrib` → one sink transition's solved victims (row
 *     indices into each side's pre-sink alive order) → the sunk tracker
 *     keeps the row→name mapping EXACT mid-battle (utils/sunkTracker);
 *   - `wowsp://overlay-anchor` → table geometry (rows, team split) → chips
 *     are positioned at each row.
 *
 * Coordinates arrive in physical px relative to the overlay window's own
 * origin; CSS px = physical / devicePixelRatio.
 */
import {
  battlesColor,
  careerStamp,
  damageColor,
  prTier,
  winrateColor,
  type StampKind,
} from "@/utils/winrate";
// Pure-TS transport wrapper (no Vue/Pinia) — safe for this bare-DOM page,
// same as @/utils/winrate above.
import { clanWinrateKey, lookupClanWinrate } from "@/utils/clanWinrate";
// Team aggregates for the per-side summary cards (same helper the live
// panel's column titles use).
import { aggregateTeamStats } from "@/utils/teamAggregate";
// Inferred roster mode: the row→name mapping derived from the verified Tab
// sort rule over the roster + the anchor's alive flags (no OCR) — see
// inferredOrder.ts.
import { inferredRowMapping } from "./inferredOrder";
// Bot folding for candidate-range chips (see candidates.ts).
import { collapseCandidateBots } from "./candidates";
// Post-layout pass keeping chips inside the overlay window — a chip wider
// than the reserved side pad would otherwise clip flat at the window edge.
import { fitChips, refitWhenSealsSettle } from "./chipFit";
// Two-sided team consumable intel (radar/hydro/smoke estimate counts +
// longest radar range) from the baked capability asset, overlaid by the
// runtime-downloaded copy when the shell has one cached.
import {
  formatIntelCount,
  formatIntelKm,
  setRuntimeKit,
  teamIntelFor,
  type TeamIntelCount,
} from "./teamIntel";
// Display prefs (content toggles + the ranked/random stats source), read
// once at window creation with the same tolerant contract as the store.
import {
  readOverlayDisplayPrefs,
  resolveRosterStatsMode,
  rosterStatView,
  type RawStat,
  type RosterModeNumbers,
  type ResolvedStatsMode,
} from "./overlayPrefs";
import { SunkTracker, type SunkSide } from "@/utils/sunkTracker";
import { pluginRowMapping } from "./inferredOrder";
import { gameTabRowKey, shipTierOf } from "@/utils/shipClass";
import { isOperationBattle } from "@/utils/modeColors";
// Bots (`:Name:`) and operation scenario units (`IDS_*`) have no WG
// account — the shared store-free regex (utils/aiNames.ts) covers both.
import { AI_NAME } from "@/utils/aiNames";
import "./overlay.css";

// Same locale files the Vue app consumes — one source of truth for the hint
// copy, bundled eagerly into this tiny page (a few KB across 9 locales).
interface OverlayMessages {
  /** Failed-locate copy (the centered hint box IS the failure). */
  locateHint: string;
  /** Locating copy: detection is on, the table just isn't pinned yet. */
  locatingHint: string;
  /** Badge while the batched stats lookup is still working and at least
   *  one mapped chip has no numbers yet. */
  queryingBadge: string;
  /** Team-intel card copy (the two-sided consumable summary): side
   *  labels, the three family names, and the longest-range prefix. */
  intelAlly: string;
  intelEnemy: string;
  intelRadar: string;
  intelHydro: string;
  intelSmoke: string;
  intelRange: string;
  /** Team-average line labels (the per-side summary card's third line). */
  avgWinrate: string;
  avgPr: string;
  avgDmg: string;
}
const MESSAGES = import.meta.glob<OverlayMessages>(
  "../../../../res/i18n/locales/*/overlay.json",
  { eager: true },
);
const hintMessages = new Map<string, OverlayMessages>();
for (const [path, mod] of Object.entries(MESSAGES)) {
  const m = path.match(/locales\/([a-zA-Z-]+)\/overlay\.json$/);
  if (m && mod?.locatingHint) hintMessages.set(m[1], mod);
}

function localized(key: keyof OverlayMessages): string {
  const exact = hintMessages.get(locale)?.[key];
  if (exact) return exact;
  const lang = locale.split("-")[0];
  const byLang = [...hintMessages.entries()].find(([k]) => k.split("-")[0] === lang);
  if (byLang) return byLang[1][key];
  return hintMessages.get("en-US")?.[key] ?? [...hintMessages.values()][0]?.[key] ?? "";
}

interface OverlayTauriApi {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: {
    listen: (ev: string, h: (e: { payload: unknown }) => void) => Promise<() => void>;
  };
}

interface Vehicle {
  id: number;
  name: string;
  relation: number;
  shipId: number;
}

interface ArenaInfo {
  matchGroup?: string | null;
  dateTime?: string | null;
  /** Operation scenarios (行动) carry the PCVO* battle script here. */
  scenario?: string | null;
  eventType?: string | null;
  vehicles: Vehicle[];
}

interface OverlayAnchor {
  overlayRect: { x: number; y: number; width: number; height: number };
  rosterRect: { x: number; y: number; width: number; height: number };
  rowCenters: number[];
  teamSplit: number;
  /** False → the anchor used fallback geometry (table not located); the
   *  page renders a hint box instead of (mis)placed stat chips. */
  tableDetected?: boolean;
  /** Per-row alive classification read off the name strips (sunk rows
   *  render dim gray in-game). Same length/order as rowCenters; true =
   *  alive; null/absent = unknown (treat every row as alive). */
  rowAlive?: boolean[] | null;
  /** Roster attribution mode in force backend-side — "inferred" (the
   *  default) | "off". "inferred" means this page derives the mapping
   *  itself from the arena roster + rowAlive via the client's own Tab
   *  sort key (see inferredOrder.ts), kept exact mid-battle by the
   *  sink-attribution tracker. "off" or an absent field (older backend)
   *  is the historical index mapping. */
  rosterMode?: string;
}

/** The cached per-player stat (the wire row below, with the per-mode
 *  payloads nested the way `rosterStatView` reads them). */
type Stat = RawStat;

/** Wire shape of one `lookup_players_stats_batch` row — flat per-mode
 *  fields; the batch handler below nests them into a cached `Stat`. */
interface BatchStat {
  winrate?: number | null;
  avgDamage?: number | null;
  pr?: number | null;
  battles?: number | null;
  rankedWinrate?: number | null;
  rankedPr?: number | null;
  rankedBattles?: number | null;
  rankedAvgDamage?: number | null;
  globalWinrate?: number | null;
  globalPr?: number | null;
  globalBattles?: number | null;
  globalAvgDamage?: number | null;
  /** Clan id from the batch answer (null = clanless / not found) — joins
   *  the hidden-profile 过街老鼠 clan gate below. */
  clanId?: number | null;
  /** Clan tag from the same answer — feeds the Tab sort key's display-name
   *  segment ('[TAG]name', exactly what the game's table sorts by). */
  clanTag?: string | null;
  hidden: boolean;
}

/** Composition-seal verdict from `lookup_players_composition` (mirrors
 *  `wowsp_tauri_shared::PlayerComposition`; the >200 battles / >20% share
 *  thresholds are enforced backend-side). null = no data / hidden profile /
 *  that player's lookup failed. */
interface PlayerComposition {
  air: boolean;
  sub: boolean;
}

// main.ts declares Window.__TAURI__ as `unknown` for the whole project —
// narrow it locally instead of redeclaring the global.
const tauri = (window as unknown as { __TAURI__?: OverlayTauriApi }).__TAURI__;

// Realm is forwarded by create_overlay_window only when it was detected; an
// empty value DISABLES the batch lookups below instead of falling back to a
// guess — querying a wrong realm would silently pin lookalike accounts'
// stats onto the chips.
const realm = new URLSearchParams(window.location.search).get("realm") ?? "";
// App locale forwarded by create_overlay_window — picks the hint copy.
const locale = new URLSearchParams(window.location.search).get("locale") || "en-US";

// ── Display prefs (chips / stats source / intel / team averages / seals) ─
// One tolerant read of the statsPrefs blob the main window's store owns
// (see overlayPrefs.ts for the contract): the seal gates, the per-row chip
// content toggles, the ranked/random stats source, the team-intel items
// and the team-average line. Display-only — read once at window creation,
// so a settings flip applies the next time the overlay window is
// (re)created. The chips follow the same AND-composition as the webui
// surfaces: no PR rating, no seals, and a seal switched off individually
// never renders either.
const PREFS = readOverlayDisplayPrefs();
// The seal wording is Chinese-community vocabulary — RatingStamp.tsx
// renders nothing under a non-zh UI locale, and the overlay chips follow
// suit.
const SEALS_SHOWN = PREFS.sealsOn && locale.startsWith("zh");
// Whether ANY per-row number (winrate / PR / battles / avg damage) can
// render — gates the placeholder faces and the "querying" badge the same
// way the old single avg-stats switch did.
const ANY_CHIP_ON =
  PREFS.chips.winrate || PREFS.chips.pr || PREFS.chips.battles || PREFS.chips.damage;
// Which battle-mode career the chips + team averages render, resolved per
// battle in render() ("auto" follows the arena's mode key; the fixed modes
// and the global merge pin it).
let statsMode: ResolvedStatsMode = "random";

// kind → Chinese label, copied from RatingStamp.tsx (bare DOM cannot reuse
// that Vue component).
const STAMP_TEXT: Record<StampKind, string> = {
  miracle: "神了",
  ape: "海猴",
  maggot: "蛆",
  rat: "过街老鼠",
  air: "空中小人",
  sub: "水下小人",
};

// Custom seal pictures (settings' seal customizer → commands::stamps):
// kind → asset-protocol URL, loaded once at startup. A kind absent from
// this map shows the plain text seal; the kind-keyed file name in the
// stamps folder IS the state, so a plain list call is the whole sync.
const CUSTOM_STAMPS: Partial<Record<StampKind, string>> = {};
async function loadCustomStamps(invoke: OverlayTauriApi["core"]["invoke"]) {
  try {
    const files = (await invoke("stamp_list")) as Array<{ kind: string; path: string }>;
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    for (const f of files) {
      if ((Object.keys(STAMP_TEXT) as string[]).includes(f.kind)) {
        CUSTOM_STAMPS[f.kind as StampKind] = convertFileSrc(f.path);
      }
    }
  } catch {
    // shell without the stamp commands / no customizations — defaults show
  }
}

let arena: ArenaInfo | null = null;
let anchor: OverlayAnchor | null = null;
// Per-battle trusted sunk sets, fed by the `wowsp://sink-attrib` events
// (the Rust sink solver names WHO sank by strip-fingerprint matching).
// While a side stays exact, render() lays its rows out precisely instead
// of showing candidate ranges — see utils/sunkTracker.ts.
const sunk = new SunkTracker();
// True while plugin telemetry is the authoritative sink source for the
// current battle (a valid event applied under roster mode "plugin"): the
// anchor's capture-derived alive vector then LAGS the plugin (it only
// updates on Tab holds), so its reconcile must not degrade the sets.
let telemetryAuthoritative = false;
/** The plugin's trusted sunk names, flat — stamps and the authoritative
 *  mapping branch read this instead of the capture alive vector. */
let pluginSunkNames: Set<string> | null = null;
// Latest `wowsp://overlay-status` detection state (mirrors OverlayState on
// the wire; null before the first event). Picks the two-level hint copy:
// only `fallback` is a tried-and-failed state, everything else still reads
// as "locating".
let statusState: string | null = null;
const stats = new Map<string, Stat>();
const pending = new Set<string>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
// Composition seals get their OWN cache + batch pipeline: the lookup rides
// behind the stats batch (only names whose stats already landed are queued)
// but retries independently — a failed seal batch must not stretch the
// stats backoff and vice versa.
const compositions = new Map<string, PlayerComposition | null>();
const compPending = new Set<string>();
let compBatchTimer: ReturnType<typeof setTimeout> | null = null;
let compInFlight = false;
let compRetryTimer: ReturnType<typeof setTimeout> | null = null;
let compRetryDelayMs = 2000;

// Hidden-profile 过街老鼠 clan gate: the verdict map is keyed by
// `${realm}:${clanId}` (not by name — two hidden clanmates share one
// verdict, and the shared lookupClanWinrate module dedupes them onto one
// clans/info request too). An ABSENT key = verdict not in yet → the chip
// holds its rat stamp; a stored null = the lookup failed → fail-open stamp;
// a number goes straight into careerStamp's gate.
const clanWinrates = new Map<string, number | null>();
const clanGateOut = new Set<string>();

/** Resolve the clan gate for every roster name whose stats already landed
 *  hidden with a clan. Gated on SEALS_SHOWN like the composition pipeline:
 *  with seals off no stamp ever renders, so the verdict would be dead
 *  weight. Verdicts land asynchronously and re-render — battle switches
 *  don't invalidate them (clan aggregate winrates don't churn mid-session). */
function scheduleClanGates() {
  if (!SEALS_SHOWN || !realm || !arena) return;
  for (const v of arena.vehicles) {
    if (AI_NAME.test(v.name)) continue;
    const st = stats.get(cacheKey(v.name));
    if (!st?.hidden || st.clanId == null) continue;
    const key = clanWinrateKey(realm, st.clanId);
    if (clanWinrates.has(key) || clanGateOut.has(key)) continue;
    clanGateOut.add(key);
    void lookupClanWinrate(realm, st.clanId).then((wr) => {
      clanGateOut.delete(key);
      // Only the first verdict for a clan wins the slot — later duplicates
      // (there shouldn't be any) must not resurrect a failed verdict.
      if (!clanWinrates.has(key)) clanWinrates.set(key, wr);
      render();
    });
  }
}

const cacheKey = (name: string) => `${realm}:${name}`;

function fmtDamage(avg: number): string {
  return avg >= 100000 ? `${Math.round(avg / 1000)}k` : `${(avg / 1000).toFixed(1)}k`;
}

function fmtBattles(n: number): string {
  return n >= 100000 ? `${Math.round(n / 1000)}k` : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** The seal node beside the chip numbers: the verdict wording as PLAIN
 *  TEXT in cinnabar — the overlay deliberately skips the calligraphy
 *  bitmaps the in-app RatingStamp faces press (chips are too small for
 *  the 2x2 face) — or the user's custom picture when the seal customizer
 *  imported one. data-stamp carries the kind to chipFit's trim pass (comp
 *  seals before career verdicts when a chip must shrink to stay inside
 *  the window). */
function stampNode(kind: StampKind): string {
  if (PREFS.sealsDisabled.has(kind)) return "";
  const label = STAMP_TEXT[kind];
  const custom = CUSTOM_STAMPS[kind];
  if (custom != null) {
    return `<img class="overlay-stamp" data-stamp="${kind}" src="${custom}" alt="${label}" title="${label}">`;
  }
  return `<span class="overlay-stamp" data-stamp="${kind}" title="${label}">${label}</span>`;
}

/** The per-row number block, one part per enabled chip toggle (winrate /
 *  PR / battles / avg damage) in that order, joined by dots. The values
 *  come from the stats source in force (randoms / ranked / global); a
 *  player without ANY of the enabled numbers renders the single muted
 *  dash. */
function chipNumbers(v: RosterModeNumbers): string {
  const parts: string[] = [];
  const muted = `<b class="muted">—</b>`;
  if (PREFS.chips.winrate) {
    parts.push(
      v.winrate != null
        ? `<b style="color:${winrateColor(v.winrate)}">${v.winrate.toFixed(1)}%</b>`
        : muted,
    );
  }
  if (PREFS.chips.pr && PREFS.prOn) {
    parts.push(
      v.pr != null ? `<b style="color:${prTier(v.pr).color}">${Math.round(v.pr)}</b>` : muted,
    );
  }
  if (PREFS.chips.battles) {
    // Red under 200 battles (thin-sample warning), plain above — same rule
    // as the roster panels' battles column (utils/winrate battlesColor).
    const color = battlesColor(v.battles);
    parts.push(
      v.battles != null
        ? `<b${color ? ` style="color:${color}"` : ""}>${fmtBattles(v.battles)}</b>`
        : muted,
    );
  }
  if (PREFS.chips.damage) {
    parts.push(
      v.avgDamage != null
        ? `<b style="color:${damageColor(v.avgDamage)}">${fmtDamage(v.avgDamage)}</b>`
        : muted,
    );
  }
  return parts.join(`<span class="sep">·</span>`);
}

function chipContent(name: string, side: "ally" | "enemy"): string {
  if (AI_NAME.test(name)) return ANY_CHIP_ON ? `<span class="muted">bot</span>` : "";
  const st = stats.get(cacheKey(name));
  // All chip toggles off → no numbers and none of their placeholder faces
  // either; the seals below still render (they are their own switch).
  let core: string;
  if (!ANY_CHIP_ON) core = "";
  else if (!st) core = `<span class="muted">…</span>`;
  else if (st.hidden) core = `<span class="hidden">●</span>`;
  else core = chipNumbers(rosterStatView(st, statsMode));
  if (!SEALS_SHOWN) return core;
  // Every seal of a side sits on ONE flank: allies carry theirs to the
  // LEFT of the numbers, enemies to the RIGHT — no more splitting career
  // verdict and composition tags across the chip, which read as two
  // different players' data at tab-glance distance. Career verdict leads
  // the group, then air, then sub. A name without stats yet shows no seal
  // at all — the verdicts are derived from data the stats/composition
  // batches bring. Hidden profiles with a clan additionally HOLD their
  // seal until the clan verdict lands (absent map entry): a strong clan
  // (beating the 53% gate) excuses them, and a stamp that flashes first
  // and retracts a beat later would be worse than none. A failed verdict
  // arrives as null and stamps fail-open, same as a clanless profile.
  // Verdicts always grade the OVERALL career — even when the numbers
  // beside them render the ranked source.
  let career: StampKind | null = null;
  if (st) {
    // Non-null clanId on a hidden profile = gated: an absent verdict
    // (undefined) holds the seal; a landed one (number, or null = failed
    // lookup) goes into the gate.
    const clanId = st.hidden ? st.clanId : null;
    const verdict = clanId != null ? clanWinrates.get(clanWinrateKey(realm, clanId)) : undefined;
    if (!(clanId != null && verdict === undefined)) {
      career = careerStamp(st.pr, st.battles, st.winrate, st.hidden, verdict);
    }
  }
  const comp = compositions.get(cacheKey(name)) ?? null;
  const seals =
    (career ? stampNode(career) : "") +
    (comp?.air ? stampNode("air") : "") +
    (comp?.sub ? stampNode("sub") : "");
  return side === "ally" ? seals + core : core + seals;
}

/** A mid-battle candidate-RANGE row's chip (sinks made the alive subset
 *  unknowable — the range is contiguous in the Tab key order): every
 *  candidate's headline number side by side, joined by slashes — the first
 *  chip toggle that carries a value (winrate → damage → PR → battles).
 *  Seals are dropped ON PURPOSE — the row is a SET of players, so
 *  per-member seals would misattribute, and the chip must stay compact
 *  enough for a wide range to fit the reserved side pad. A member whose
 *  stats have not landed reads "…", a hidden one the red dot — the same
 *  per-member faces chipContent renders. The AI members fold into a
 *  counted suffix (candidates.ts): the game's own table already marks
 *  those rows, so a verbatim "bot / bot / bot" only stretched the chip
 *  over the left HUD — "43.2% + 2 bot" keeps the range's cardinality at a
 *  fraction of the width, and a pure-bot range collapses to the single
 *  muted face. */
function candidatesChip(members: string[]): string {
  if (!ANY_CHIP_ON) return "";
  const { humans, botCount } = collapseCandidateBots(members);
  if (humans.length === 0) return `<span class="muted">bot</span>`;
  const face = (m: string): string => {
    const st = stats.get(cacheKey(m));
    if (!st) return `<span class="muted">…</span>`;
    if (st.hidden) return `<span class="hidden">●</span>`;
    const v = rosterStatView(st, statsMode);
    if (PREFS.chips.winrate && v.winrate != null) {
      return `<b style="color:${winrateColor(v.winrate)}">${v.winrate.toFixed(1)}%</b>`;
    }
    if (PREFS.chips.damage && v.avgDamage != null) {
      return `<b style="color:${damageColor(v.avgDamage)}">${fmtDamage(v.avgDamage)}</b>`;
    }
    if (PREFS.chips.pr && PREFS.prOn && v.pr != null) {
      return `<b style="color:${prTier(v.pr).color}">${Math.round(v.pr)}</b>`;
    }
    if (PREFS.chips.battles && v.battles != null) {
      const color = battlesColor(v.battles);
      return `<b${color ? ` style="color:${color}"` : ""}>${fmtBattles(v.battles)}</b>`;
    }
    return `<span class="muted">—</span>`;
  };
  const faces = humans.map(face).join(`<span class="sep">/</span>`);
  if (botCount > 0) {
    return `${faces}<span class="sep">+</span><span class="muted">${botCount} bot</span>`;
  }
  return faces;
}

/** One side's summary card, directly below that side's column. Line 1
 *  carries the side label, the radar estimate (when its item toggle is on)
 *  and the LONGEST radar range (the distance a player must respect); line
 *  2 stacks hydro and smoke (each behind its own toggle); line 3 carries
 *  the optional team averages (mean winrate — tier-weighted per the stats
 *  prefs, the same aggregate the live panel's column titles use — mean PR
 *  and mean avg damage). Item toggles can switch any line's contents off;
 *  when neither the intel items nor the averages survive, the card itself
 *  is gone (null) — the side label rides whichever line renders first.
 *  Styled and anchored as a chip of the same side, so chipFit's clamp pass
 *  covers this card exactly like the row chips; `topCss` is the desired
 *  CSS-px TOP edge — `.overlay-chip--intel` opts out of the base chip's
 *  centering transform, so a tall card grows downward from it instead of
 *  straddling the anchor. */
function teamSummaryCard(
  side: "ally" | "enemy",
  vehicles: Vehicle[],
  topCss: number,
  fontSize: number,
): HTMLDivElement | null {
  const sideLabel = `<span class="overlay-intel-team">${localized(
    side === "ally" ? "intelAlly" : "intelEnemy",
  )}</span>`;
  const lines: string[] = [];
  const intel = teamIntelFor(vehicles.map((v) => v.shipId));
  const intelItem = (label: string, c: TeamIntelCount) =>
    `<span class="overlay-intel-k">${label}</span><b>${formatIntelCount(c)}</b>`;
  if (PREFS.teamIntel && (PREFS.intel.radar || PREFS.intel.hydro || PREFS.intel.smoke)) {
    const range =
      PREFS.intel.radar && intel.radarMaxM != null && intel.radarMaxM > 0
        ? `<span class="overlay-intel-range">${localized("intelRange")} ${formatIntelKm(intel.radarMaxM)}km</span>`
        : "";
    const line1 =
      `<span class="overlay-intel-line">${sideLabel}` +
      (PREFS.intel.radar ? intelItem(localized("intelRadar"), intel.radar) + range : "") +
      `</span>`;
    lines.push(line1);
    const line2Items = [
      PREFS.intel.hydro ? intelItem(localized("intelHydro"), intel.hydro) : "",
      PREFS.intel.smoke ? intelItem(localized("intelSmoke"), intel.smoke) : "",
    ].filter(Boolean);
    if (line2Items.length > 0) {
      lines.push(
        `<span class="overlay-intel-line">${line2Items.join(`<span class="sep">·</span>`)}</span>`,
      );
    }
  }
  const agg =
    PREFS.teamAvg.winrate || PREFS.teamAvg.pr || PREFS.teamAvg.damage
      ? aggregateTeamStats(
          vehicles
            .filter((v) => !AI_NAME.test(v.name))
            .map((v) => {
              const st = stats.get(cacheKey(v.name));
              const v2 = st && !st.hidden ? rosterStatView(st, statsMode) : null;
              return {
                winrate: v2?.winrate ?? null,
                pr: v2?.pr ?? null,
                damage: v2?.avgDamage ?? null,
                tier: shipTierOf(v.shipId),
              };
            }),
          PREFS.weightedTeamWr,
        )
      : null;
  if (agg != null) {
    const avgItem = (label: string, value: string) =>
      `<span class="overlay-intel-k">${label}</span><b>${value}</b>`;
    const items = [
      PREFS.teamAvg.winrate
        ? avgItem(
            localized("avgWinrate"),
            agg.winrate != null ? `${agg.winrate.toFixed(1)}%` : "—",
          )
        : "",
      PREFS.teamAvg.pr && PREFS.prOn
        ? avgItem(localized("avgPr"), agg.avgPr != null ? `${Math.round(agg.avgPr)}` : "—")
        : "",
      PREFS.teamAvg.damage
        ? avgItem(localized("avgDmg"), agg.avgDamage != null ? fmtDamage(agg.avgDamage) : "—")
        : "",
    ].filter(Boolean);
    if (items.length > 0) {
      const label = lines.length === 0 ? sideLabel : "";
      lines.push(
        `<span class="overlay-intel-line overlay-intel-line--avg">${label}${items.join(
          `<span class="sep">·</span>`,
        )}</span>`,
      );
    }
  }
  if (lines.length === 0) return null;
  const el = document.createElement("div");
  el.className = `overlay-chip overlay-chip--${side} overlay-chip--intel`;
  el.innerHTML = lines.join("");
  el.style.top = `${topCss}px`;
  el.style.fontSize = `${fontSize.toFixed(1)}px`;
  return el;
}

/** The ONE transient-status presentation: a spinner + a single line of
 *  copy, centered over the table. Every "something is settling" notice —
 *  locating, querying — renders as this
 *  card. DOM twin of hikari's centered HkSpinner (same circle geometry,
 *  rotation and stacking), which this bare page cannot import. */
function statusCard(text: string): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "overlay-status";
  const spinner = document.createElement("div");
  spinner.className = "overlay-spinner";
  const label = document.createElement("span");
  label.className = "overlay-status-text";
  label.textContent = text;
  card.append(spinner, label);
  return card;
}

/** The roster's believed full-key order for one side — the same ordering
 *  inferredRowMapping applies (see utils/shipClass for the decompiled
 *  rule). Operation scenarios map the whole roster as the ally block. */
function sideFullOrder(side: SunkSide): string[] {
  if (!arena) return [];
  const operation = isOperationBattle(
    arena.matchGroup,
    arena.scenario,
    arena.eventType,
    arena.vehicles.map((v) => v.name),
  );
  // Operations (行动) map the WHOLE roster as the ally block — their
  // relation values follow scenario team slots, not enemy semantics.
  const list = operation
    ? side === "enemy"
      ? []
      : arena.vehicles
    : arena.vehicles.filter((v) => (side === "enemy" ? v.relation > 1 : v.relation <= 1));
  return list
    .map((v, i) => ({
      v,
      i,
      key: gameTabRowKey(v, true, locale, (n) => stats.get(cacheKey(n))?.clanTag ?? null),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i))
    .map(({ v }) => v.name);
}

/** The side's believed CURRENT alive order (full order minus the trusted
 *  sunk set) — what sink-attrib row indices resolve against. While the
 *  side is exact this is the game's alive block, verbatim. */
function sideAliveOrder(side: SunkSide): string[] {
  const sunkSet = sunk.sunkNames(side);
  const full = sideFullOrder(side);
  return sunkSet ? full.filter((n) => !sunkSet.has(n)) : full;
}

/** Rebuild every chip from the current roster + anchor. */
function render() {
  const root = document.body;
  root.textContent = "";
  if (!anchor) return;
  // Battle is on but the table itself wasn't located — show the centered
  // status card instead of chips that would sit on guessed rows. Two copy
  // levels: `fallback` is the one state that means a detection was TRIED
  // and failed — the failure-tone copy; still-searching (or no status
  // event yet) gets the softer "hold Tab, locating the roster" copy.
  if (!anchor.tableDetected) {
    root.appendChild(
      statusCard(localized(statusState === "fallback" ? "locateHint" : "locatingHint")),
    );
    return;
  }
  if (!arena) return;
  // Which battle-mode stats this battle renders ("auto" resolves per
  // battle — ranked battles show the ranked career, everything else the
  // randoms career; the fixed modes pin it).
  statsMode = resolveRosterStatsMode(PREFS.statsMode, arena);
  const dpr = window.devicePixelRatio || 1;
  const rows = anchor.rowCenters;
  if (rows.length === 0) return;

  // The anchor carries TWO grid blocks concatenated: allies first, then
  // enemies (asymmetrical battles 12v6 render sub-tables of different
  // heights). Each side maps onto its OWN block — the enemy block starts
  // where the ally block ends. Operation scenarios (行动) are the
  // exception: their relation values follow scenario team slots, and the
  // game's Tab table shows a single team — the whole roster is the one
  // ally block (matching the Rust-side team sizes).
  const operation = isOperationBattle(
    arena.matchGroup,
    arena.scenario,
    arena.eventType,
    arena.vehicles.map((v) => v.name),
  );
  const allies = operation
    ? arena.vehicles
    : arena.vehicles.filter((v) => v.relation <= 1);
  const enemies = operation
    ? []
    : arena.vehicles.filter((v) => v.relation > 1);
  const allyBlock = rows.slice(0, allies.length);
  const enemyBlock = rows.slice(allies.length);
  // Row → name attribution. Both modes name rows: this page derives the
  // mapping itself from the arena roster + the anchor's alive vector via
  // the client's own Tab sort key (inferredRowMapping). A missing/older
  // backend field keeps the legacy index mapping.
  let players: (string | string[] | null)[] | null = null;
  let aliveArr: boolean[] | null = null;
  if (anchor.rosterMode) {
    aliveArr = anchor.rowAlive ?? null;
    // The mapping replicates the client's own Tab sort key (decompiled —
    // see inferredOrder.ts), so battle-start rows arrive as EXACT names.
    // Mid-battle, the sink tracker holds the TRUSTED sunk sets (fed by the
    // sink-attrib events) — a side whose set agrees with the anchor's
    // alive count renders the exact [alive] ++ [sunk] layout, every row
    // named; a degraded side (a sink the strip solver could not explain)
    // falls back to provable CANDIDATE RANGES. Clan tags feed the key's
    // display-name segment, and the mapping re-derives on every render —
    // when the WG batch lands a tag, the next render re-sorts with it.
    // Operation scenarios map the whole roster as a single allies block.
    const allyN = operation
      ? arena.vehicles.length
      : arena.vehicles.filter((v) => v.relation <= 1).length;
    const enemyN = operation ? 0 : arena.vehicles.length - allyN;
    const reconcileSide = (rel: "ally" | "enemy", n: number, off: number) => {
      // Plugin telemetry outranks the capture alive vector: its sets are
      // updated off-Tab, so reconciling them against a STALE vector would
      // wrongly degrade the side on every sink between Tab holds.
      if (telemetryAuthoritative) return;
      const slice = aliveArr == null ? null : aliveArr.slice(off, off + n);
      const aliveCount = slice == null ? n : slice.lastIndexOf(true) + 1;
      sunk.reconcile(rel, n - aliveCount);
    };
    reconcileSide("ally", allyN, 0);
    if (!operation) reconcileSide("enemy", enemyN, allyN);
    if (telemetryAuthoritative && pluginSunkNames) {
      // Plugin-authoritative layout: split by set membership
      // unconditionally — no alive-vector agreement check, no candidate
      // ranges, stamps by membership. A sink the row detector missed
      // leaves that row chipless in the positional zip below instead of
      // misattributing a player onto it.
      players = pluginRowMapping(arena.vehicles, {
        ally: sunk.sunkNames("ally"),
        enemy: sunk.sunkNames("enemy"),
      }, {
        locale,
        clanTagOf: (name) => stats.get(cacheKey(name))?.clanTag ?? null,
        operation,
      });
    } else {
      players = inferredRowMapping(arena.vehicles, aliveArr, {
        locale,
        clanTagOf: (name) => stats.get(cacheKey(name))?.clanTag ?? null,
        operation,
        sunk: { ally: sunk.sunkNames("ally"), enemy: sunk.sunkNames("enemy") },
      });
    }
  }

  const pitch = allyBlock.length >= 2 ? Math.abs(allyBlock[1] - allyBlock[0]) / dpr : 24;
  const fontSize = Math.min(15, Math.max(9, pitch * 0.42));
  // Chips sit OUTSIDE the table — inside they cover the ship names (live
  // report). Ally chips grow LEFT from the table's left edge; enemy chips
  // grow RIGHT from the right edge. The window reserves a side pad for this
  // (overlay_padding_x on the Rust side).
  const gap = Math.max(4, Math.round(pitch * 0.1));
  const tableLeft = anchor.rosterRect.x / dpr;
  const tableRight = (anchor.rosterRect.x + anchor.rosterRect.width) / dpr;
  const overlayW = anchor.overlayRect.width / dpr;

  const sides: Array<[Vehicle[], "ally" | "enemy", number[], number]> = [
    [allies, "ally", allyBlock, 0],
    [enemies, "enemy", enemyBlock, allies.length],
  ];
  // At least one chip below renders from a known name whose stats have not
  // landed yet — the face the "querying" badge (bottom of this function)
  // is about. Tracked while the chips are built so it cannot drift from
  // what is actually on screen.
  let chipsMissingStats = false;
  for (const [list, side, block, blockOffset] of sides) {
    list.forEach((v, i) => {
      if (block[i] == null) return;
      let html: string;
      let sunk = false;
      let multi = false;
      let mappedName: string | null = null;
      if (players) {
        const mapped = players[blockOffset + i] ?? null;
        if (typeof mapped === "string") {
          // Recognized name — exactly a roster nickname, so the stats
          // cache lookup works unchanged.
          mappedName = mapped;
          html = chipContent(mapped, side);
          // Authoritative plugin sets stamp by MEMBERSHIP: the capture
          // alive vector lags/misreads during sinking animations, and
          // reading it here is what made rows flip sunk↔alive.
          sunk = telemetryAuthoritative && pluginSunkNames
            ? pluginSunkNames.has(mapped)
            : aliveArr?.[blockOffset + i] === false;
        } else if (Array.isArray(mapped)) {
          // A mid-battle candidate RANGE (sinks made the alive subset
          // unknowable — contiguous in the Tab key order): the chip lists
          // every candidate's winrate instead of picking one. No seals
          // here: a career stamp is a per-player verdict, and stamping an
          // ambiguous row would misattribute it.
          html = candidatesChip(mapped);
          multi = true;
          sunk = aliveArr?.[blockOffset + i] === false;
          if (ANY_CHIP_ON && mapped.some((m) => !AI_NAME.test(m) && !stats.has(cacheKey(m)))) {
            chipsMissingStats = true;
          }
        } else {
          // This row's player was not recognized: stay silent rather
          // than pinning stats by index guess.
          html = ANY_CHIP_ON || SEALS_SHOWN ? `<span class="muted">…</span>` : "";
        }
      } else {
        // No recognition payload — legacy index mapping.
        mappedName = v.name;
        html = chipContent(v.name, side);
      }
      // The badge speaks about RENDERED content: with both the numbers and
      // the seals switched off nothing on this row can ever appear, so a
      // missing stat must not spin the "querying" card all battle.
      if (
        (ANY_CHIP_ON || SEALS_SHOWN) &&
        mappedName != null &&
        !AI_NAME.test(mappedName) &&
        !stats.has(cacheKey(mappedName))
      ) {
        chipsMissingStats = true;
      }
      // Nothing to show for this row (avg stats off and no seal landed —
      // or a candidate range with numbers off): the badge bookkeeping
      // above still ran, but an empty chip must not take layout space.
      if (html === "") return;
      const el = document.createElement("div");
      el.innerHTML = html;
      el.className =
        `overlay-chip overlay-chip--${side}` +
        (multi ? " overlay-chip--multi" : "") +
        (sunk ? " overlay-chip--sunk" : "");
      el.style.top = `${block[i] / dpr}px`;
      el.style.fontSize = `${fontSize.toFixed(1)}px`;
      if (side === "ally") {
        // Right edge of the chip just left of the table's left edge.
        el.style.right = `${Math.max(0, overlayW - tableLeft + gap)}px`;
      } else {
        // Left edge of the chip just right of the table's right edge.
        el.style.left = `${tableRight + gap}px`;
      }
      root.appendChild(el);
    });
  }

  // Two-sided summary cards — each side's consumable intel (radar/hydro/
  // smoke estimates plus its longest radar range) and/or team averages
  // (mean winrate / PR / avg damage), one card directly BELOW its own
  // column (ally card under the allies, enemy card under the enemies) in
  // the empty band the game leaves under the table, aligned to the
  // column's outer edge and growing inward. The card is TOP-anchored a
  // full row pitch under the last row's center: that clears the table's
  // bottom frame whatever the card's line count (center-anchoring let a
  // three-line card ride back up onto the frame). Match-start capability
  // BY DESIGN: the intel numbers do not decrement as ships sink — the
  // mid-battle row→ship attribution is inferred, and silently
  // miscounting radars would be worse than a static "what each team
  // brought" summary. Every item (and both halves wholesale) is
  // switchable in settings; a side whose card renders nothing is simply
  // absent. Operations (行动) render no enemy list — the ally card alone.
  {
    const intelFontSize = Math.min(13, Math.max(9, pitch * 0.4));
    // The window's top/bottom edges can crowd the table in odd aspect
    // ratios — keep each card fully inside, measured post-append (the
    // horizontal fit pass below covers both cards already). The card is
    // top-anchored (no centering transform), so style.top IS the box's
    // top edge.
    const clampVertically = (el: HTMLDivElement): void => {
      const box = el.getBoundingClientRect();
      if (box.top < 0) el.style.top = "2px";
      if (box.bottom > document.documentElement.clientHeight) {
        el.style.top = `${Math.max(
          2,
          document.documentElement.clientHeight - box.height - 2,
        )}px`;
      }
    };
    if (allyBlock.length > 0 && allies.length > 0) {
      const el = teamSummaryCard(
        "ally",
        allies,
        // Top edge one full row pitch below the last row's center —
        // clears the table's bottom frame at any line count.
        allyBlock[allyBlock.length - 1] / dpr + pitch,
        intelFontSize,
      );
      if (el) {
        el.style.left = `${tableLeft + gap}px`;
        root.appendChild(el);
        clampVertically(el);
      }
    }
    if (!operation && enemies.length > 0 && enemyBlock.length > 0) {
      const el = teamSummaryCard(
        "enemy",
        enemies,
        // Same top-edge anchor as the ally card.
        enemyBlock[enemyBlock.length - 1] / dpr + pitch,
        intelFontSize,
      );
      if (el) {
        el.style.right = `${Math.max(0, overlayW - tableRight + gap)}px`;
        root.appendChild(el);
        clampVertically(el);
      }
    }
  }
  // A chip wider than its side pad would run past the window edge and get
  // clipped flat (rounded cap gone, numbers cut) — pull overflowing chips
  // back inside: seals trim first, the free edge clamps last (chipFit.ts).
  fitChips(root, document.documentElement.clientWidth);
  // Seal bitmaps decode (or fail) after this layout — re-run the fit pass
  // as each settles so the clamp stays honest on the first seal-bearing
  // render.
  refitWhenSealsSettle(root, () => document.documentElement.clientWidth);

  // Transient-status card, centered over the table, rebuilt on every
  // render: one spinner + the "querying" copy while at least one chip
  // renders from a known name whose stats are still in flight. The chips
  // live OUTSIDE the left/right edges, so the card only ever crosses the
  // table's own columns, and it disappears with its trigger on the next
  // event (render() rebuilds from scratch each time). An undetected realm
  // disables the lookups entirely, which leaves the query pipeline
  // inactive — no card for it, by design.
  const statusText =
    chipsMissingStats && (pending.size > 0 || inFlight || retryTimer != null)
      ? localized("queryingBadge")
      : null;
  if (statusText != null) {
    root.appendChild(statusCard(statusText));
  }
}

/** Backoff state for a FAILED batch. The backend fails the WHOLE batch on
 *  any error (WG rate limit, transient network — one flaky name in a CN
 *  vortex batch is enough) and tempArenaInfo.json never changes mid-battle
 *  — no arena-info event will ever re-queue the names. Without this retry
 *  the affected chips stay "…" for the entire battle even after the API
 *  recovers (the main window's roster pipeline has its own retry; this is
 *  the same contract for the overlay page). The ceiling stays low on
 *  purpose: a batch that keeps failing must keep re-filling within a
 *  Tab-hold or two, not a half-minute out.
 *
 *  The timer-driven retries are also BUDGETED per battle (`retriesLeft`,
 *  the main window's `retriesLeft` contract): a hard-down or rate-limited
 *  API must not be probed all battle long — an unbounded loop here kept the
 *  "querying" status card spinning forever. When the budget runs out the
 *  chips stay honestly "…" and the card goes away; a fresh anchor event
 *  (the user holding Tab again) still gets one prompt attempt through
 *  scheduleBatch, only the timed loop stops. */
let inFlight = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = 2000;
const RETRY_DELAY_MAX_MS = 10000;
const RETRIES_PER_BATTLE = 2;
let retriesLeft = RETRIES_PER_BATTLE;

// A "not found" answer (null result, cached as the "—" no-data stat) is not
// always final: WG/vortex lookups occasionally answer empty for a name the
// same API resolves moments later, and the main window's panel would then
// show stats the overlay chip never picks up. Cache the null answer (chips
// stay honest immediately) but re-queue the name while a small per-battle
// budget lasts — bounded, so a genuinely absent account stops being probed
// after the retries run out. The budget counts EVERY attempt (the initial
// lookup included), so this is "up to 1 initial + 2 re-queues per battle".
const NOT_FOUND_ATTEMPTS_MAX = 3;
const NOT_FOUND_RETRY_DELAY_MS = 20000;
const notFoundLeft = new Map<string, number>();
const notFoundRetry = new Set<string>();
let notFoundTimer: ReturnType<typeof setTimeout> | null = null;

/** Spend one attempt from a name's per-battle budget. Every LOOKUP against
 *  a suspected-absent name costs one — a null answer and a thrown batch
 *  alike — so a hard-down API cannot keep the re-queue alive indefinitely
 *  (a throwing batch consumes its budget without producing an answer). */
function spendNotFoundRetry(name: string) {
  const left = (notFoundLeft.get(name) ?? NOT_FOUND_ATTEMPTS_MAX) - 1;
  if (left > 0) {
    notFoundLeft.set(name, left);
    notFoundRetry.add(name);
  } else {
    notFoundLeft.delete(name);
    notFoundRetry.delete(name);
  }
}

/** Arm the delayed re-queue of "not found" names (one timer regardless of
 *  batch size). The set keeps its names until they resolve or run out of
 *  budget; on fire, only names still on the current roster re-join the
 *  pending set — a battle switch clears the bookkeeping instead. */
function scheduleNotFoundRetry() {
  if (!arena || !tauri || !realm || notFoundRetry.size === 0 || notFoundTimer) return;
  notFoundTimer = setTimeout(() => {
    notFoundTimer = null;
    if (!arena) return;
    for (const name of notFoundRetry) {
      if (arena.vehicles.some((v) => v.name === name)) pending.add(name);
    }
    if (pending.size > 0 && !batchTimer && !inFlight && !retryTimer) {
      batchTimer = setTimeout(runBatch, 250);
    }
  }, NOT_FOUND_RETRY_DELAY_MS);
}

function scheduleBatch() {
  if (!arena || !tauri) return;
  // Names whose stats already landed may still owe a composition verdict or
  // a hidden-profile clan gate — give both pipelines their trigger here,
  // before the stats-specific guards below (they are about the STATS
  // cadence, not the seals').
  scheduleCompBatch();
  scheduleClanGates();
  // No detected realm → no lookups; chips stay muted ("…") rather than
  // showing numbers fetched from a guessed realm.
  if (!realm) return;
  // A failed batch owns the retry cadence (backoff below) — a fresh event
  // (new anchor, new roster read) must not bypass it and hammer the API.
  if (retryTimer) return;
  for (const v of arena.vehicles) {
    if (AI_NAME.test(v.name)) continue;
    if (!stats.has(cacheKey(v.name))) pending.add(v.name);
  }
  if (pending.size === 0 || batchTimer || inFlight) return;
  batchTimer = setTimeout(runBatch, 250);
}

async function runBatch() {
  batchTimer = null;
  if (!tauri || !arena || pending.size === 0 || inFlight) return;
  const names = [...pending];
  pending.clear();
  inFlight = true;
  try {
    // pr_algo rides along while the PR rating is on — the same param the
    // main window injects (prAlgoForRequest), so chip PRs never disagree
    // with the app's cards under the expected algorithm.
    const results = (await tauri.core.invoke("lookup_players_stats_batch", {
      names,
      realm,
      ...(PREFS.prAlgo != null ? { pr_algo: PREFS.prAlgo } : {}),
    })) as Array<BatchStat | null>;
    names.forEach((name, i) => {
      const r = results[i];
      if (r) {
        stats.set(cacheKey(name), {
          winrate: r.winrate ?? null,
          avgDamage: r.avgDamage ?? null,
          pr: r.pr ?? null,
          battles: r.battles ?? null,
          ranked:
            r.rankedBattles != null || r.rankedWinrate != null
              ? {
                  winrate: r.rankedWinrate ?? null,
                  pr: r.rankedPr ?? null,
                  battles: r.rankedBattles ?? null,
                  avgDamage: r.rankedAvgDamage ?? null,
                }
              : null,
          global:
            r.globalBattles != null || r.globalWinrate != null
              ? {
                  winrate: r.globalWinrate ?? null,
                  pr: r.globalPr ?? null,
                  battles: r.globalBattles ?? null,
                  avgDamage: r.globalAvgDamage ?? null,
                }
              : null,
          clanId: r.clanId ?? null,
          clanTag: r.clanTag ?? null,
          hidden: r.hidden,
        });
        notFoundLeft.delete(name);
        notFoundRetry.delete(name);
      } else {
        stats.set(cacheKey(name), {
          winrate: null,
          avgDamage: null,
          pr: null,
          battles: null,
          ranked: null,
          global: null,
          clanId: null,
          clanTag: null,
          hidden: false,
        });
        // Cache the "—" now, but keep a bounded re-queue armed: an empty
        // answer is sometimes a hiccup, not a verdict (see the retry
        // bookkeeping above).
        spendNotFoundRetry(name);
      }
    });
    // Success: restore the initial cadence for any future failure.
    retryDelayMs = 2000;
    scheduleNotFoundRetry();
    // Freshly landed stats unlock the composition-seal lookups for those
    // names (seals only queue names that already have their stats) and the
    // hidden-profile clan gates alike.
    scheduleCompBatch();
    scheduleClanGates();
    render();
  } catch {
    // Transient WG hiccup: retry the same (still-uncached) names after a
    // capped, doubling pause — but only while the per-battle retry budget
    // lasts (see RETRIES_PER_BATTLE). The chips honestly stay "…" until a
    // retry lands — never a silently wrong "no data".
    if (retriesLeft > 0) {
      retriesLeft -= 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        scheduleBatch();
      }, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, RETRY_DELAY_MAX_MS);
    }
    // A thrown batch is still an ATTEMPT against the suspected-absent names
    // riding in it: spend their budget and re-arm, so their re-queue stays
    // bounded even while the API is hard-down (the backoff above never
    // re-queues them — their null answers are cached).
    for (const name of names) {
      if (notFoundRetry.has(name)) spendNotFoundRetry(name);
    }
    scheduleNotFoundRetry();
  } finally {
    inFlight = false;
  }
}

/** Queue one composition-seal batch: every roster name whose career stats
 *  already landed but whose verdict is not cached yet. Seals off (or an
 *  empty realm) never queue, so the whole pipeline stays dormant. */
function scheduleCompBatch() {
  if (!arena || !tauri || !SEALS_SHOWN || !realm) return;
  // A failed seal batch owns its retry cadence (backoff below) — fresh
  // events must not bypass it and hammer the API, same contract as stats.
  if (compRetryTimer) return;
  for (const v of arena.vehicles) {
    if (AI_NAME.test(v.name)) continue;
    // Only names the stats batch already answered — the seal lookup rides
    // behind it instead of racing a name still in flight there.
    if (stats.has(cacheKey(v.name)) && !compositions.has(cacheKey(v.name))) {
      compPending.add(v.name);
    }
  }
  if (compPending.size === 0 || compBatchTimer || compInFlight) return;
  compBatchTimer = setTimeout(runCompBatch, 250);
}

async function runCompBatch() {
  compBatchTimer = null;
  if (!tauri || compPending.size === 0 || compInFlight) return;
  const names = [...compPending];
  compPending.clear();
  compInFlight = true;
  try {
    // One entry per input name, in order. null = hidden / no data / that
    // player's per-name lookup failed (the backend degrades per-name
    // failures instead of failing the batch). Cached as-is: null is
    // indistinguishable from "no stamp" here and a seal is decoration.
    const results = (await tauri.core.invoke("lookup_players_composition", {
      names,
      realm,
    })) as Array<PlayerComposition | null>;
    names.forEach((name, i) => compositions.set(cacheKey(name), results[i] ?? null));
    // Success: restore the initial cadence for any future failure.
    compRetryDelayMs = 2000;
    render();
  } catch {
    // WHOLE-batch failure (WG hiccup): the same capped doubling backoff as
    // the stats batch, on its own timer. Nothing was cached on failure, so
    // the retry's scheduleCompBatch() re-queues the same names.
    compRetryTimer = setTimeout(() => {
      compRetryTimer = null;
      scheduleCompBatch();
    }, compRetryDelayMs);
    compRetryDelayMs = Math.min(compRetryDelayMs * 2, RETRY_DELAY_MAX_MS);
  } finally {
    compInFlight = false;
  }
}

async function start() {
  if (!tauri) return;
  const { core, event } = tauri;
  const invoke = core.invoke;
  const listen = event.listen;

  // Attach ALL listeners before any awaited call — the window may be shown
  // within milliseconds of creation, and an event missed during the await
  // gap would leave the page stuck hidden. The custom-seal read below is
  // therefore fire-and-forget: chips read CUSTOM_STAMPS at render time and
  // the trailing render() picks late-loaded pictures up.
  await listen("wowsp://overlay-visibility", (e: { payload: unknown }) => {
    // The load-bearing hide: the Rust watcher flips the page itself, so
    // content vanishes even when the native window hide is delayed.
    document.documentElement.classList.toggle("overlay-hidden", e.payload !== true);
  });
  await listen("wowsp://arena-info", (e: { payload: unknown }) => {
    const next = e.payload as ArenaInfo;
    // A different battle's roster: drop the remembered row mapping (its
    // row order belongs to the old battle) and reset the retry cadence —
    // the new battle's lookups start fresh.
    if (next?.dateTime !== arena?.dateTime) {
      sunk.reset(next?.dateTime ?? null);
      retryDelayMs = 2000;
      retriesLeft = RETRIES_PER_BATTLE;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      // The "not found" re-queue belongs to the old battle's answer set —
      // drop it with the rest of the cadence state.
      notFoundLeft.clear();
      notFoundRetry.clear();
      if (notFoundTimer) {
        clearTimeout(notFoundTimer);
        notFoundTimer = null;
      }
      // The seal pipeline resets its cadence the same way (its cache
      // persists — career composition does not change battle to battle).
      compRetryDelayMs = 2000;
      if (compRetryTimer) {
        clearTimeout(compRetryTimer);
        compRetryTimer = null;
      }
    }
    arena = next;
    scheduleBatch();
  });
  await listen("wowsp://overlay-status", (e: { payload: unknown }) => {
    // Detection-state broadcast (the same event the live-battle panel
    // badges). Only steers the hint copy; a re-render keeps a hint box
    // already on screen current without waiting for the next anchor event.
    statusState = (e.payload as { state?: string } | null)?.state ?? null;
    render();
  });
  await listen("wowsp://sink-attrib", (e: { payload: unknown }) => {
    // One sink transition, solved Rust-side: row indices into each side's
    // PRE-sink alive order. Resolve them against this page's believed
    // layout (the sort-key order minus the current sunk set). NO render
    // here: the anchor of the same Rust pass follows this event and
    // renders with counts that MATCH the grown set — an interim render
    // would reconcile the new set against the PRE-sink alive vector and
    // degrade the side for the whole battle.
    const attrib = e.payload as { allyRows?: number[]; enemyRows?: number[] };
    sunk.applyAttribution(
      { ally: attrib?.allyRows ?? [], enemy: attrib?.enemyRows ?? [] },
      (side) => sideAliveOrder(side),
    );
  });
  await listen("wowsp://ingame-telemetry", (e: { payload: unknown }) => {
    // The in-game plugin's alive broadcast — the priority-chain top when
    // the anchor's roster mode is "plugin": isAlive observed inside the
    // client REPLACES the luma solver's sets (applyNamedSunk). No poller
    // file → no events → the inference chain stays untouched. A render
    // follows so visible chips re-grade immediately; the next anchor
    // carries the matching alive vector.
    const payload = e.payload as { t?: number; players?: Record<string, boolean> } | null;
    if (!payload?.players || !arena) return;
    if (Date.now() - (payload.t ?? 0) > 30_000) return;
    if ((anchor?.rosterMode ?? "") !== "plugin") {
      telemetryAuthoritative = false;
      return;
    }
    if (Date.now() - (payload.t ?? 0) > 30_000) {
      // Stale stream: release the authoritative lock (resume inference).
      telemetryAuthoritative = false;
      pluginSunkNames = null;
      return;
    }
    const operation = isOperationBattle(
      arena.matchGroup,
      arena.scenario,
      arena.eventType,
      arena.vehicles.map((v) => v.name),
    );
    const bySide: { ally?: Set<string>; enemy?: Set<string> } = {
      ally: new Set(),
      enemy: new Set(),
    };
    const rosterNames = new Set<string>();
    for (const v of arena.vehicles) {
      rosterNames.add(v.name);
      if (payload.players[v.name] !== false) continue;
      if (operation || v.relation <= 1) bySide.ally!.add(v.name);
      else bySide.enemy!.add(v.name);
    }
    telemetryAuthoritative = true;
    sunk.applyNamedSunk(bySide, rosterNames);
    pluginSunkNames = new Set([...bySide.ally!, ...bySide.enemy!]);
    render();
  });
  await listen("wowsp://overlay-anchor", async (e: { payload: unknown }) => {
    anchor = e.payload as OverlayAnchor;
    // An anchor always precedes a show — reveal even if the visibility
    // event raced the listener registration above.
    document.documentElement.classList.remove("overlay-hidden");
    if (!arena) {
      try {
        const info = await invoke("read_temp_arena_info", { dir: null });
        if (info) arena = info as ArenaInfo;
      } catch {
        // nothing to read — chips stay "…" until an arena event arrives
      }
    }
    // The user is LOOKING at the table right now — give any chip still on
    // "…" a prompt fill round. The call is cheap when everything is cached
    // and stays behind the failed-batch backoff when one is running (no API
    // hammering); it exists for the window-lifecycle gaps where the roster
    // landed without a stats batch ever being scheduled.
    scheduleBatch();
    render();
  });

  // One-shot read + live watcher for the roster (same commands the Vue
  // store used; the static page just drives them directly).
  try {
    const info = await invoke("read_temp_arena_info", { dir: null });
    if (info) {
      arena = info as ArenaInfo;
      scheduleBatch();
    }
  } catch {
    // no replay dir resolved — the watcher event may still deliver
  }
  try {
    await invoke("start_arena_watcher", { dir: null });
  } catch {
    // already running
  }

  // Custom seal pictures: one fire-and-forget read (see the listener note
  // above); a later import in the settings window only matters next battle,
  // and a failure here costs nothing (the bundled glyphs show).
  void loadCustomStamps(invoke).then(() => render());

  // Consumable-kit hot update: the main window's boot refresh warms the
  // shell's cache; this window (created per battle) overlays it onto the
  // baked asset. Cache read only — no network here, and a miss (older
  // shell, nothing downloaded yet) keeps the bundled numbers.
  void (async () => {
    try {
      const cached = (await invoke("get_ship_kit", {})) as string | null;
      if (typeof cached === "string" && setRuntimeKit(cached)) render();
    } catch {
      // shell without the command — bundled kit stays
    }
  })();
}

// Re-render when the webview's own devicePixelRatio changes. The overlay
// window is placed in PHYSICAL px on the game's monitor, and chips convert
// anchor coordinates with `devicePixelRatio`; when the window moves between
// monitors of different scale factors (mixed-DPI setups — or the game
// dragging the overlay along), WebView2 updates its ratio ASYNCHRONOUSLY,
// and chips positioned with the stale ratio sit off the rows until the next
// anchor event. A fixed-resolution media query flips exactly when the ratio
// moves; the listener detaches before re-arming so dpr ping-pong cannot
// accumulate stale queries.
function armDprWatch() {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  const onChange = () => {
    mq.removeEventListener("change", onChange);
    render();
    armDprWatch();
  };
  mq.addEventListener("change", onChange);
}
armDprWatch();

// Start hidden: the native window is created invisible, but a dev reload or
// a late event could otherwise leave stale content painted over the game.
document.documentElement.classList.add("overlay-hidden");
void start();
