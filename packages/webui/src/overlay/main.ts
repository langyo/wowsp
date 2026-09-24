/**
 * Overlay window bootstrap — deliberately NOT Vue.
 *
 * The Rust Tab watcher shows this window only after the battle-HUD probe
 * passes, and this page must paint instantly, so it is bare DOM: a tiny
 * listener renders per-player chips from two Tauri events:
 *
 *   - `wowsp://arena-info`  → roster snapshot (names, teams) → schedules ONE
 *     batched WG stats lookup (same backend command the main window uses);
 *   - `wowsp://overlay-anchor` → table geometry (rows, team split) → chips
 *     are positioned at each row.
 *
 * Coordinates arrive in physical px relative to the overlay window's own
 * origin; CSS px = physical / devicePixelRatio.
 */
import { careerStamp, damageColor, winrateColor, type StampKind } from "@/utils/winrate";
// Pure-TS transport wrapper (no Vue/Pinia) — safe for this bare-DOM page,
// same as @/utils/winrate above.
import { clanWinrateKey, lookupClanWinrate } from "@/utils/clanWinrate";
// The square 2x2 faces the in-app surfaces use, plus the flat one-line
// recuts of the four-char seals (res/stamps-wide) — the chip rows are far
// too short for a 2x2 face, so ONLY this page swaps the flat faces in
// (see scripts/recut_stamp_bitmaps.py).
import stampAir from "../res/stamps-wide/stamp-air.png";
import stampApe from "../res/stamps/stamp-ape.png";
import stampMaggot from "../res/stamps/stamp-maggot.png";
import stampMiracle from "../res/stamps/stamp-miracle.png";
import stampRat from "../res/stamps-wide/stamp-rat.png";
import stampSub from "../res/stamps-wide/stamp-sub.png";
import "./overlay.css";

// Same locale files the Vue app consumes — one source of truth for the hint
// copy, bundled eagerly into this tiny page (a few KB across 9 locales).
interface OverlayMessages {
  /** Failed-locate copy (the centered hint box IS the failure). */
  locateHint: string;
  /** Locating copy: recognition is on, the table just isn't pinned yet. */
  locatingHint: string;
  /** Small badge over the table while the row mapping is still pending. */
  recognizingBadge: string;
  /** Badge while the batched stats lookup is still working and at least
   *  one mapped chip has no numbers yet. */
  queryingBadge: string;
  /** Badge while a detected sink reshuffled the rows and the row→name
   *  re-mapping is still catching up. */
  staleBadge: string;
  /** Hint-box copy shown INSTEAD of the locating copy when the update
   *  itself is why the table is not on screen (the stale mark survived a
   *  lost pin — a change was detected and a full re-scan is running). */
  staleHint: string;
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
}

interface ArenaInfo {
  dateTime?: string | null;
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
  /** Per-row player names matched against the arena roster (closed set),
   *  same length/order as rowCenters (allies block first). null/absent →
   *  no recognition ran, rows map onto roster entries BY INDEX (legacy).
   *  An element null → that row's player was not recognized: render a
   *  silent placeholder and NEVER fall back to the index guess — the
   *  in-game panel sorts rows its own way, which is what the matcher
   *  exists to fix. */
  rowPlayers?: (string | null)[] | null;
  /** Per-row alive classification read off the same name strips (sunk rows
   *  render dim gray in-game). Same length/order as rowCenters; true =
   *  alive; null/absent = unknown (treat every row as alive). */
  rowAlive?: boolean[] | null;
  /** True when recognition is enabled but this anchor has no trusted
   *  row→name mapping yet (absent, or an all-null read — nothing
   *  matched): a small "recognizing roster" badge renders over the table
   *  until the watcher transplants the mapping onto the pin. */
  rowPlayersPending?: boolean;
  /** True when a detected sink JUST changed the rows (alive flags flipped,
   *  the in-game table re-sorted) and the row→name re-mapping is catching
   *  up at the accelerated OCR cadence: the chips' attribution below may
   *  change again within seconds. Purely informational — a "roster
   *  updating" badge renders while it is up. */
  stale?: boolean;
}

interface Stat {
  winrate: number | null;
  avgDamage: number | null;
  /** Career PR + battle count — only consumed by the career seal below. */
  pr: number | null;
  battles: number | null;
  /** Clan id from the batch answer (null = clanless / not found) — joins
   *  the hidden-profile 过街老鼠 clan gate below. */
  clanId: number | null;
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

const AI_NAME = /^:.*:$/;
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

// ── Seals (career/composition stamp bitmaps beside the chip numbers) ────
// Local mirror of stores/statsPrefs.ts (STATS_PREFS_STORAGE_KEY =
// "wowsp-stats-prefs"): the bare-DOM page must not import the pinia store,
// so the prefs are re-read here with the same contract as parsePrefs — a
// corrupt blob or unavailable localStorage falls back to the defaults.
// The seals toggle is the PR master switch's sub-control in settings, and
// the seal customizer adds a per-kind kill switch on top; the chips follow
// the same AND-composition as the webui surfaces: no PR rating, no seals,
// and a seal switched off individually never renders either.
const SEALS_ON = (() => {
  const fallback = { pr: false, seals: true };
  try {
    const raw = localStorage.getItem("wowsp-stats-prefs");
    if (raw == null) return fallback.pr && fallback.seals;
    const j = JSON.parse(raw) as { prEnabled?: unknown; sealsEnabled?: unknown };
    const pr = typeof j?.prEnabled === "boolean" ? j.prEnabled : fallback.pr;
    const seals = typeof j?.sealsEnabled === "boolean" ? j.sealsEnabled : fallback.seals;
    return pr && seals;
  } catch {
    return fallback.pr && fallback.seals;
  }
})();
// Per-kind kill switches (settings' seal customizer), read with the same
// tolerance contract: unknown keys dropped, non-booleans ignored.
const STAMP_KIND_LIST: readonly StampKind[] = ["miracle", "ape", "maggot", "rat", "air", "sub"];
const SEALS_DISABLED: ReadonlySet<StampKind> = (() => {
  const out = new Set<StampKind>();
  try {
    const raw = localStorage.getItem("wowsp-stats-prefs");
    if (raw == null) return out;
    const j = JSON.parse(raw) as { sealDisabled?: Record<string, unknown> };
    for (const kind of STAMP_KIND_LIST) {
      if (j?.sealDisabled?.[kind] === true) out.add(kind);
    }
  } catch {
    // unreadable blob → every seal stays visible
  }
  return out;
})();
// The seal glyphs are Chinese calligraphy bitmaps — RatingStamp.tsx renders
// nothing under a non-zh UI locale, and the overlay chips follow suit.
const SEALS_SHOWN = SEALS_ON && locale.startsWith("zh");

// kind → bitmap + Chinese label, copied from RatingStamp.tsx's STAMP_GLYPHS
// (bare DOM cannot reuse that Vue component).
const STAMP_GLYPHS: Record<StampKind, string> = {
  miracle: stampMiracle,
  ape: stampApe,
  maggot: stampMaggot,
  rat: stampRat,
  air: stampAir,
  sub: stampSub,
};
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
// this map shows the bundled glyph; the kind-keyed file name in the stamps
// folder IS the state, so a plain list call is the whole sync.
const CUSTOM_STAMPS: Partial<Record<StampKind, string>> = {};
async function loadCustomStamps(invoke: OverlayTauriApi["core"]["invoke"]) {
  try {
    const files = (await invoke("stamp_list")) as Array<{ kind: string; path: string }>;
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    for (const f of files) {
      if ((STAMP_KIND_LIST as string[]).includes(f.kind)) {
        CUSTOM_STAMPS[f.kind as StampKind] = convertFileSrc(f.path);
      }
    }
  } catch {
    // shell without the stamp commands / no customizations — defaults show
  }
}

let arena: ArenaInfo | null = null;
let anchor: OverlayAnchor | null = null;
// Last TRUSTED row→name mapping seen for the current battle (`dateTime`
// keyed). A fresh anchor arrives before its recognition pass on the very
// first press of a battle and whenever a re-read matched nothing; falling
// back to the arena-index guess then would pin stats onto wrong players
// (the panel re-sorts as ships sink), so the remembered mapping bridges
// the gap instead. Cleared whenever a different battle's roster lands.
let trustedRows: {
  battle: string | null;
  players: (string | null)[];
  alive: boolean[] | null;
} | null = null;
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

function stampImg(kind: StampKind): string {
  if (SEALS_DISABLED.has(kind)) return "";
  const label = STAMP_TEXT[kind];
  const src = CUSTOM_STAMPS[kind] ?? STAMP_GLYPHS[kind];
  return `<img class="overlay-stamp" src="${src}" alt="${label}" title="${label}">`;
}

function chipContent(name: string, side: "ally" | "enemy"): string {
  if (AI_NAME.test(name)) return `<span class="muted">bot</span>`;
  const st = stats.get(cacheKey(name));
  let core: string;
  if (!st) core = `<span class="muted">…</span>`;
  else if (st.hidden) core = `<span class="hidden">●</span>`;
  else if (st.winrate == null) core = `<span class="muted">—</span>`;
  else {
    const wr = `<b style="color:${winrateColor(st.winrate)}">${st.winrate.toFixed(1)}%</b>`;
    const dmg =
      st.avgDamage != null
        ? `<b style="color:${damageColor(st.avgDamage)}">${fmtDamage(st.avgDamage)}</b>`
        : `<b class="muted">—</b>`;
    core = `${wr}<span class="sep">·</span>${dmg}`;
  }
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
    (career ? stampImg(career) : "") +
    (comp?.air ? stampImg("air") : "") +
    (comp?.sub ? stampImg("sub") : "");
  return side === "ally" ? seals + core : core + seals;
}

/** A row→name payload is usable only when at least one row matched —
 *  mirrors the watcher's `mapping_untrusted` bar. An all-null read is
 *  honest silence and must not shadow the remembered mapping. */
function usableRowPlayers(p: (string | null)[] | null | undefined): (string | null)[] | null {
  return p && p.some((n) => n != null) ? p : null;
}

/** The ONE transient-status presentation: a spinner + a single line of
 *  copy, centered over the table. Every "something is settling" notice —
 *  locating, rescanning, recognizing, querying, stale — renders as this
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

/** Rebuild every chip from the current roster + anchor. */
function render() {
  const root = document.body;
  root.textContent = "";
  if (!anchor) return;
  // Battle is on but the table itself wasn't located — show the centered
  // status card instead of chips that would sit on guessed rows. Three
  // copy levels: a surviving stale mark means the update itself is underway
  // (a change was detected, full re-scan running) and gets the
  // change-specific copy; `fallback` is the one state that means a
  // detection was TRIED and failed — the old failure-tone copy;
  // still-searching (or no status event yet) gets the softer "hold Tab,
  // recognizing the roster" copy.
  if (!anchor.tableDetected) {
    root.appendChild(
      statusCard(
        localized(
          anchor.stale ? "staleHint" : statusState === "fallback" ? "locateHint" : "locatingHint",
        ),
      ),
    );
    return;
  }
  if (!arena) return;
  const dpr = window.devicePixelRatio || 1;
  const rows = anchor.rowCenters;
  if (rows.length === 0) return;

  // The anchor carries TWO grid blocks concatenated: allies first, then
  // enemies (asymmetrical battles 12v6 render sub-tables of different
  // heights). Each side maps onto its OWN block — the enemy block starts
  // where the ally block ends.
  const allies = arena.vehicles.filter((v) => v.relation <= 1);
  const enemies = arena.vehicles.filter((v) => v.relation > 1);
  const allyBlock = rows.slice(0, allies.length);
  const enemyBlock = rows.slice(allies.length);
  // Row → name recognition payload (optional, PR 3a): usable only when at
  // least one row matched (the watcher's own trust bar — an all-null read
  // is honest silence). A usable payload is remembered per battle and
  // bridges the gap while a fresh anchor's recognition has not landed yet;
  // only when neither exists do the chips fall back to the legacy index
  // mapping. Alive flags ride along with whichever payload is in force.
  const anchorPlayers = usableRowPlayers(anchor.rowPlayers);
  const players =
    anchorPlayers ??
    (trustedRows && arena.dateTime != null && trustedRows.battle === arena.dateTime
      ? usableRowPlayers(trustedRows.players)
      : null);
  const aliveArr = players
    ? (anchorPlayers ? anchor.rowAlive : trustedRows?.alive) ?? null
    : null;

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
      const el = document.createElement("div");
      let sunk = false;
      let mappedName: string | null = null;
      if (players) {
        const mapped = players[blockOffset + i] ?? null;
        if (mapped != null) {
          // Recognized name — exactly a roster nickname, so the stats
          // cache lookup works unchanged.
          mappedName = mapped;
          el.innerHTML = chipContent(mapped, side);
          sunk = aliveArr?.[blockOffset + i] === false;
        } else {
          // This row's player was not recognized: stay silent rather
          // than pinning stats by index guess.
          el.innerHTML = `<span class="muted">…</span>`;
        }
      } else {
        // No recognition payload — legacy index mapping.
        mappedName = v.name;
        el.innerHTML = chipContent(v.name, side);
      }
      if (mappedName != null && !AI_NAME.test(mappedName) && !stats.has(cacheKey(mappedName))) {
        chipsMissingStats = true;
      }
      el.className =
        `overlay-chip overlay-chip--${side}` + (sunk ? " overlay-chip--sunk" : "");
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

  // Transient-status card, centered over the table, rebuilt on every
  // render: one spinner + the copy of the STRONGEST live state (stale —
  // rows are churning — beats recognizing — attribution unknown — beats
  // querying — numbers in flight). The chips live OUTSIDE the left/right
  // edges, so the card only ever crosses the table's own columns, and it
  // disappears with its trigger on the next event (render() rebuilds from
  // scratch each time). An undetected realm disables the lookups entirely,
  // which leaves the query pipeline inactive — no card for it, by design.
  const statusText = anchor.stale
    ? localized("staleBadge")
    : anchor.rowPlayersPending
      ? localized("recognizingBadge")
      : chipsMissingStats && (pending.size > 0 || inFlight || retryTimer != null)
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
 *  Tab-hold or two, not a half-minute out. */
let inFlight = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = 2000;
const RETRY_DELAY_MAX_MS = 10000;

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
    const results = (await tauri.core.invoke("lookup_players_stats_batch", {
      names,
      realm,
    })) as Array<Stat | null>;
    names.forEach((name, i) => {
      const r = results[i];
      if (r) {
        stats.set(cacheKey(name), {
          winrate: r.winrate ?? null,
          avgDamage: r.avgDamage ?? null,
          pr: r.pr ?? null,
          battles: r.battles ?? null,
          clanId: r.clanId ?? null,
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
          clanId: null,
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
    // capped, doubling pause. The chips honestly stay "…" until a retry
    // lands — never a silently wrong "no data".
    retryTimer = setTimeout(() => {
      retryTimer = null;
      scheduleBatch();
    }, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_DELAY_MAX_MS);
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
      trustedRows = null;
      retryDelayMs = 2000;
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
    // Remember every TRUSTED mapping for this battle (AFTER the arena
    // fallback read above, so the battle key is the real dateTime): a
    // later anchor that arrives before its own recognition lands (fresh
    // press re-pinning, or an all-null re-read) renders from the memory
    // instead of the known-wrong index guess.
    const players = usableRowPlayers(anchor.rowPlayers);
    if (players) {
      trustedRows = {
        battle: arena?.dateTime ?? null,
        players,
        alive: anchor.rowAlive ?? null,
      };
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
}

// Start hidden: the native window is created invisible, but a dev reload or
// a late event could otherwise leave stale content painted over the game.
document.documentElement.classList.add("overlay-hidden");
void start();
