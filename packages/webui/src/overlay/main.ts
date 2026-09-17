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

  const pitch = rows.length >= 2 ? Math.abs(rows[1] - rows[0]) / dpr : 24;
  const fontSize = Math.min(15, Math.max(9, pitch * 0.42));
  const inset = Math.max(6, Math.round(pitch * 0.12 * dpr)) / dpr;
  const splitX = anchor.rosterRect.x + anchor.rosterRect.width * anchor.teamSplit;
  const alliesRight = (splitX - inset) / 1; // CSS px
  const enemiesLeft = (splitX + inset) / 1;
  const overlayW = anchor.overlayRect.width / dpr;

  const sides: Array<[Vehicle[], "ally" | "enemy"]> = [
    [arena.vehicles.filter((v) => v.relation <= 1), "ally"],
    [arena.vehicles.filter((v) => v.relation > 1), "enemy"],
  ];
  for (const [list, side] of sides) {
    list.forEach((v, i) => {
      if (rows[i] == null) return;
      const el = document.createElement("div");
      el.className = `overlay-chip overlay-chip--${side}`;
      el.style.top = `${rows[i] / dpr}px`;
      el.style.fontSize = `${fontSize.toFixed(1)}px`;
      if (side === "ally") {
        el.style.right = `${Math.max(0, overlayW - alliesRight)}px`;
      } else {
        el.style.left = `${enemiesLeft}px`;
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
  await listen("wowsp://arena-info", (e: { payload: unknown }) => {
    arena = e.payload as ArenaInfo;
    scheduleBatch();
  });
  await listen("wowsp://overlay-anchor", async (e: { payload: unknown }) => {
    anchor = e.payload as OverlayAnchor;
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
}

void start();
