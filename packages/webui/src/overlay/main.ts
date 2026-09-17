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
const MESSAGES = import.meta.glob<{ locateHint: string }>(
  "../../../../res/i18n/locales/*/overlay.json",
  { eager: true },
);
const hintMessages = new Map<string, string>();
for (const [path, mod] of Object.entries(MESSAGES)) {
  const m = path.match(/locales\/([a-zA-Z-]+)\/overlay\.json$/);
  if (m && mod?.locateHint) hintMessages.set(m[1], mod.locateHint);
}

function localizedHint(): string {
  const exact = hintMessages.get(locale);
  if (exact) return exact;
  const lang = locale.split("-")[0];
  const byLang = [...hintMessages.entries()].find(([k]) => k.split("-")[0] === lang);
  if (byLang) return byLang[1];
  return hintMessages.get("en-US") ?? [...hintMessages.values()][0] ?? "";
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

const realm = new URLSearchParams(window.location.search).get("realm") || "asia";
// App locale forwarded by create_overlay_window — picks the hint copy.
const locale = new URLSearchParams(window.location.search).get("locale") || "en-US";

let arena: ArenaInfo | null = null;
let anchor: OverlayAnchor | null = null;
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
  // box instead of chips that would sit on guessed rows.
  if (!anchor.tableDetected) {
    const box = document.createElement("div");
    box.className = "overlay-hint";
    box.textContent = localizedHint();
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

  const sides: Array<[Vehicle[], "ally" | "enemy", number[]]> = [
    [allies, "ally", allyBlock],
    [enemies, "enemy", enemyBlock],
  ];
  for (const [list, side, block] of sides) {
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
      el.innerHTML = chipContent(v.name);
      root.appendChild(el);
    });
  }
}

function scheduleBatch() {
  if (!arena || !tauri) return;
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
