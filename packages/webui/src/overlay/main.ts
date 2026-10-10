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
  resolveStamps,
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
// Display prefs (content toggles + the three-dimension stats source), read
// with the same tolerant contract as the store and re-read live when the
// main window broadcasts a prefs write (see refreshPrefs below).
import {
  dimsNeedShipStats,
  readOverlayDisplayPrefs,
  resolveRosterBattleScope,
  scopedRosterView,
  type PrAlgo,
  type RawStat,
  type RosterModeNumbers,
  type ResolvedStatsMode,
} from "./overlayPrefs";
import { SunkTracker, type SunkSide } from "@/utils/sunkTracker";
import { isKnownRealm, realmUsesShipNameOrder } from "@/utils/realms";
import { pluginRowMapping } from "./inferredOrder";
import {
  gameTabRowCompare,
  shipTierOf,
  tabDisplayName,
  type TabRowCompareOptions,
} from "@/utils/shipClass";
import { isCoopBattle, isOperationBattle } from "@/utils/modeColors";
// The live side split — scripted scenario NPCs filtered iff this is a real
// operation (行动), exactly the rows the game's own Tab table renders. The
// Rust sink solver keys its ally block on the same rule (arena_info's
// note_arena_seen), so the chip blocks, the row mapping and the solver's
// indices stay aligned.
import { splitLiveRosterSides, type RosterSides } from "@/utils/rosterSides";
// Bots (`:Name:`) and operation scenario units (`IDS_*`) have no WG
// account — the shared store-free regex (utils/aiNames.ts) covers both.
import { AI_NAME } from "@/utils/aiNames";
import "./overlay.scss";

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
  /** The muted badge for folded AI rows (`:Name:` co-op fills): per-row
   *  faces in chipContent and the bot suffix of a mixed candidate range
   *  (candidatesChip). Count-less by design — every folded face IS a bot,
   *  and the game's own table marks its bot rows anyway. */
  botLabel: string;
  /** The per-row battle-count face (chipNumbers / candidatesChip) as a
   *  pattern carrying the count in `{n}`: the copy owns the unit word AND
   *  its placement, which is what lets one pattern serve all nine locales
   *  (the Chinese measure word hugs the number, Korean's noun reads
   *  before it). `{n}` is mandatory — scripts/check_i18n.py enforces
   *  placeholder parity. The unit is fixed per locale — no count inflects
   *  it, as these counts run to the thousands. */
  battlesCount: string;
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
  /** WG account id — the key the ship-scoped pipeline fetches through. */
  accountId?: number | null;
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
  /** The cluster the stats resolved on — a cross-server Clan-Battles pass
   *  can adopt a foreign-realm account; its per-ship fetch and clan gate
   *  must ride THIS realm, not the window's. */
  realm?: string | null;
  hidden: boolean;
}

/** Composition-seal verdict from `lookup_players_composition` (mirrors
 *  `wowsp_tauri_shared::PlayerComposition`; the >200 battles gate, the >20%
 *  minor share and the >50% veteran tier are enforced backend-side — a
 *  veteran flag implies its base flag). null = no data / hidden profile /
 *  that player's lookup failed. */
interface PlayerComposition {
  air: boolean;
  sub: boolean;
  airVeteran: boolean;
  subVeteran: boolean;
}

// main.ts declares Window.__TAURI__ as `unknown` for the whole project —
// narrow it locally instead of redeclaring the global.
const tauri = (window as unknown as { __TAURI__?: OverlayTauriApi }).__TAURI__;

// Realm is forwarded by create_overlay_window only when it was detected; an
// empty value DISABLES the batch lookups below instead of falling back to a
// guess — querying a wrong realm would silently pin lookalike accounts'
// stats onto the chips. The ONE sanctioned unlock is the probe's ground
// truth (below): a realm-reporting plugin telemetry payload carries the
// local player's cluster straight off the game's roster records.
let realm = new URLSearchParams(window.location.search).get("realm") ?? "";
// ── Probe identity (realm-reporting plugin builds) ──────────────────────
// Per-name ground-truth realms off the game's own roster records, plus the
// local player's cluster. Roster stats route each name to its reported
// cluster (cross-realm guessing stays off for those rows); the per-battle
// map resets on the telemetry's battle id so rows from the previous battle
// cannot bleed into the next one's routing. Validation rides the shared
// utils/realms list (the bare page cannot load Pinia stores, but it can
// load the util).
let identityRealms: Record<string, string> = {};
let identityBattle = "";
// App locale forwarded by create_overlay_window — picks the hint copy.
const locale = new URLSearchParams(window.location.search).get("locale") || "en-US";
// CN client static layout (realm 'cn' — the 360 client): its Tab table
// NEVER re-sorts mid-battle — sunk rows dim in place at their battle-start
// positions (observed on a real Tab capture, 2026-10-07: a 5-dead ally
// block still interleaving alive rows; see utils/shipClass's module docs).
// The realm can also be unlocked later by the probe's ground-truth self
// realm, so derive the flag per render.
const cnLayout = () => realm === "cn";
// The row-ORDER half (localized ship name, never the nation rank) is
// shared with the Lesta client (realm 'ru' — 2026-10-09 co-op capture: one
// 博加特里/Bogatyr row led two 圣路易斯/St. Louis rows against the
// usa < russia nation rank; see utils/realms's realmUsesShipNameOrder).
// The never-re-sorts half stays CN-only: no Lesta capture has diverged
// from the WG [alive] ++ [sunk] regroup, so its row mapping keeps the
// blockwise alive-vector machinery.
const nameOrderLayout = () => realmUsesShipNameOrder(realm);

// ── Display prefs (chips / stats source / intel / team averages / seals) ─
// One tolerant read of the statsPrefs blob the main window's store owns
// (see overlayPrefs.ts for the contract): the seal gates, the per-row chip
// content toggles, the three-dimension stats source, the team-intel items
// and the team-average line. The snapshot is RE-read whenever the main
// window's store broadcasts a write (`wowsp://stats-prefs-changed`, see
// refreshPrefs below) — a settings flip applies to the live window, not
// just the next one. The chips follow the same AND-composition as the
// webui surfaces: no PR rating, no seals, and a seal switched off
// individually never renders either.
let PREFS = readOverlayDisplayPrefs();
// The seal wording is Chinese-community vocabulary — RatingStamp.tsx
// renders nothing under a non-zh UI locale, and the overlay chips follow
// suit.
let SEALS_SHOWN = PREFS.sealsOn && locale.startsWith("zh");
// Whether ANY per-row number (winrate / PR / battles / avg damage) can
// render — gates the placeholder faces and the "querying" badge the same
// way the old single avg-stats switch did.
let ANY_CHIP_ON =
  PREFS.chips.winrate || PREFS.chips.pr || PREFS.chips.battles || PREFS.chips.damage;
// Which battle-mode career the chips + team averages render, resolved per
// battle in render() ("follow" tracks the arena's mode key; the fixed
// scopes and the global merge pin it).
let statsMode: ResolvedStatsMode = "random";
// A ship-scoped dimension is on (ship scope beyond the account careers, or
// the solo filter): every landed human stat then also carries the player's
// full per-ship list, and the chip/team-average views aggregate it through
// the SAME utils/shipStatsScope the main-window panels use. Re-derived on
// every prefs refresh (refreshPrefs below).
let SHIP_SCOPE_ON = dimsNeedShipStats(PREFS.statsDims);
// Bumped whenever the stats cache is invalidated wholesale (a PR-algo
// param flip): in-flight batches snapshot it and discard answers computed
// under the previous algo instead of re-caching stale numbers.
let statsGeneration = 0;
// The effective PR-algo param the stats pipeline last ran under (the batch
// RPC takes prAlgo; omitted while PR is off = the backend's winrate
// default). Tracked as its own variable — NOT re-derived from PREFS — so a
// flip chain like expected → PR off → winrate still sees the off step's
// invalidation and never shows expected-computed PRs under the winrate
// label (the main window's roster cache keys carry the algo and re-fetch
// through the same chain).
let statsAlgo: PrAlgo = PREFS.prAlgo ?? "winrate";

/** Re-read the statsPrefs blob after the main window's store wrote it (the
 *  `wowsp://stats-prefs-changed` broadcast — see stores/statsPrefs.ts) and
 *  re-derive the module gates, so a settings flip applies to the live
 *  window instead of only the next one. The career batch needs no re-query
 *  for the stats-source dims (one answer carries all three battle modes)
 *  and neither do the display toggles — a re-render through the refreshed
 *  snapshot is the whole update. The PR-algo param is the one pref the
 *  cached numbers BAKED IN at fetch time: an effective flip invalidates
 *  the cached careers and per-ship lists so the chips re-query under the
 *  new algo, matching the main window's roster pipeline. The wholesale
 *  clear also drops the cached clan tags, so the believed Tab order
 *  degrades to tag-less for the re-query's span — the same face a battle
 *  start has, and re-heals the moment the batch lands; cheaper to accept
 *  than showing old-algo numbers. */
function refreshPrefs(): void {
  const prevAlgo = statsAlgo;
  PREFS = readOverlayDisplayPrefs();
  SEALS_SHOWN = PREFS.sealsOn && locale.startsWith("zh");
  ANY_CHIP_ON =
    PREFS.chips.winrate || PREFS.chips.pr || PREFS.chips.battles || PREFS.chips.damage;
  SHIP_SCOPE_ON = dimsNeedShipStats(PREFS.statsDims);
  const nextAlgo = PREFS.prAlgo ?? "winrate";
  if (nextAlgo !== prevAlgo) {
    statsGeneration += 1;
    stats.clear();
    shipFetched.clear();
    statsAlgo = nextAlgo;
  }
}

// kind → Chinese label, copied from RatingStamp.tsx (bare DOM cannot reuse
// that Vue component).
const STAMP_TEXT: Record<StampKind, string> = {
  miracle: "神了",
  ape: "猴",
  maggot: "蛆",
  rat: "过街老鼠",
  air: "空中小人",
  sub: "水下小人",
  airVeteran: "空中老人",
  subVeteran: "水下老人",
  airMiracle: "空中神人",
  subMiracle: "水下神人",
  airApe: "空中小猴",
  subApe: "水下小猴",
};

// Custom seal pictures (settings' seal customizer → commands::stamps):
// kind → asset-protocol URL. Read at startup and RE-read whenever the main
// window broadcasts a stamps-folder write (`wowsp://stamps-changed`, see
// stores/stampOverrides.ts). A kind absent from this map shows the plain
// text seal; the kind-keyed file name in the stamps folder IS the state,
// so a plain list call is the whole sync.
const CUSTOM_STAMPS: Partial<Record<StampKind, string>> = {};
let stampsSequence = 0;
async function loadCustomStamps(invoke: OverlayTauriApi["core"]["invoke"]) {
  const sequence = ++stampsSequence;
  try {
    const files = (await invoke("stamp_list")) as Array<{ kind: string; path: string }>;
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    // Rebuild wholesale, like the main window's refreshStampOverrides: the
    // listing IS the state, and a reset deletes the kind's file — a
    // merge-only update would keep the reset kind's stale URL rendering a
    // dead image instead of falling back to the text seal.
    const next: Partial<Record<StampKind, string>> = {};
    for (const f of files) {
      if ((Object.keys(STAMP_TEXT) as string[]).includes(f.kind)) {
        next[f.kind as StampKind] = convertFileSrc(f.path);
      }
    }
    // A newer import/reset owns the display even if this read finishes last.
    if (sequence !== stampsSequence) return;
    for (const key of Object.keys(CUSTOM_STAMPS) as StampKind[]) {
      if (next[key] === undefined) delete CUSTOM_STAMPS[key];
    }
    Object.assign(CUSTOM_STAMPS, next);
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
/** The plugin's game-true TAB sort keys (telemetry `sortKeys`, read off
 *  the avatars' ship components — the client's own ShipSystem key string).
 *  When the map covers a side's roster, the row→name mapping sorts that
 *  side by key + '[TAG]nickname' — the exact string the game's Tab sort
 *  compares — instead of the offline per-realm inference. Dropped with the
 *  alive sets on a stale stream (a dead plugin must not keep pinning rows
 *  game-true). */
let telemetrySortKeys: Record<string, string> | null = null;
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
    // Cross-server CW rows resolved on a foreign cluster gate on THAT
    // realm's clans/info.
    const gateRealm = st.realm ?? realm;
    const key = clanWinrateKey(gateRealm, st.clanId);
    if (clanWinrates.has(key) || clanGateOut.has(key)) continue;
    clanGateOut.add(key);
    void lookupClanWinrate(gateRealm, st.clanId).then((wr) => {
      clanGateOut.delete(key);
      // Only the first verdict for a clan wins the slot — later duplicates
      // (there shouldn't be any) must not resurrect a failed verdict.
      if (!clanWinrates.has(key)) clanWinrates.set(key, wr);
      render();
    });
  }
}

const cacheKey = (name: string) => `${realm}:${name}`;

/** Whether the current battle is a Clan Battle (军团战) — those can be
 *  cross-server, so the batch rides the backend's cross-realm pass for
 *  names the window realm cannot explain. Same semantics as the webui's
 *  modeKey clan bucket (matchGroup containing "clan"). */
const crossRealmBattle = () => (arena?.matchGroup ?? "").toLowerCase().includes("clan");

/** The row's ship id by nickname (the chips are name-keyed; the arena's
 *  vehicles carry the id — per-row scoping keys off the ship that player
 *  is sailing in THIS battle). Rosters are small and renders are
 *  anchor-driven, so a fresh scan per call beats keeping a map in sync. */
function shipIdOfName(name: string): number | null {
  for (const v of arena?.vehicles ?? []) {
    if (v.name === name) return v.shipId ?? null;
  }
  return null;
}

/** One player's display numbers under the FULL three-dimension stats
 *  source: the account careers while the dims allow it, the aggregated
 *  per-ship view otherwise — the same utils/shipStatsScope module the
 *  main-window panels resolve through. */
function scopedStatView(name: string): RosterModeNumbers {
  const st = stats.get(cacheKey(name));
  return scopedRosterView(
    st,
    shipIdOfName(name),
    PREFS.statsDims,
    statsMode,
    PREFS.prAlgo ?? "winrate",
  );
}

function fmtDamage(avg: number): string {
  return avg >= 100000 ? `${Math.round(avg / 1000)}k` : `${(avg / 1000).toFixed(1)}k`;
}

function fmtBattles(n: number): string {
  return n >= 100000 ? `${Math.round(n / 1000)}k` : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** One battle count wearing its locale's unit ("1234 场" / "1234 battles")
 *  — the unit rides INSIDE the bold value so the whole face keeps one
 *  color (including the thin-sample red). Every battle-count chip face
 *  carries it: with all four chip toggles on, a bare number between the PR
 *  and the damage figures is exactly what a Tab-glance misreads. The count
 *  itself keeps fmtBattles' compaction — a unit must not widen the chip by
 *  digits the roster table already has no room for. */
function battlesText(n: number): string {
  return localized("battlesCount").replaceAll("{n}", fmtBattles(n));
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
    // The count lands with its localized unit (battlesText).
    const color = battlesColor(v.battles);
    parts.push(
      v.battles != null
        ? `<b${color ? ` style="color:${color}"` : ""}>${battlesText(v.battles)}</b>`
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

/** The face a stats-LESS chip wears: the player's bare nickname (the clan
 *  tag prefix stays off — the game's own table next to the chip already
 *  carries it; the chip only needs to identify the row). Escaped — roster
 *  names are game data.
 *
 *  This face is the overlay's entire failure VISIBILITY: the chip never
 *  renders the name when stats are present, so a "…" here was the ONLY
 *  content a broken lookup path (wrong realm baked into the window URL,
 *  unreachable API, lookups disabled) ever showed — on a Lesta client
 *  whose realm the main window had not detected that reads as "the
 *  overlay never appeared at all". Naming the row keeps the overlay
 *  informative through every such outage. */
function chipFallbackName(name: string): string {
  const bare = name.replace(/^\[[^\]]*\]/, "");
  return (bare.length > 0 ? bare : name)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** `storyLayout` = the single-team story/operation table — the layout gate
 *  EXCLUDING plain co-op (see render()): bot rows are aux noise on a
 *  script-driven roster, and the game's own table marks them anyway. */
function chipContent(name: string, side: "ally" | "enemy", storyLayout: boolean): string {
  if (AI_NAME.test(name)) {
    return !storyLayout && ANY_CHIP_ON
      ? `<span class="muted">${localized("botLabel")}</span>`
      : "";
  }
  const st = stats.get(cacheKey(name));
  // All chip toggles off → no numbers and none of their placeholder faces
  // either; the seals below still render (they are their own switch).
  let core: string;
  if (!ANY_CHIP_ON) core = "";
  else if (!st) core = `<span class="muted">${chipFallbackName(name)}</span>`;
  else if (st.hidden) core = `<span class="hidden">●</span>`;
  // Ship-scoped source with the per-ship list still on its way: keep the
  // "querying" face instead of dashes — dashes read as "never played in
  // this scope", which the landed numbers would contradict a beat later.
  else if (SHIP_SCOPE_ON && st.ships === undefined && st.accountId != null) {
    core = `<span class="muted">…</span>`;
  } else core = chipNumbers(scopedStatView(name));
  if (!SEALS_SHOWN) return core;
  // Every seal of a side sits on ONE flank: allies carry theirs to the
  // LEFT of the numbers, enemies to the RIGHT — no more splitting career
  // verdict and composition tags across the chip, which read as two
  // different players' data at tab-glance distance. The cluster rides the
  // shared merge rule (resolveStamps): a 神了 or 猴 verdict alongside comp
  // tags collapses into the merged 空中神人 / 水下神人 / 空中小猴 / 水下小猴
  // seals, which replace (consume) their constituents; 蛆 and 过街老鼠 each
  // suppress the comp tags entirely, and a >50% class share upgrades the
  // minor tag to the veteran 老人 seal in the career-leads-then-air-then-sub
  // order. A name without stats yet shows no seal at
  // all — the verdicts are derived from data the stats/composition
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
    const verdict =
      clanId != null
        ? clanWinrates.get(clanWinrateKey(st.realm ?? realm, clanId))
        : undefined;
    if (!(clanId != null && verdict === undefined)) {
      career = careerStamp(st.pr, st.battles, st.winrate, st.hidden, verdict);
    }
  }
  const comp = compositions.get(cacheKey(name)) ?? null;
  const seals = resolveStamps(career, comp).map(stampNode).join("");
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
 *  per-member faces chipContent renders. The AI members fold into ONE
 *  muted badge (localized "botLabel") after the human faces: the game's
 *  own table already marks those rows, so a verbatim "bot / bot / bot"
 *  only stretched the chip over the left HUD, and the exact headcount of
 *  an ambiguous row's bots says nothing a Tab-glance acts on — "43.2% +
 *  bot" is the whole truth it needs. A pure-bot range collapses to the
 *  same single face. On the story layout (storyLayout) a pure-bot range
 *  collapses to NOTHING instead — same aux rule as chipContent — while a
 *  mixed range keeps its bot badge so one human's face is not read as
 *  the WHOLE row. */
function candidatesChip(members: string[], storyLayout: boolean): string {
  if (!ANY_CHIP_ON) return "";
  const { humans, botCount } = collapseCandidateBots(members);
  if (humans.length === 0) {
    return storyLayout ? "" : `<span class="muted">${localized("botLabel")}</span>`;
  }
  const face = (m: string): string => {
    const st = stats.get(cacheKey(m));
    if (!st) return `<span class="muted">${chipFallbackName(m)}</span>`;
    if (st.hidden) return `<span class="hidden">●</span>`;
    // Same pending face as chipContent: dashes would read as "never
    // played in this scope" a beat before the landed numbers arrive.
    if (SHIP_SCOPE_ON && st.ships === undefined && st.accountId != null) {
      return `<span class="muted">…</span>`;
    }
    const v = scopedStatView(m);
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
      return `<b${color ? ` style="color:${color}"` : ""}>${battlesText(v.battles)}</b>`;
    }
    return `<span class="muted">—</span>`;
  };
  const faces = humans.map(face).join(`<span class="sep">/</span>`);
  if (botCount > 0) {
    return `${faces}<span class="sep">+</span><span class="muted">${localized("botLabel")}</span>`;
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
 *  On the story layout (storyLayout — single-team, co-op excluded) the
 *  consumable-intel half is skipped wholesale: radar/hydro/smoke counting
 *  is a versus-human aid, and a script-driven roster's numbers are aux
 *  noise. The averages half stays — it grades the human roster and rides
 *  its own prefs switches.
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
  storyLayout: boolean,
): HTMLDivElement | null {
  const sideLabel = `<span class="overlay-intel-team">${localized(
    side === "ally" ? "intelAlly" : "intelEnemy",
  )}</span>`;
  const lines: string[] = [];
  const intel = teamIntelFor(vehicles.map((v) => v.shipId));
  const intelItem = (label: string, c: TeamIntelCount) =>
    `<span class="overlay-intel-k">${label}</span><b>${formatIntelCount(c)}</b>`;
  if (!storyLayout && PREFS.teamIntel && (PREFS.intel.radar || PREFS.intel.hydro || PREFS.intel.smoke)) {
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
              const v2 =
                st && !st.hidden
                  ? scopedRosterView(
                      st,
                      v.shipId ?? null,
                      PREFS.statsDims,
                      statsMode,
                      PREFS.prAlgo ?? "winrate",
                    )
                  : null;
              return {
                winrate: v2?.winrate ?? null,
                pr: v2?.pr ?? null,
                battles: v2?.battles ?? null,
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

/** The battle's LIVE side split — scripted scenario NPCs filtered out iff
 *  this is a real operation (行动), where the game's own Tab table renders
 *  the human team only (the story-table capture of PCVO011_OP_10 shows 7
 *  human rows while the roster carries 2 scripted allies); every other
 *  battle — the tutorial-family scripted layouts included — keeps the raw
 *  relation split, because there the game DOES field the scripted units as
 *  team rows. Every consumer on this page (the chip blocks, the row
 *  mapping, the sink-attribution orders) resolves against THIS split, and
 *  the Rust sink solver's ally-row count mirrors it (arena_info's
 *  note_arena_seen). */
function liveRosterSides(): RosterSides<Vehicle> {
  if (!arena) return { allies: [], enemies: [] };
  return splitLiveRosterSides(
    arena.vehicles,
    isOperationBattle(
      arena.matchGroup,
      arena.scenario,
      arena.eventType,
      arena.vehicles.map((v) => v.name),
    ),
  );
}

/** The roster's believed full-key order for one side — the same ordering
 *  inferredRowMapping applies (see utils/shipClass for the decompiled
 *  rule and its ship-name permutation, CN/Lesta clients) over the live
 *  side split above. When this battle's telemetry sort-key map covers the
 *  side's roster, the client's OWN key + '[TAG]nickname' comparison takes
 *  over entirely (the exact string __sortKeyAlive compares — no
 *  inference). */
function sideFullOrder(side: SunkSide): string[] {
  if (!arena) return [];
  const list = side === "enemy" ? liveRosterSides().enemies : liveRosterSides().allies;
  const compareOptions: TabRowCompareOptions = {
    locale,
    clanTagOf: (v) => stats.get(cacheKey(v.name))?.clanTag ?? null,
    shipNameOrder: nameOrderLayout(),
  };
  // Game-true sort keys: only a FULLY covered list switches the sort
  // (game-true and inferred rows must never interleave).
  const keyOf = telemetrySortKeys
    ? (v: (typeof list)[number]) => telemetrySortKeys![v.name]
    : undefined;
  const clientKeys = keyOf && list.length > 0 ? list.map((v) => keyOf(v)) : null;
  const useClientKeys =
    clientKeys != null && clientKeys.every((k) => typeof k === "string" && k.length > 0);
  const clientKeyOf = useClientKeys
    ? (v: (typeof list)[number]) => {
        const key = keyOf!(v);
        return key + tabDisplayName(v.name, stats.get(cacheKey(v.name))?.clanTag ?? null);
      }
    : null;
  return list
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      if (clientKeyOf) {
        const ka = clientKeyOf(a.v);
        const kb = clientKeyOf(b.v);
        return ka < kb ? -1 : ka > kb ? 1 : a.i - b.i;
      }
      const c = gameTabRowCompare(a.v, b.v, compareOptions);
      return c !== 0 ? c : a.i - b.i;
    })
    .map(({ v }) => v.name);
}

/** The side's believed CURRENT alive order (full order minus the trusted
 *  sunk set) — what sink-attrib row indices resolve against. While the
 *  side is exact this is the game's alive block, verbatim. The channel is
 *  dormant on CN (the capture's alive vector is never blockwise there, so
 *  the Rust solver's gate rejects every transition and emits no rows) —
 *  should that ever change, its indices assume the WG blockwise model and
 *  must NOT be resolved against the CN static order. */
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
  // Which battle-mode stats this battle renders ("follow" resolves per
  // battle — ranked battles show the ranked career, everything else the
  // randoms career; the fixed scopes pin it).
  statsMode = resolveRosterBattleScope(PREFS.statsDims.battle, arena);
  const dpr = window.devicePixelRatio || 1;
  const rows = anchor.rowCenters;
  if (rows.length === 0) return;

  // The anchor carries TWO grid blocks concatenated: allies first, then
  // enemies (asymmetrical battles 12v6 render sub-tables of different
  // heights). Each side maps onto its OWN block — the enemy block starts
  // where the ally block ends. The sides come from the live split
  // (liveRosterSides above): a real operation (行动) fields its human team
  // only — the game's story table never draws the scripted allies, so they
  // hold no row here — and its enemy block is dropped entirely (all
  // scripted spawns, and mid-battle waves grow past the roster
  // tempArenaInfo ever sees).
  const rosterNames = arena.vehicles.map((v) => v.name);
  const operation = isOperationBattle(
    arena.matchGroup,
    arena.scenario,
    arena.eventType,
    rosterNames,
  );
  const { allies, enemies } = liveRosterSides();
  const allyBlock = rows.slice(0, allies.length);
  const enemyBlock = rows.slice(allies.length);
  // The single-team table (team_split EXACTLY 1.0 = the green-only header,
  // overlay_detect::finish_roster): the game itself renders ONE team column
  // there, so the anchor has NO enemy rows — the layout truth every
  // enemy-block half below must respect. The layout, not the mode-label
  // classifiers, is the ground truth here: story battles exist whose
  // descriptor carries no operation fingerprint (isOperationBattle false),
  // yet their Tab screen is still the one-column team table.
  const singleTable = anchor.teamSplit >= 0.999;
  // The AUX gate on top of the layout: the "bot" fill labels and the
  // radar/hydro/smoke intel lines are versus-human aids — noise on a
  // script-driven story/operation roster, but meaningful on plain co-op
  // (your own team's bot fill, your team's consumable spread), so co-op
  // battles keep them even though their Tab screen is the same single
  // column (isCoopBattle: coop-family descriptor + zero scripted units).
  const storyLayout = singleTable && !isCoopBattle(
    arena.matchGroup,
    arena.scenario,
    arena.eventType,
    rosterNames,
  );
  // Row → name attribution. Both modes name rows: this page derives the
  // mapping itself from the arena roster + the anchor's alive vector via
  // the client's own Tab sort key (inferredRowMapping). A missing/older
  // backend field keeps the legacy index mapping.
  let players: (string | string[] | null)[] | null = null;
  let aliveArr: boolean[] | null = null;
  if (anchor.rosterMode) {
    aliveArr = anchor.rowAlive ?? null;
    // CN clients never re-sort the table and never follow the nation-rank
    // order (see cnLayout above): the mapping is the battle-start key order
    // for the whole battle, and the reconcile/degrade machinery below —
    // whose blockwise alive-vector assumption is false there — must not
    // run (a degraded candidate range would pin a WRONG name with
    // battle-start confidence; the exact misattribution this page shipped
    // to fix). The per-row sunk chip styling below already reads the alive
    // vector row by row, which is the only thing the CN layout needs. The
    // row-order permutation itself also covers Lesta (nameOrderLayout),
    // but there the blockwise machinery stays live — the WG regroup holds.
    const staticLayout = cnLayout();
    // The mapping replicates the client's own Tab sort key (decompiled —
    // see inferredOrder.ts), so battle-start rows arrive as EXACT names.
    // Mid-battle, the sink tracker holds the TRUSTED sunk sets (fed by the
    // sink-attrib events) — a side whose set agrees with the anchor's
    // alive count renders the exact [alive] ++ [sunk] layout, every row
    // named; a degraded side (a sink the strip solver could not explain)
    // falls back to provable CANDIDATE RANGES. Clan tags feed the key's
    // display-name segment, and the mapping re-derives on every render —
    // when the WG batch lands a tag, the next render re-sorts with it.
    const allyN = allies.length;
    const enemyN = enemies.length;
    const reconcileSide = (rel: "ally" | "enemy", n: number, off: number) => {
      // Plugin telemetry outranks the capture alive vector: its sets are
      // updated off-Tab, so reconciling them against a STALE vector would
      // wrongly degrade the side on every sink between Tab holds. The CN
      // static layout has no blockwise vector to reconcile against at all.
      if (telemetryAuthoritative || staticLayout) return;
      const slice = aliveArr == null ? null : aliveArr.slice(off, off + n);
      const aliveCount = slice == null ? n : slice.lastIndexOf(true) + 1;
      sunk.reconcile(rel, n - aliveCount);
    };
    // The ally block always reconciles (its roster is complete). The ops
    // enemy block does not: its Tab rows grow mid-battle as waves spawn
    // past the roster tempArenaInfo captured, so a fixed-count reconcile
    // would misattribute. Same for ANY single-table anchor — its grid
    // carries NO enemy rows at all (green-only header, co-op included),
    // so an empty slice would read "everyone alive" and wrongly degrade
    // the side.
    reconcileSide("ally", allyN, 0);
    if (!operation && !singleTable) reconcileSide("enemy", enemyN, allyN);
    if (telemetryAuthoritative && pluginSunkNames) {
      // Plugin-authoritative layout: split by set membership
      // unconditionally — no alive-vector agreement check, no candidate
      // ranges, stamps by membership. A sink the row detector missed
      // leaves that row chipless in the positional zip below instead of
      // misattributing a player onto it.
      players = pluginRowMapping({ allies, enemies }, {
        ally: sunk.sunkNames("ally"),
        enemy: sunk.sunkNames("enemy"),
      }, {
        locale,
        clanTagOf: (name) => stats.get(cacheKey(name))?.clanTag ?? null,
        shipNameOrder: nameOrderLayout(),
        staticLayout,
        sortKeyOf: telemetrySortKeys ? (name) => telemetrySortKeys![name] : undefined,
      });
    } else {
      players = inferredRowMapping({ allies, enemies }, aliveArr, {
        locale,
        clanTagOf: (name) => stats.get(cacheKey(name))?.clanTag ?? null,
        shipNameOrder: nameOrderLayout(),
        staticLayout,
        sortKeyOf: telemetrySortKeys ? (name) => telemetrySortKeys![name] : undefined,
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
          html = chipContent(mapped, side, storyLayout);
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
          html = candidatesChip(mapped, storyLayout);
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
        html = chipContent(v.name, side, storyLayout);
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
  // On the story layout (storyLayout) the ally card carries the averages
  // only — the consumable-intel half is aux noise on a script-driven
  // story/operation roster — and the enemy card has no column to hang
  // under anyway (no enemy rows).
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
        storyLayout,
      );
      if (el) {
        el.style.left = `${tableLeft + gap}px`;
        root.appendChild(el);
        clampVertically(el);
      }
    }
    if (!operation && !singleTable && enemies.length > 0 && enemyBlock.length > 0) {
      const el = teamSummaryCard(
        "enemy",
        enemies,
        // Same top-edge anchor as the ally card.
        enemyBlock[enemyBlock.length - 1] / dpr + pitch,
        intelFontSize,
        storyLayout,
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

// ── Query lanes (the overlay page's mirror of the main window's shared
// statsQuery pipeline) ───────────────────────────────────────────────────
// Roster sub-batches and per-ship lookups dispatch in FIFO order but run
// up to QUERY_LANES at once, each result rendering the moment it lands —
// the chips fill in first-arrived-first-shown instead of one block when a
// single mega-batch resolves. Lanes × the backend's own bounded fan-out
// keeps the request width in the same envelope the chunked fetchers of
// old already held.
const QUERY_LANES = 3;
/** Roster sub-batch width (see useRosterStats' ROSTER_QUERY_CHUNK). */
const ROSTER_QUERY_CHUNK = 6;

/** Run `fn` over `items`, at most QUERY_LANES at a time, dispatching in
 *  order. `fn` failures are the caller's to catch inside itself. */
async function runLanes<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(QUERY_LANES, items.length) }, lane));
}

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

// ── Ship-scoped pipeline (the SHARED per-ship source) ───────────────────
// While SHIP_SCOPE_ON, every landed human stat additionally carries the
// player's full per-ship list. The fetch rides the backend's shared
// facility — the SAME single-flight + process-lifetime session cache the
// main window's roster uses (lookup_player_ship_stats with sessionCache) —
// so both windows together cost ONE WG request per player per process,
// whichever asks first; the manual "refresh stats" button wipes that
// shared cache Rust-side, keeping a forced refresh forced. Failures budget
// at one attempt per account per battle (reset on battle switch), the
// same discipline the main pipeline keeps. Keyed `${realm}:${accountId}`:
// ids are unique per realm, not globally, and a cross-server roster can
// field two same-numbered accounts.
const shipFetched = new Set<string>();
let shipTimer: ReturnType<typeof setTimeout> | null = null;
let shipsInFlight = false;

/** True when at least one roster stat still owes its per-ship list. */
function shipListsPending(): boolean {
  if (!arena) return false;
  for (const v of arena.vehicles) {
    if (AI_NAME.test(v.name)) continue;
    const st = stats.get(cacheKey(v.name));
    if (!st || st.hidden || st.accountId == null) continue;
    if (st.ships !== undefined || shipFetched.has(`${st.realm ?? realm}:${st.accountId}`))
      continue;
    return true;
  }
  return false;
}

function scheduleShipLists() {
  if (!SHIP_SCOPE_ON || !tauri || !realm) return;
  if (shipTimer || shipsInFlight) return;
  if (shipListsPending()) shipTimer = setTimeout(runShipBatch, 300);
}

/** Write one account's list into every same-account stat. The name-keyed
 *  cache persists across battles and so does the attached list — per-ship
 *  careers are session-stable. The realm guard keeps a same-numbered
 *  account on another cluster (ids are unique per realm, not globally)
 *  from receiving this list. */
function applyShips(
  accountId: number,
  entryRealm: string,
  ships: NonNullable<RawStat["ships"]> | null,
) {
  for (const st of stats.values()) {
    if (
      st.accountId === accountId &&
      (st.realm ?? realm) === entryRealm &&
      st.ships === undefined
    ) {
      st.ships = ships;
    }
  }
}

async function runShipBatch() {
  shipTimer = null;
  if (!tauri || !realm || shipsInFlight) return;
  // `${realm}:${accountId}` → fetch target: the cluster that player's
  // stats resolved on (cross-server CW rows fetch through THEIR realm).
  const ids = new Map<string, { id: number; entryRealm: string }>();
  for (const v of arena?.vehicles ?? []) {
    if (AI_NAME.test(v.name)) continue;
    const st = stats.get(cacheKey(v.name));
    if (!st || st.hidden || st.accountId == null) continue;
    const entryRealm = st.realm ?? realm;
    const key = `${entryRealm}:${st.accountId}`;
    if (st.ships !== undefined || shipFetched.has(key)) continue;
    ids.set(key, { id: st.accountId, entryRealm });
  }
  if (ids.size === 0) return;
  shipsInFlight = true;
  const gen = statsGeneration;
  try {
    // One lane slot per account: each list lands and renders the moment
    // it resolves (the main window's pipeline keeps the same contract).
    await runLanes([...ids.values()], async ({ id, entryRealm }) => {
      try {
        const ships = (await tauri.core.invoke("lookup_player_ship_stats", {
          accountId: id,
          realm: entryRealm,
          // Tauri v2 matches command args camelCase (ArgumentCase::Camel):
          // a snake_case key here is silently dropped and the command
          // would run the winrate algorithm under an expected-PR pref.
          ...(PREFS.prAlgo != null ? { prAlgo: PREFS.prAlgo } : {}),
          sessionCache: true,
        })) as NonNullable<RawStat["ships"]>;
        // Currency guard (the same one useRosterStats keeps): a
        // stale-algo answer must not adopt the refetched entries —
        // ships !== undefined reads as "answered" and would block
        // their refetch for the rest of the session.
        if (gen === statsGeneration) {
          applyShips(id, entryRealm, ships ?? null);
          render();
        }
      } catch {
        // One attempt per battle — a hard-down API must not be probed
        // on every anchor event (the battle switch re-arms below). The
        // mark and the null verdict only stick while this batch is
        // still current: after a prefs flip neither may survive into
        // the refetch (a stale null would block it the same way).
        if (gen === statsGeneration) {
          shipFetched.add(`${entryRealm}:${id}`);
          applyShips(id, entryRealm, null);
          render();
        }
      }
    });
  } finally {
    shipsInFlight = false;
    scheduleShipLists();
  }
}

function scheduleBatch() {
  if (!arena || !tauri) return;
  // Names whose stats already landed may still owe a composition verdict or
  // a hidden-profile clan gate — give both pipelines their trigger here,
  // before the stats-specific guards below (they are about the STATS
  // cadence, not the seals').
  scheduleCompBatch();
  scheduleClanGates();
  scheduleShipLists();
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
  const gen = statsGeneration;
  let anyFailed = false;
  // Names riding chunks that THREW (transport / WG limits) — only these
  // spend their not-found budget below; a sibling chunk's failure must not
  // tax the names that already settled their own null answers.
  const failedChunkNames: string[] = [];
  try {
    // Ground-truth per-name realms (the realm-reporting probe reports each
    // player's cluster straight off the game's roster records): routed
    // groups resolve on their REPORTED realm with the cross pass off (the
    // realm is known — probing would be guessing); rows the probe could
    // not report ride the window realm + the cross pass.
    const groups: Array<{ realm: string; names: string[]; cross: boolean }> = [];
    const rest: string[] = [];
    for (const name of names) {
      const reported = identityRealms[name];
      if (reported) {
        const group = groups.find((g) => g.realm === reported);
        if (group) group.names.push(name);
        else groups.push({ realm: reported, names: [name], cross: false });
      } else {
        rest.push(name);
      }
    }
    if (rest.length > 0) {
      groups.push({ realm, names: rest, cross: crossRealmBattle() });
    }
    // Sub-batches: every group splits into ROSTER_QUERY_CHUNK-sized chunks
    // that run through the lanes — each landed chunk caches and renders
    // immediately, so the chips fill in as the answers arrive (the
    // first-arrived-first-shown contract the main window's shared pipeline
    // keeps).
    const chunks: Array<{ realm: string; names: string[]; cross: boolean }> = [];
    for (const group of groups) {
      for (let i = 0; i < group.names.length; i += ROSTER_QUERY_CHUNK) {
        chunks.push({
          realm: group.realm,
          names: group.names.slice(i, i + ROSTER_QUERY_CHUNK),
          cross: group.cross,
        });
      }
    }
    await runLanes(chunks, async (chunk) => {
      // pr_algo rides along while the PR rating is on — the same param the
      // main window injects (prAlgoForRequest), so chip PRs never disagree
      // with the app's cards under the expected algorithm.
      try {
        const results = (await tauri.core.invoke("lookup_players_stats_batch", {
          names: chunk.names,
          realm: chunk.realm,
          // camelCase key (Tauri v2 ArgumentCase::Camel) — the snake_case
          // spelling that used to live here was silently dropped, so chip PRs
          // kept the winrate proxy while the expected algorithm was selected.
          ...(PREFS.prAlgo != null ? { prAlgo: PREFS.prAlgo } : {}),
          // Cross-server Clan Battles probe the other WG clusters for names
          // this realm cannot explain; adopted rows carry their true realm.
          ...(chunk.cross ? { crossRealm: true } : {}),
        })) as Array<BatchStat | null>;
        // A prefs flip mid-flight bumped statsGeneration (the cache was
        // cleared for the new PR-algo param) — these answers were computed
        // under the previous one; drop them instead of re-caching stale
        // numbers (the finally below re-runs the pipeline under the fresh
        // prefs right away).
        if (gen !== statsGeneration) return;
        chunk.names.forEach((name, i) => {
          const r = results[i] ?? null;
          if (r) {
            stats.set(cacheKey(name), {
              accountId: r.accountId ?? null,
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
              // The cluster the answer resolved on — the window realm for
              // same-realm rows, a foreign cluster for cross-server CW rows.
              realm: r.realm ?? null,
              hidden: r.hidden,
            });
            notFoundLeft.delete(name);
            notFoundRetry.delete(name);
          } else {
            stats.set(cacheKey(name), {
              accountId: null,
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
        render();
        // Freshly landed stats unlock the composition-seal lookups for
        // those names (seals only queue names that already have their
        // stats), the hidden-profile clan gates and the ship-scoped lists
        // alike — per chunk, so a slow chunk no longer delays the unlock
        // for names that already landed (all three are idempotent).
        scheduleCompBatch();
        scheduleClanGates();
        scheduleShipLists();
      } catch {
        anyFailed = true;
        failedChunkNames.push(...chunk.names);
      }
    });
    // Success: restore the initial cadence for any future failure.
    if (!anyFailed) retryDelayMs = 2000;
    scheduleNotFoundRetry();
    render();
  } catch {
    anyFailed = true;
  } finally {
    inFlight = false;
    if (anyFailed && gen === statsGeneration) {
      // Transient WG hiccup: retry the same (still-uncached) names after a
      // capped, doubling pause — but only while the per-battle retry budget
      // lasts (see RETRIES_PER_BATTLE). The chips honestly stay "…" until a
      // retry lands — never a silently wrong "no data". A batch the prefs
      // flip already discarded (statsGeneration moved under it) pays no
      // retry / not-found budget — its names re-queue through the
      // scheduleBatch below, under the fresh prefs.
      if (retriesLeft > 0) {
        retriesLeft -= 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          scheduleBatch();
        }, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, RETRY_DELAY_MAX_MS);
      }
      // A thrown chunk is still an ATTEMPT against the suspected-absent
      // names riding in it: spend their budget and re-arm, so their
      // re-queue stays bounded even while the API is hard-down (the
      // backoff above never re-queues them — their null answers are
      // cached).
      for (const name of failedChunkNames) {
        if (notFoundRetry.has(name)) spendNotFoundRetry(name);
      }
      scheduleNotFoundRetry();
    }
    // A discarded batch (statsGeneration moved under it) left the roster
    // uncached — re-run the pipeline under the fresh prefs immediately
    // instead of waiting for the next anchor event.
    if (gen !== statsGeneration) scheduleBatch();
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
      // Ship-scoped lists retry their failures with the new battle: drop
      // this battle's marks and the null verdicts they wrote (successful
      // attachments persist — the data is session-stable).
      if (SHIP_SCOPE_ON) {
        shipFetched.clear();
        for (const st of stats.values()) {
          if (st.ships === null) st.ships = undefined;
        }
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
  await listen("wowsp://stats-prefs-changed", () => {
    // The main window's statsPrefs store re-wrote the shared localStorage
    // blob and broadcast (stores/statsPrefs.ts). Re-read it and re-render:
    // the stats-source dims, chip toggles, intel/average items and the PR
    // + seal gates all apply to the live window now, not the next one.
    // refreshPrefs also invalidates the cached careers when the PR-algo
    // param flipped; scheduleBatch re-arms every pipeline the flip
    // switched on (per-ship lists, composition seals, clan gates) and is a
    // cheap no-op otherwise (cached answers, existing backoffs respected).
    refreshPrefs();
    scheduleBatch();
    render();
  });
  await listen("wowsp://stamps-changed", () => {
    // The settings seal customizer imported or reset a custom picture
    // (stores/stampOverrides.ts). Re-read the stamps folder — chips read
    // CUSTOM_STAMPS at render time, so a re-render as the read lands swaps
    // the pictures in (and a reset falls back to the plain text seal).
    void loadCustomStamps(invoke).then(() => render());
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
    const payload = e.payload as {
      t?: number;
      battle?: string;
      players?: Record<string, boolean>;
      sortKeys?: Record<string, string>;
      self?: { name?: string; realm?: string };
      identity?: Record<string, { account_id?: number; realm?: string }>;
    } | null;
    // Ground truth first, in every roster mode: the realm-reporting probe
    // carries each player's cluster (identity) and the local player's
    // (self) straight off the game's roster records. Roster stats route
    // per name, and a window created with NO detected realm (lookups
    // normally stay disabled rather than guess) unlocks on the probe's
    // self realm.
    if (payload?.t && Date.now() - payload.t <= 30_000 && payload.identity) {
      if (payload.battle && payload.battle !== identityBattle) {
        identityBattle = payload.battle;
        identityRealms = {};
      }
      const map: Record<string, string> = { ...identityRealms };
      for (const [name, row] of Object.entries(payload.identity)) {
        const realmCode = (row?.realm ?? "").trim().toLowerCase();
        if (isKnownRealm(realmCode)) map[name] = realmCode;
      }
      identityRealms = map;
      const selfRealmCode = (payload.self?.realm ?? "").trim().toLowerCase();
      if (isKnownRealm(selfRealmCode) && !realm) {
        // No detected realm (the "don't guess" gate): the probe's ground
        // truth replaces it — batch lookups unlock on the next schedule.
        realm = selfRealmCode;
        scheduleBatch();
      }
    }
    if (!payload?.players || !arena) return;
    if (Date.now() - (payload.t ?? 0) > 30_000) {
      // Stale stream (the Rust poller normally pre-filters these — this is
      // the defensive belt): release the authoritative lock so the
      // inference chain resumes, and drop the trusted sets + the game-true
      // sort keys with it (a dead plugin must not keep pinning rows).
      telemetryAuthoritative = false;
      pluginSunkNames = null;
      telemetrySortKeys = null;
      render();
      return;
    }
    if ((anchor?.rosterMode ?? "") !== "plugin") {
      telemetryAuthoritative = false;
      return;
    }
    const bySide: { ally?: Set<string>; enemy?: Set<string> } = {
      ally: new Set(),
      enemy: new Set(),
    };
    const rosterNames = new Set<string>();
    const sides = liveRosterSides();
    // The live split's membership — the same convention as sideFullOrder
    // and the Rust sink solver. A scripted unit a real operation dropped
    // never enters a side set here, so the sets stay size-consistent with
    // the drawn rows even after telemetry authority is lost (a stale-stream
    // reconcile must not degrade the side to candidate ranges).
    for (const [list, side] of [
      [sides.allies, "ally"],
      [sides.enemies, "enemy"],
    ] as const) {
      for (const v of list) {
        rosterNames.add(v.name);
        if (payload.players[v.name] === false) bySide[side]!.add(v.name);
      }
    }
    telemetryAuthoritative = true;
    sunk.applyNamedSunk(bySide, rosterNames);
    pluginSunkNames = new Set([...bySide.ally!, ...bySide.enemy!]);
    telemetrySortKeys = payload.sortKeys ?? null;
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

  // Custom seal pictures: one fire-and-forget read so the first render
  // already carries them (chips read CUSTOM_STAMPS at render time); later
  // imports/resets in the settings window arrive as `wowsp://stamps-changed`
  // events and re-run this read (see the listener above). A failure here
  // costs nothing (the bundled glyphs show).
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
