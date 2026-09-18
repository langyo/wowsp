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
import { damageColor, winrateColor } from "@/utils/winrate";
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
  /** True when recognition is enabled but this anchor has no trusted
   *  row→name mapping yet (absent, or an all-null read — nothing
   *  matched): a small "recognizing roster" badge renders over the table
   *  until the watcher transplants the mapping onto the pin. */
  rowPlayersPending?: boolean;
}

interface Stat {
  winrate: number | null;
  avgDamage: number | null;
  hidden: boolean;
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

let arena: ArenaInfo | null = null;
let anchor: OverlayAnchor | null = null;
// Latest `wowsp://overlay-status` detection state (mirrors OverlayState on
// the wire; null before the first event). Picks the two-level hint copy:
// only `fallback` is a tried-and-failed state, everything else still reads
// as "locating".
let statusState: string | null = null;
const stats = new Map<string, Stat>();
const pending = new Set<string>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;

const cacheKey = (name: string) => `${realm}:${name}`;

function fmtDamage(avg: number): string {
  return avg >= 100000 ? `${Math.round(avg / 1000)}k` : `${(avg / 1000).toFixed(1)}k`;
}

function chipContent(name: string): string {
  if (AI_NAME.test(name)) return `<span class="muted">bot</span>`;
  const st = stats.get(cacheKey(name));
  if (!st) return `<span class="muted">…</span>`;
  if (st.hidden) return `<span class="hidden">●</span>`;
  if (st.winrate == null) return `<span class="muted">—</span>`;
  const wr = `<b style="color:${winrateColor(st.winrate)}">${st.winrate.toFixed(1)}%</b>`;
  const dmg =
    st.avgDamage != null
      ? `<b style="color:${damageColor(st.avgDamage)}">${fmtDamage(st.avgDamage)}</b>`
      : `<b class="muted">—</b>`;
  return `${wr}<span class="sep">·</span>${dmg}`;
}

/** Rebuild every chip from the current roster + anchor. */
function render() {
  const root = document.body;
  root.textContent = "";
  if (!anchor) return;
  // Battle is on but the table itself wasn't located — show a centered hint
  // box instead of chips that would sit on guessed rows. Two copy levels:
  // `fallback` is the one state that means a detection was TRIED and
  // failed (the centered box IS the failure) — the old failure-tone copy;
  // still-searching (or no status event yet) gets the softer "hold Tab,
  // recognizing the roster" copy.
  if (!anchor.tableDetected) {
    const box = document.createElement("div");
    box.className = "overlay-hint";
    box.textContent = localized(statusState === "fallback" ? "locateHint" : "locatingHint");
    root.appendChild(box);
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
  // Row → name recognition payload (optional, PR 3a): present when the
  // recognizer ran; block offsets mirror the row blocks above.
  const rowPlayers = anchor.rowPlayers ?? null;

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
  for (const [list, side, block, blockOffset] of sides) {
    list.forEach((v, i) => {
      if (block[i] == null) return;
      const el = document.createElement("div");
      el.className = `overlay-chip overlay-chip--${side}`;
      el.style.top = `${block[i] / dpr}px`;
      el.style.fontSize = `${fontSize.toFixed(1)}px`;
      if (side === "ally") {
        // Right edge of the chip just left of the table's left edge.
        el.style.right = `${Math.max(0, overlayW - tableLeft + gap)}px`;
      } else {
        // Left edge of the chip just right of the table's right edge.
        el.style.left = `${tableRight + gap}px`;
      }
      if (rowPlayers) {
        const mapped = rowPlayers[blockOffset + i] ?? null;
        if (mapped != null) {
          // Recognized name — exactly a roster nickname, so the stats
          // cache lookup works unchanged.
          el.innerHTML = chipContent(mapped);
        } else {
          // This row's player was not recognized: stay silent rather
          // than pinning stats by index guess.
          el.innerHTML = `<span class="muted">…</span>`;
        }
      } else {
        // No recognition payload — legacy index mapping.
        el.innerHTML = chipContent(v.name);
      }
      root.appendChild(el);
    });
  }

  // Recognition-enabled but no trusted row→name mapping yet (the arena
  // roster landed after the pin, or the first OCR pass read nothing): a
  // low-key badge at the table's top edge tells the player the chips'
  // attribution is still settling. Disappears on the next anchor event
  // once the watcher transplants the mapping (render() rebuilds from
  // scratch each time). Sits centered over the table's top edge — the
  // chips live OUTSIDE the left/right edges, so nothing is covered but
  // the table's own header band.
  if (anchor.rowPlayersPending) {
    const badge = document.createElement("div");
    badge.className = "overlay-badge";
    badge.style.left = `${(anchor.rosterRect.x + anchor.rosterRect.width / 2) / dpr}px`;
    // `top` is the badge's BOTTOM edge (translateY(-100%) in CSS); clamp
    // so a thin top padding (small roster / high DPR) cannot clip it.
    badge.style.top = `${Math.max(26, anchor.rosterRect.y / dpr - gap)}px`;
    badge.textContent = localized("recognizingBadge");
    root.appendChild(badge);
  }
}

function scheduleBatch() {
  if (!arena || !tauri) return;
  // No detected realm → no lookups; chips stay muted ("…") rather than
  // showing numbers fetched from a guessed realm.
  if (!realm) return;
  for (const v of arena.vehicles) {
    if (AI_NAME.test(v.name)) continue;
    if (!stats.has(cacheKey(v.name))) pending.add(v.name);
  }
  if (pending.size === 0 || batchTimer) return;
  batchTimer = setTimeout(async () => {
    batchTimer = null;
    const names = [...pending];
    pending.clear();
    if (names.length === 0) return;
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
            hidden: r.hidden,
          });
        } else {
          stats.set(cacheKey(name), { winrate: null, avgDamage: null, hidden: false });
        }
      });
      render();
    } catch {
      // WG hiccup — chips show "—" until the next roster update re-queues.
    }
  }, 250);
}

async function start() {
  if (!tauri) return;
  const { core, event } = tauri;
  const invoke = core.invoke;
  const listen = event.listen;

  // Attach ALL listeners before any awaited call — the window may be shown
  // within milliseconds of creation, and an event missed during the await
  // gap would leave the page stuck hidden.
  await listen("wowsp://overlay-visibility", (e: { payload: unknown }) => {
    // The load-bearing hide: the Rust watcher flips the page itself, so
    // content vanishes even when the native window hide is delayed.
    document.documentElement.classList.toggle("overlay-hidden", e.payload !== true);
  });
  await listen("wowsp://arena-info", (e: { payload: unknown }) => {
    arena = e.payload as ArenaInfo;
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
}

// Start hidden: the native window is created invisible, but a dev reload or
// a late event could otherwise leave stale content painted over the game.
document.documentElement.classList.add("overlay-hidden");
void start();
