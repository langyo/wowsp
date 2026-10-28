/**
 * Aim-card window bootstrap — the SECOND transparent overlay window serving
 * the one overlay mode (the Tab-table window's main.ts is the first). Bare
 * DOM like the table page.
 *
 * The card shows the player the crosshair is locked on, as FOUR stacked
 * lines (the tab table's own face, shrunken to one player):
 *   1. the clan tag + nickname;
 *   2. the career (overall average) figures;
 *   3. the per-ship figures for the ship that player is sailing THIS
 *      battle — the same `lookup_player_ship_stats` facility the table
 *      window's ship-scoped columns use, sharing its process-lifetime
 *      session cache so both windows together still cost ONE WG request
 *      per player;
 *   4. the seal cluster — the SAME verdict stamps the tab chips flank
 *      their numbers with (career verdict through the hidden-profile clan
 *      gate + composition tags through the shared merge rule), as one
 *      horizontal line. Chinese-locale faces only, like the table's.
 *
 * Data intake (unchanged contract): the in-game probe latches the aimed
 * avatar every tick (`aim: {name, flags}` in telemetry.json) and the app's
 * telemetry poller relays it here as `wowsp://ingame-telemetry`. Career
 * figures come through the SAME backend command the table window and the
 * main window use (`lookup_players_stats_batch`), whose process-level
 * session cache makes names those windows already resolved cost zero WG
 * traffic.
 *
 * The text face is the TAB TABLE's own size: the same row-pitch formula
 * the table's chips derive from the game's Tab geometry
 * (min(15, max(9, pitch * 0.42))), fed by the `wowsp://overlay-anchor`
 * event the backend already broadcasts to every overlay window on each
 * Tab press; until the first anchor of the session the card wears the
 * table's own fallback pitch. One root font-size drives every line (all
 * inner sizes are em).
 *
 * The card block hugs its content — the native window is a fixed 380×120
 * bounding box, but the dark glass wraps only the drawn lines (the box's
 * remainder stays transparent), so a bare card never paints a tall empty
 * slab.
 *
 * Content visibility is data-driven and deliberately dumb:
 *   - telemetry fresh + aim.name non-empty → the card renders;
 *   - aim empty, stream stale (30 s, the poller's own staleness rule), or
 *     the battle rolled over → the card empties;
 *   - a target judged AI renders NOTHING — not even a bare-headed name
 *     (see aimDisplayName: the AI-name styles plus the probe's bridged
 *     `bots` list, which catches the event PvEvP bots sailing under
 *     normal nicknames; mixed bot+human enemy teams keep the window up
 *     and show the humans only).
 *     The native window's show/hide is the Rust watcher's job (battle
 *     on, Tab up; a PvE battle or an all-AI enemy side — co-op,
 *     asymmetric fills, rooms vs bots — keeps the window down for its
 *     whole duration) — this page only ever draws content.
 *
 * The window itself hangs below the game window's center (the crosshair);
 * placement never crosses into this page.
 */
import { clanWinrateKey, lookupClanWinrate } from "@/utils/clanWinrate";
import { AI_NAME } from "@/utils/aiNames";
import { isKnownRealm } from "@/utils/realms";
import { careerStamp, type CareerStamp, type StampKind } from "@/utils/winrate";
// Display prefs — the same tolerant read the table page uses, so the
// card's PR can never disagree with the chips' under the configured
// algorithm, and the seal kill switches gate the same kinds.
import { effectiveOverlayColumns, readOverlayDisplayPrefs } from "./overlayPrefs";
import {
  aimDisplayName,
  careerLineHtml,
  sealLineHtml,
  shipLineHtml,
  type AimComposition,
  type AimShipRow,
  type BatchStat,
  type SealLineOptions,
  STAMP_TEXT,
} from "./aimcardLines";
import { installNativeMenuBlock } from "@/utils/nativeMenu";
import "./aimcard.scss";

// Desktop surface: never show the WebView's own context menu.
installNativeMenuBlock();

// The one locale string the card needs: the battle-count unit pattern
// ("{n} 场" / "{n} battles") — same files, same {n} placeholder contract
// (scripts/check_i18n.py enforces it) as the table page's copy.
interface OverlayMessages {
  battlesCount: string;
}
const MESSAGES = import.meta.glob<OverlayMessages>(
  "../../../../res/i18n/locales/*/overlay.json",
  { eager: true },
);
const messages = new Map<string, OverlayMessages>();
for (const [path, mod] of Object.entries(MESSAGES)) {
  const m = path.match(/locales\/([a-zA-Z-]+)\/overlay\.json$/);
  if (m && mod?.battlesCount) messages.set(m[1], mod);
}
const locale = new URLSearchParams(window.location.search).get("locale") || "en-US";
function localized(key: keyof OverlayMessages): string {
  const exact = messages.get(locale)?.[key];
  if (exact) return exact;
  const lang = locale.split("-")[0];
  const byLang = [...messages.entries()].find(([k]) => k.split("-")[0] === lang);
  if (byLang) return byLang[1][key];
  return messages.get("en-US")?.[key] ?? [...messages.values()][0]?.[key] ?? "";
}

interface OverlayTauriApi {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: {
    listen: (ev: string, h: (e: { payload: unknown }) => void) => Promise<() => void>;
  };
}
const tauri = (window as unknown as { __TAURI__?: OverlayTauriApi }).__TAURI__;

// ── Player markers (玩家标记) ── the aim head carries the same colored dot
// the Tab table's rows do ("旁边多一个点"). Fetched lazily through the same
// bare invoke the table page uses; wowsp://markers-changed re-fetches when
// the main window edits the list mid-session.
type OverlayMarkerColor = "red" | "yellow" | "purple";
const markersByNickname = new Map<string, OverlayMarkerColor>();
const markersByAccountId = new Map<number, OverlayMarkerColor>();
let markersLoaded = false;
let markersLoading = false;
let markersFailedAt = 0;
/** An edit arrived while the initial fetch was in flight — refetch when
 *  it settles (see the changed listener). */
let markersDirty = false;
const MARKERS_RETRY_MS = 60_000;

function normNick(name: string): string {
  return name.trim().toLowerCase();
}

function ensureMarkers(): void {
  if (markersLoaded || markersLoading) return;
  if (markersFailedAt !== 0 && Date.now() - markersFailedAt < MARKERS_RETRY_MS) return;
  if (!tauri) {
    markersLoaded = true; // browser dev: no markers, no fetches
    return;
  }
  markersLoading = true;
  void (async () => {
    try {
      const list = (await tauri.core.invoke("markers_list")) as Array<{
        nickname: string;
        color: OverlayMarkerColor;
        accountId?: number | null;
      }>;
      markersByNickname.clear();
      markersByAccountId.clear();
      for (const entry of list ?? []) {
        markersByNickname.set(normNick(entry.nickname), entry.color);
        if (entry.accountId != null) {
          markersByAccountId.set(entry.accountId, entry.color);
        }
      }
      markersLoaded = true;
      render();
    } catch {
      // Cooldown like the Tab table's loader: a dead backend must not be
      // retried on every render frame.
      markersFailedAt = Date.now();
    } finally {
      markersLoading = false;
      if (markersDirty) {
        markersDirty = false;
        markersLoaded = false;
        ensureMarkers();
      }
    }
  })();
}

/** The marker color for the aim target — nickname first, account id second. */
function markerColorOf(
  name: string,
  accountId: number | null | undefined,
): OverlayMarkerColor | null {
  if (AI_NAME.test(name)) return null;
  return (
    markersByNickname.get(normNick(name)) ??
    (accountId != null ? (markersByAccountId.get(accountId) ?? null) : null)
  );
}

/** Telemetry payload (the fields the card reads — see Main.py's
 *  write_telemetry for the full body). */
interface TelemetryPayload {
  t?: number;
  battle?: string;
  shipNames?: Record<string, string>;
  self?: { name?: string; realm?: string };
  identity?: Record<string, { account_id?: number; realm?: string }>;
  /** The game's own AI verdicts this battle (the records' isBot rows +
   *  scripted-name styles, bridged by the probe). Absent = the probe
   *  build predates the bridge; the AI-name styles alone carry the
   *  judgment then. */
  bots?: string[];
  aim?: { name?: string; flags?: number };
}

// ── State ────────────────────────────────────────────────────────────────

// Realm gates every lookup ("no realm, no guesses" — the table page's
// rule): the window URL's detected realm, unlocked by the probe's
// ground-truth self realm when absent.
let realm = new URLSearchParams(window.location.search).get("realm") ?? "";
// Ground-truth per-name clusters (the realm-reporting probe), reset per
// battle so rows of the previous battle cannot bleed into the routing.
let identityRealms: Record<string, string> = {};
let identityBattle = "";
// Roster names worth resolving (bots `:Name:` have no WG account).
const rosterNames = new Set<string>();
// Names the game itself flags as AI this battle (the probe's `bots`
// bridge): event PvEvP bots sail under NORMAL nicknames the roster's
// AI-name filter cannot catch. Replaced wholesale per frame; reset per
// battle with the rest of the intake state.
let botNames = new Set<string>();
let shipNames: Record<string, string> = {};
// The latched verdict + the freshness stamp.
let aimName = "";
let aimClanTag: string | null = null;
let lastTelemetryAt = 0;

// Career cache (per battle) + the single in-flight lookup for the current
// aim. Rapid aim switching only ever fetches the LATEST name: the landing
// answer is dropped when the aim moved on (generation check below).
const stats = new Map<string, BatchStat | null>();
let fetchGen = 0;
let inFlight = false;
let refetchTimer: number | undefined;

// Per-ship lists (per battle), keyed `${realm}:${accountId}`: undefined =
// not fetched yet, null = the one attempt this battle failed (or the
// backend answered nothing). The fetch rides sessionCache so the table
// window's list answers here for free (and vice versa).
const shipsByAccount = new Map<string, AimShipRow[] | null>();
let shipsInFlight = false;

// Composition seals, keyed by name — success values (including null, the
// backend's per-name "no data") cache per battle; a failed call stays
// uncached and re-arms only when the crosshair re-enters the name.
const compositions = new Map<string, AimComposition | null>();
let compInFlight = false;

// Hidden-profile 过街老鼠 clan gate, keyed `${realm}:${clanId}` — the
// table page's same map shape (two hidden clanmates share one verdict,
// and the shared lookupClanWinrate module dedupes them onto one
// clans/info request). An ABSENT key = verdict not in yet → the seal
// line holds; a stored null = the lookup failed → fail-open stamp.
const clanWinrates = new Map<string, number | null>();
const clanGateOut = new Set<string>();

// The user's custom seal pictures (kind → asset URL), synced from the
// stamps folder exactly like the table page: read once at startup and
// re-read on `wowsp://stamps-changed`. A kind absent here shows the
// plain text seal.
const customStamps: Partial<Record<StampKind, string>> = {};
let stampsSequence = 0;

// The card's text face, derived from the game's Tab row pitch — the
// table page's exact formula, latched from the anchor event. null = wear
// the fallback pitch (the table's own default) until the first anchor.
const FALLBACK_PITCH = 24;
let anchorPitch: number | null = null;

/** Whether the current battle is a Clan Battle (军团战) — cross-server
 *  possible, so unreported names ride the backend's cross-realm pass. Same
 *  semantics as the table page's crossRealmBattle. */
let crossRealmBattle = false;

// ── Battle state intake ──────────────────────────────────────────────────

interface ArenaInfo {
  matchGroup?: string | null;
  dateTime?: string | null;
  vehicles: Array<{ name: string; shipId?: number }>;
}
let arenaDate: string | null = null;
let arenaVehicles: Array<{ name: string; shipId?: number }> = [];

/** The battle ship's id for a nickname (the arena's vehicles carry it —
 *  per-ship scoping keys off the ship that player is sailing THIS
 *  battle). Same scan-per-call convention as the table page. */
function shipIdOfName(name: string): number | null {
  for (const v of arenaVehicles) {
    if (v.name === name) return v.shipId ?? null;
  }
  return null;
}

function resetBattleState() {
  // Invalidate any fetch still straddling the switch: a career landing
  // from the previous battle must not answer the new one's first aim of
  // the same name (its clan tag rides the landing).
  fetchGen += 1;
  stats.clear();
  shipsByAccount.clear();
  compositions.clear();
  clanWinrates.clear();
  clanGateOut.clear();
  pendingClear();
  identityRealms = {};
  rosterNames.clear();
  botNames = new Set();
  aimName = "";
  aimClanTag = null;
  render();
}

function pendingClear() {
  if (refetchTimer !== undefined) {
    clearTimeout(refetchTimer);
    refetchTimer = undefined;
  }
}

// ── Career lookup (single name, on demand) ───────────────────────────────

function scheduleAimFetch() {
  if (!tauri || !realm || !aimName) return;
  // An in-flight fetch needs no timer here: its `finally` re-arms for
  // whatever is aimed by the time it lands (the superseded-aim case).
  if (stats.has(aimName) || inFlight || refetchTimer !== undefined) return;
  refetchTimer = window.setTimeout(runAimFetch, 120);
}

async function runAimFetch() {
  refetchTimer = undefined;
  const name = aimName;
  if (!tauri || !realm || !name || inFlight || stats.has(name)) return;
  inFlight = true;
  const gen = fetchGen;
  let threw = false;
  try {
    // Per-name realm routing: the probe-reported cluster resolves with the
    // cross pass OFF (the realm is known — probing would be guessing); an
    // unreported name rides the window realm + the cross pass (Clan
    // Battles can be cross-server — the table page's same rule).
    const reported = identityRealms[name];
    const prAlgo = readOverlayDisplayPrefs().prAlgo;
    const results = (await tauri.core.invoke("lookup_players_stats_batch", {
      names: [name],
      realm: reported ?? realm,
      // camelCase key (Tauri v2 ArgumentCase::Camel) — the snake_case
      // spelling is silently dropped (the table page's same comment).
      ...(prAlgo != null ? { prAlgo } : {}),
      ...(!reported && crossRealmBattle ? { crossRealm: true } : {}),
    })) as Array<BatchStat | null>;
    if (gen !== fetchGen) return;
    const r = results[0] ?? null;
    stats.set(
      name,
      r ?? { winrate: null, avgDamage: null, pr: null, battles: null, hidden: false },
    );
    if (r?.clanTag) aimClanTag = r.clanTag;
    // The landed row feeds the three dependent lines: the per-ship list,
    // the composition verdict and (hidden profiles with a clan) the rat
    // gate. All three re-render on their own landing.
    scheduleShipFetch(name);
    scheduleCompFetch(name);
    scheduleClanGate(name);
  } catch {
    // Transport hiccup: leave uncached — the finally below applies the
    // no-retry-loop rule (re-arm only for a name no longer aimed).
    threw = true;
  } finally {
    inFlight = false;
    if (gen === fetchGen) render();
    // Re-arm whenever the crosshair sits on a name this fetch didn't
    // answer: the superseded-aim case (the answer dropped by the
    // generation check, or the fetch thrown for a name no longer aimed)
    // would otherwise leave the new name on dashes until the target
    // cycles. A throw for the CURRENT aim keeps the no-retry-loop rule —
    // the next aim event re-runs the fetch, and one missing card
    // degrades to "—".
    if (
      refetchTimer === undefined &&
      aimName &&
      !stats.has(aimName) &&
      (!threw || aimName !== name)
    ) {
      scheduleAimFetch();
    }
  }
}

// ── Per-ship lookup (the battle ship's line) ─────────────────────────────

function scheduleShipFetch(name: string) {
  if (!tauri || !realm) return;
  const st = stats.get(name);
  if (!st || st.hidden || st.accountId == null) return;
  const accountId = st.accountId;
  const entryRealm = st.realm ?? realm;
  const key = `${entryRealm}:${accountId}`;
  if (shipsByAccount.has(key) || shipsInFlight) return;
  shipsInFlight = true;
  void (async () => {
    try {
      const prAlgo = readOverlayDisplayPrefs().prAlgo;
      const ships = (await tauri!.core.invoke("lookup_player_ship_stats", {
        accountId,
        realm: entryRealm,
        // camelCase keys (ArgumentCase::Camel) — see runAimFetch.
        ...(prAlgo != null ? { prAlgo } : {}),
        // The shared read-through cache: the table window's ship-scoped
        // columns fetch the same player's list — whoever asks first pays.
        sessionCache: true,
      })) as AimShipRow[];
      // Cache REGARDLESS of the aim generation: the list is keyed by
      // account (aim-independent) and session-stable, so a landed answer
      // serves whichever name the crosshair sits on now — discarding it
      // would leave that player's line on dots until the target cycled.
      shipsByAccount.set(key, ships ?? null);
    } catch {
      // One attempt per account per battle (the table pipeline's same
      // budget): cache the null verdict so the card does not re-probe a
      // hard-down API on every aim tick; the battle switch clears it.
      shipsByAccount.set(key, null);
    } finally {
      shipsInFlight = false;
      // Render and re-arm REGARDLESS of the aim generation: the cache is
      // aim-independent, and the bounced aim may be a NEWER generation
      // than this landing — gating here is exactly what would leave that
      // player's line on dots until the target cycled.
      render();
      const cur = aimName ? stats.get(aimName) : undefined;
      if (
        cur &&
        !cur.hidden &&
        cur.accountId != null &&
        !shipsByAccount.has(`${cur.realm ?? realm}:${cur.accountId}`)
      ) {
        scheduleShipFetch(aimName);
      }
    }
  })();
}

// ── Composition + clan gate (the seal line) ──────────────────────────────

/** The seal pipeline's master gate, the table page's same rule: the prefs
 *  switch AND the Chinese locales (the seal vocabulary is CJK wordplay —
 *  an English face has no wording for it). */
function sealsShown(): boolean {
  return readOverlayDisplayPrefs().sealsOn && locale.startsWith("zh");
}

function scheduleCompFetch(name: string) {
  if (!tauri || !realm || !sealsShown() || compInFlight) return;
  if (compositions.has(name)) return;
  const st = stats.get(name);
  // Only resolvable profiles get a composition verdict: a hidden one is
  // ungradeable (the rat verdict stands alone) and AI names have none.
  if (!st || st.hidden) return;
  compInFlight = true;
  let threw = false;
  void (async () => {
    try {
      const results = (await tauri!.core.invoke("lookup_players_composition", {
        names: [name],
        realm,
      })) as Array<AimComposition | null>;
      // Cache REGARDLESS of the aim generation: the verdict is keyed by
      // name (aim-independent) and battle-stable — discarding a landed
      // answer would leave the re-aimed name's merged seals unfetchable
      // (its career row is already cached, so nothing re-asks).
      compositions.set(name, results[0] ?? null);
    } catch {
      // Leave uncached: ONE attempt per name per battle (re-entry cannot
      // re-arm — the career row is cached by then), the same budget the
      // per-ship lane keeps. A seal is decoration; the next battle re-asks.
      threw = true;
    } finally {
      compInFlight = false;
      // Render and re-arm REGARDLESS of the aim generation: the bounced
      // aim may be a NEWER generation than this landing. The re-arm fires
      // only after a CLEAN landing for a name that still lacks a verdict
      // (a throw must not re-run against a hard-down API — no loop).
      render();
      const cur = aimName ? stats.get(aimName) : undefined;
      if (!threw && aimName && cur && !cur.hidden && !compositions.has(aimName)) {
        scheduleCompFetch(aimName);
      }
    }
  })();
}

function scheduleClanGate(name: string) {
  if (!tauri || !realm || !sealsShown()) return;
  const st = stats.get(name);
  if (!st?.hidden || st.clanId == null) return;
  // Cross-server rows resolved on a foreign cluster gate on THAT realm's
  // clans/info (the table page's same key).
  const key = clanWinrateKey(st.realm ?? realm, st.clanId);
  if (clanWinrates.has(key) || clanGateOut.has(key)) return;
  clanGateOut.add(key);
  void lookupClanWinrate(st.realm ?? realm, st.clanId).then((wr) => {
    clanGateOut.delete(key);
    // Only the first verdict for a clan wins the slot — later duplicates
    // (there shouldn't be any) must not resurrect a failed verdict.
    if (!clanWinrates.has(key)) clanWinrates.set(key, wr);
    render();
  });
}

// ── Custom seal pictures ─────────────────────────────────────────────────

async function loadCustomStamps() {
  if (!tauri) return;
  const sequence = ++stampsSequence;
  try {
    const files = (await tauri.core.invoke("stamp_list")) as Array<{
      kind: string;
      path: string;
    }>;
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    // Rebuild wholesale (the table page's same rule): the listing IS the
    // state, and a reset deletes the kind's file — a merge-only update
    // would keep the reset kind's stale URL rendering a dead image
    // instead of falling back to the text seal.
    const next: Partial<Record<StampKind, string>> = {};
    for (const f of files) {
      if ((Object.keys(STAMP_TEXT) as string[]).includes(f.kind)) {
        next[f.kind as StampKind] = convertFileSrc(f.path);
      }
    }
    // A newer import/reset owns the display even if this read finishes last.
    if (sequence !== stampsSequence) return;
    for (const key of Object.keys(customStamps) as StampKind[]) {
      if (next[key] === undefined) delete customStamps[key];
    }
    Object.assign(customStamps, next);
    render();
  } catch {
    // No stamps command / no customizations — the text seals stand.
  }
}

// ── Render ───────────────────────────────────────────────────────────────

/** HTML-escape one game-controlled string (roster names and ship names are
 *  game data, the clan tag comes off the WG answer) — the table page's
 *  same convention, body copied verbatim. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** The career verdict for the aimed name, or `"held"` while a hidden
 *  profile's clan verdict is still owed — the table page's rule: a stamp
 *  that flashes first and retracts a beat later is worse than none. */
function careerVerdictFor(name: string): CareerStamp | null | "held" {
  const st = stats.get(name);
  if (!st) return null;
  const clanId = st.hidden ? st.clanId : null;
  const verdict =
    clanId != null ? clanWinrates.get(clanWinrateKey(st.realm ?? realm, clanId)) : undefined;
  if (clanId != null && verdict === undefined) return "held";
  return careerStamp(st.pr, st.battles, st.winrate, st.hidden, verdict);
}

function render() {
  const body = document.body;
  if (!aimName) {
    body.innerHTML = "";
    return;
  }
  const prefs = readOverlayDisplayPrefs();
  ensureMarkers();
  const s = stats.get(aimName);
  const markerColor = markerColorOf(aimName, s?.accountId);
  // The optional K/D figure rides exactly when the user configured a K/D
  // column — the same prefs the tab table's chips read, so the two faces
  // never disagree about which figures exist. The check runs over the
  // EFFECTIVE columns (what the table actually renders): the PR master
  // switch cannot hide a K/D column (only PR columns drop), so today the
  // effective read equals the raw one — the effective form simply stays
  // true the day any other metric gains a master switch of its own.
  const kdOn = effectiveOverlayColumns(prefs.columns, prefs.prOn).some(
    (c) => c.metric === "kd",
  );
  const tag = aimClanTag ? `<span class="aim-tag">[${escapeHtml(aimClanTag)}]</span>` : "";
  const mk = markerColor
    ? `<span class="aim-mk aim-mk--${markerColor}"></span>`
    : "";
  const head = `<div class="aim-head"><span class="aim-name">${tag}${escapeHtml(aimName)}${mk}</span></div>`;
  const pattern = localized("battlesCount");
  // Line 3 needs the stats row (account id) and the battle ship id; the
  // readable label prefers the per-ship row's own name (the encyclopedia
  // map's), falling back to the telemetry's roster ship name.
  const shipId = shipIdOfName(aimName);
  const entryRealm = s?.realm ?? realm;
  const ships =
    s?.accountId != null ? shipsByAccount.get(`${entryRealm}:${s.accountId}`) : undefined;
  const shipRow = ships?.find((r) => r.shipId === shipId) ?? null;
  const shipLabel = shipRow?.name ?? shipNames[aimName] ?? "";
  // Lines 2+3 share ONE column grid (one .aim-grid — four tracks, five
  // while the K/D figure rides; the ship cells simply absent when the line
  // doesn't apply) so the two figure rows read as aligned columns
  // regardless of each row's digit count.
  let shipCells = "";
  if (shipId != null && s && !s.hidden && s.accountId != null && shipLabel) {
    shipCells = shipLineHtml(
      ships,
      shipId,
      escapeHtml(shipLabel),
      pattern,
      // The shared clock phase-locks the dots' chase across rebuilds.
      performance.now(),
      kdOn,
    );
  }
  // The seal line: the career verdict through the clan gate + the
  // composition tags, the table chips' same merge. A held verdict renders
  // nothing yet (no flash-then-retract). No AI guard needed here — the
  // intake already empties aimName for every judged-AI target.
  let sealLine = "";
  if (sealsShown()) {
    const verdict = careerVerdictFor(aimName);
    if (verdict !== "held") {
      const html = sealLineHtml(verdict, compositions.get(aimName) ?? null, {
        disabled: prefs.sealsDisabled,
        custom: customStamps,
      } satisfies SealLineOptions);
      if (html) sealLine = `<div class="aim-seals">${html}</div>`;
    }
  }
  // One root font-size drives every line: the tab table's own face — the
  // anchor's row pitch while one is known, the table's fallback pitch
  // until then (same formula, same clamp).
  const pitch = anchorPitch ?? FALLBACK_PITCH;
  const fontSize = Math.min(15, Math.max(9, pitch * 0.42));
  body.innerHTML =
    `<div class="aim-card" style="font-size:${fontSize.toFixed(1)}px">` +
    `${head}` +
    // --aim-cols widens the shared figure grid to five tracks while the
    // K/D figure rides (see the SCSS); the two rows stay one alignment.
    `<div class="aim-grid" style="--aim-cols:${kdOn ? 5 : 4}">` +
    `${careerLineHtml(s, pattern, kdOn)}${shipCells}` +
    `</div>` +
    `${sealLine}` +
    `</div>`;
}

// ── Wiring ───────────────────────────────────────────────────────────────

async function main() {
  if (!tauri) return;
  const { listen } = tauri.event;
  // Listeners attach before anything else (the window can be shown within
  // ms of creation — the table page's rule).
  await listen("wowsp://arena-info", (e: { payload: unknown }) => {
    const a = e.payload as ArenaInfo | null;
    if (!a) return;
    // A new battle (fresh arena snapshot) resets the card's per-battle
    // state; same-date re-reads are no-ops.
    if (a.dateTime && a.dateTime !== arenaDate) {
      arenaDate = a.dateTime;
      resetBattleState();
    }
    crossRealmBattle = (a.matchGroup ?? "").toLowerCase().includes("clan");
    arenaVehicles = a.vehicles ?? [];
    for (const v of arenaVehicles) {
      if (!AI_NAME.test(v.name)) rosterNames.add(v.name);
    }
    // A snapshot carrying shipIds arms the per-ship line for an aim that
    // latched before the arena read.
    render();
  });
  await listen("wowsp://ingame-telemetry", (e: { payload: unknown }) => {
    const payload = e.payload as TelemetryPayload | null;
    if (!payload?.t || Date.now() - payload.t > 30_000) return;
    lastTelemetryAt = payload.t;
    if (payload.shipNames) shipNames = payload.shipNames;
    // The battle-id flip check comes FIRST, against the PRE-identity
    // stamp: a new battle invalidates the per-battle caches (and the
    // identity map with them) even when no arena snapshot preceded it
    // (roster still warming up) — doing this after the identity block
    // would never observe the flip, because that block restamps
    // identityBattle itself.
    if (payload.battle && payload.battle !== identityBattle) {
      identityBattle = payload.battle;
      resetBattleState();
    }
    // Ground-truth realms (the probe's identity map) + the self-realm
    // unlock, mirroring the table page's intake.
    if (payload.identity) {
      const map: Record<string, string> = { ...identityRealms };
      for (const [name, row] of Object.entries(payload.identity)) {
        const code = (row?.realm ?? "").trim().toLowerCase();
        if (isKnownRealm(code)) map[name] = code;
      }
      identityRealms = map;
      const selfCode = (payload.self?.realm ?? "").trim().toLowerCase();
      if (isKnownRealm(selfCode) && !realm) {
        realm = selfCode;
        scheduleAimFetch();
      }
    }
    // The game's own AI verdicts (the records' isBot rows + scripted
    // name styles), replaced wholesale — the list is re-derived from the
    // full record set every tick, so a replace is self-healing. Absent
    // field = no fresh verdict this frame (a probe build predating the
    // bridge, or the write's fail-safe body): the previous set stands,
    // and the name-style half of aimDisplayName carries the judgment
    // alone there.
    if (payload.bots) botNames = new Set(payload.bots);
    // The verdict itself, through the bot gate: a judged-AI target
    // renders nothing at all — not even a bare-headed name.
    const next = aimDisplayName(payload.aim?.name ?? "", botNames);
    if (next !== aimName) {
      aimName = next;
      aimClanTag = null;
      if (aimName) {
        // Only real roster names resolve; a verdict outside the roster
        // (transient entity, the self avatar) renders bare-headed and
        // skips the WG lookup entirely.
        if (rosterNames.size === 0 || rosterNames.has(aimName)) scheduleAimFetch();
      }
      fetchGen += 1;
      render();
    } else {
      render();
    }
  });
  // The tab table's geometry rides the anchor the backend already
  // broadcasts to every overlay window on each Tab press — the card's
  // text face IS the table's face. One latch is enough (the pitch never
  // changes mid-session); later anchors just re-confirm it. The pitch
  // measures the first two rows, which are ALLY rows (rowCenters is
  // allies-first; the table page's allyBlock does the same) — with fewer
  // than two ally rows the first gap spans the team split, and the card
  // falls back to the table's default pitch instead of measuring across
  // two different sub-tables.
  await listen("wowsp://overlay-anchor", (e: { payload: unknown }) => {
    const a = e.payload as {
      rowCenters?: number[];
      teamSplit?: number;
      tableDetected?: boolean;
    } | null;
    if (!a?.rowCenters || a.tableDetected === false) return;
    // teamSplit is the ally block's FRACTION of the rows (0.2..=1.0 on
    // the wire) — derive the ally-row count from it.
    const allyRows = Math.round((a.teamSplit ?? 0) * a.rowCenters.length);
    if (allyRows < 2 || a.rowCenters.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const pitch = Math.abs(a.rowCenters[1] - a.rowCenters[0]) / dpr;
    if (!Number.isFinite(pitch) || pitch <= 0) return;
    anchorPitch = pitch;
    render();
  });
  // The stamps folder and the display prefs live-broadcast their writes —
  // the card keeps pace with the table window (a seal customization or a
  // PR-algorithm flip applies to the live card, not only the next one).
  await listen("wowsp://stamps-changed", () => {
    void loadCustomStamps();
  });
  await listen("wowsp://stats-prefs-changed", () => {
    render();
  });
  // The marker list changed (main-window add/remove): re-fetch and repaint —
  // the aim dot must track the list mid-session.
  await listen("wowsp://markers-changed", () => {
    markersLoaded = false;
    markersFailedAt = 0;
    markersDirty = true;
    ensureMarkers();
  });
  // Freshness watchdog: a dead probe (or Tab held past the poller's stale
  // window) must not leave a stale card hanging under the crosshair —
  // mirror the intake's 30 s rule on a slow interval.
  window.setInterval(() => {
    if (aimName && lastTelemetryAt && Date.now() - lastTelemetryAt > 30_000) {
      aimName = "";
      render();
    }
  }, 5_000);
  // The card's own initial reads: whatever custom seals exist already.
  await loadCustomStamps();
}

void main();
