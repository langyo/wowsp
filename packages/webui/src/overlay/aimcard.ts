/**
 * Aim-card window bootstrap — the SECOND transparent overlay window serving
 * the one overlay mode (the Tab-table window's main.ts is the first). Bare
 * DOM like the table page.
 *
 * The card shows the player the crosshair is locked on: the in-game probe
 * latches the aimed avatar every tick (`aim: {name, flags}` in
 * telemetry.json, the same verdict that feeds nothing else anymore — the
 * in-game panel it once powered is retired) and the app's telemetry poller
 * relays it here as `wowsp://ingame-telemetry`. Career figures come through
 * the SAME backend command the table window and the main window use
 * (`lookup_players_stats_batch`), whose process-level session cache makes
 * names those windows already resolved cost zero WG traffic.
 *
 * Content visibility is data-driven and deliberately dumb:
 *   - telemetry fresh + aim.name non-empty → the card renders;
 *   - aim empty, stream stale (30 s, the poller's own staleness rule), or
 *     the battle rolled over → the card empties. The native window's
 *     show/hide is the Rust watcher's job (battle on, Tab up) — this page
 *     only ever draws content.
 *
 * The window itself hangs below the game window's center (the crosshair);
 * placement never crosses into this page.
 */
import { battlesColor, damageColor, prTier, winrateColor } from "@/utils/winrate";
import { AI_NAME } from "@/utils/aiNames";
import { isKnownRealm } from "@/utils/realms";
// Display prefs (the PR-algo param) — the same tolerant read the table page
// uses, so the card's PR can never disagree with the chips' under the
// configured algorithm.
import { readOverlayDisplayPrefs } from "./overlayPrefs";
import "./aimcard.scss";

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

/** Wire shape of one `lookup_players_stats_batch` row (the fields the card
 *  reads; the rest of the row is ignored here). */
interface BatchStat {
  winrate?: number | null;
  avgDamage?: number | null;
  pr?: number | null;
  battles?: number | null;
  clanTag?: string | null;
  hidden: boolean;
}

/** Telemetry payload (the fields the card reads — see Main.py's
 *  write_telemetry for the full body). */
interface TelemetryPayload {
  t?: number;
  battle?: string;
  shipNames?: Record<string, string>;
  self?: { name?: string; realm?: string };
  identity?: Record<string, { account_id?: number; realm?: string }>;
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

/** Whether the current battle is a Clan Battle (军团战) — cross-server
 *  possible, so unreported names ride the backend's cross-realm pass. Same
 *  semantics as the table page's crossRealmBattle. */
let crossRealmBattle = false;

// ── Battle state intake ──────────────────────────────────────────────────

interface ArenaInfo {
  matchGroup?: string | null;
  dateTime?: string | null;
  vehicles: Array<{ name: string }>;
}
let arenaDate: string | null = null;

function resetBattleState() {
  stats.clear();
  pendingClear();
  identityRealms = {};
  rosterNames.clear();
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

// ── Lookup (single name, on demand) ──────────────────────────────────────

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

// ── Formatting (the table page's same conventions) ───────────────────────

function fmtDamage(avg: number): string {
  return avg >= 100000 ? `${Math.round(avg / 1000)}k` : `${(avg / 1000).toFixed(1)}k`;
}

function fmtBattles(n: number): string {
  return n >= 100000 ? `${Math.round(n / 1000)}k` : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** The battle count wearing its locale's unit (split around {n} so the
 *  count stays on the mono face and the unit word drops to the text face —
 *  the table page's battlesText, shrunk to the card's needs; the optional
 *  color rides the figure, the thin-sample red the table chips use). */
function battlesText(n: number, color?: string): string {
  const pattern = localized("battlesCount");
  const at = pattern.indexOf("{n}");
  const style = color ? ` style="color:${color}"` : "";
  const number = `<span class="aim-num"${style}>${fmtBattles(n)}</span>`;
  if (at < 0) return number;
  const unit = (text: string) => (text ? `<span class="aim-unit">${text}</span>` : "");
  return (at > 0 ? unit(pattern.slice(0, at)) : "") + number + unit(pattern.slice(at + 3));
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

function render() {
  const body = document.body;
  if (!aimName) {
    body.innerHTML = "";
    return;
  }
  const s = stats.get(aimName);
  const ship = shipNames[aimName] ?? "";
  const tag = aimClanTag ? `<span class="aim-tag">[${escapeHtml(aimClanTag)}]</span>` : "";
  const head = `<div class="aim-head"><span class="aim-name">${tag}${escapeHtml(aimName)}</span>${
    ship ? `<span class="aim-ship">${escapeHtml(ship)}</span>` : ""
  }</div>`;
  // Every figure degrades to the same em dash the table chips use when the
  // answer hasn't landed or the profile is hidden — never a zero.
  const fig = (inner: string, color?: string) =>
    `<b class="aim-num${color ? "" : " aim-none"}"${color ? ` style="color:${color}"` : ""}>${inner}</b>`;
  const wr = !s || s.hidden ? null : s.winrate;
  const pr = !s || s.hidden ? null : s.pr;
  const battles = !s || s.hidden ? null : s.battles;
  const dmg = !s || s.hidden ? null : s.avgDamage;
  const prBand = prTier(pr);
  const chips = [
    fig(wr != null ? `${wr.toFixed(1)}%` : "—", wr != null ? winrateColor(wr) : undefined),
    fig(pr != null ? `${Math.round(pr)}` : "—", pr != null ? prBand.color : undefined),
    battles != null
      ? battlesText(battles, battlesColor(battles))
      : `<b class="aim-num aim-none">—</b>`,
    fig(dmg != null ? fmtDamage(dmg) : "—", dmg != null ? damageColor(dmg) : undefined),
  ]
    .map((inner) => `<span class="aim-chip">${inner}</span>`)
    .join("");
  body.innerHTML = `<div class="aim-card">${head}<div class="aim-chips">${chips}</div></div>`;
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
    for (const v of a.vehicles) {
      if (!AI_NAME.test(v.name)) rosterNames.add(v.name);
    }
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
    // The verdict itself.
    const next = payload.aim?.name ?? "";
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
  // Freshness watchdog: a dead probe (or Tab held past the poller's stale
  // window) must not leave a stale card hanging under the crosshair —
  // mirror the intake's 30 s rule on a slow interval.
  window.setInterval(() => {
    if (aimName && lastTelemetryAt && Date.now() - lastTelemetryAt > 30_000) {
      aimName = "";
      render();
    }
  }, 5_000);
}

void main();
