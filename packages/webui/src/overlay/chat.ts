/**
 * Battle-chat translation card bootstrap — the THIRD transparent overlay
 * window (the Tab-table window's main.ts is the first, the aim card's
 * aimcard.ts the second). Bare DOM like its siblings.
 *
 * The card shows the recent battle-chat lines' translations at the bottom-
 * left of the game screen while the player HOLDS Tab. The native window's
 * show/hide is the Rust watcher's job (battle known + the chat card enabled
 * in the overlay settings + Tab down); this page only ever paints what it
 * was last handed, and paints NOTHING when it has no lines (the window is
 * fully transparent then — no card, no border, no empty shell).
 *
 * Data intake (the bridge's wire contract):
 *   - `wowsp://chat-translate` — `{ battle, lines, maxLines }`: the new
 *     translated lines since the previous event (append-only within one
 *     battle — the buffer keeps the newest `maxLines`), the battle's stable
 *     id, and the card's current line cap. A DIFFERENT `battle` id starts a
 *     new battle and clears everything first, so a late line of a finished
 *     battle can never leak into the next one.
 *   - `wowsp://chat-prefs` — `{ maxLines }`: the settings' live line-cap
 *     flip (the watcher re-reads the config every tick; this event keeps the
 *     page in step without waiting for the next line).
 * A line is `{ id, t, from, ns, lang, text, translated }`: `lang` is the
 * translation's BCP-47 target tag (it rides the row's `lang` attribute, so a
 * CJK/Cyrillic mix renders with the right face), `from` the sender's
 * nickname (drawn muted, omitted when empty), and `translated` the translated
 * body — when it is empty the original `text` is drawn instead, so a line
 * still reads while its translation is pending.
 *
 * DOM safety: chat text is arbitrary player input, so this page NEVER builds
 * markup — one element per line, `textContent` only, no innerHTML anywhere.
 * Each line body clamps to two rows (see chat.scss).
 */
import "./chat.scss";

/** One translated chat line from the bridge (the fields this page reads). */
interface ChatLine {
  /** Stable per-battle sequence id — a duplicate re-emit is ignored. */
  id?: number;
  /** Bridge timestamp (ms since epoch; unused by the face, kept for order). */
  t?: number;
  /** Sender nickname ("[TAG]Name" or bare); omitted when unknown. */
  from?: string;
  /** Chat channel namespace (battle_common / battle_team / …). */
  ns?: string;
  /** BCP-47 language tag of the TRANSLATION (rides the row's lang attr). */
  lang?: string;
  /** Original message body. */
  text?: string;
  /** Translated message body; empty/absent → the original text is drawn. */
  translated?: string;
}

interface ChatTranslatePayload {
  /** Stable battle id (the probe session stamp in production). */
  battle?: string;
  /** New lines since the last event — append-only within one battle. */
  lines?: ChatLine[];
  /** The card's current per-battle line cap. */
  maxLines?: number;
}

interface ChatPrefsPayload {
  /** The card's current per-battle line cap. */
  maxLines?: number;
}

/** The overlay.json namespace this page reads (nested `chat` object; the
 *  other keys are the future hint/status copy, added with the panel). */
interface OverlayChatMessages {
  chat: {
    /** Accessible name for the card + the document title. */
    title: string;
    /** "Translating…" — reserved for the panel's status hint. */
    loading: string;
    /** "Translation ready" — reserved for the panel's status hint. */
    ready: string;
    /** "Press Enter to open chat, Ctrl+V to paste" — reserved. */
    pasteHint: string;
    /** "Translation unavailable" — reserved. */
    unavailable: string;
    /** Remaining-paste count pattern carrying `{count}` — reserved. */
    remaining: string;
  };
}

const MESSAGES = import.meta.glob<OverlayChatMessages>(
  "../../../../res/i18n/locales/*/overlay.json",
  { eager: true },
);
const messages = new Map<string, OverlayChatMessages>();
for (const [path, mod] of Object.entries(MESSAGES)) {
  const m = path.match(/locales\/([a-zA-Z-]+)\/overlay\.json$/);
  if (m && mod?.chat) messages.set(m[1], mod);
}
const locale = new URLSearchParams(window.location.search).get("locale") || "en-US";
function localized(key: keyof OverlayChatMessages["chat"]): string {
  // Empty string is a legitimate VALUE elsewhere in this namespace, so
  // presence is judged against undefined, not truthiness.
  const exact = messages.get(locale)?.chat[key];
  if (exact != null) return exact;
  const lang = locale.split("-")[0];
  const byLang = [...messages.entries()].find(([k]) => k.split("-")[0] === lang);
  const byLangValue = byLang ? byLang[1].chat[key] : undefined;
  if (byLangValue != null) return byLangValue;
  return messages.get("en-US")?.chat[key] ?? [...messages.values()][0]?.chat[key] ?? "";
}

interface OverlayTauriApi {
  event: {
    listen: (ev: string, h: (e: { payload: unknown }) => void) => Promise<() => void>;
  };
}
const tauri = (window as unknown as { __TAURI__?: OverlayTauriApi }).__TAURI__;

// ── State ────────────────────────────────────────────────────────────────

/** Default line cap until the bridge states one (the overlay config's own
 *  default — see stores/overlayConfig's CHAT_PANEL_MAX_LINES default). */
const DEFAULT_MAX_LINES = 8;
/** Defensive ceiling for a hostile/older payload: the settings band tops
 *  out at 30, so a bigger value can only be junk. */
const MAX_LINES_CEILING = 100;

/** The battle these buffer entries belong to ("" = none seen yet). */
let battle = "";
/** Newest-last window of accepted lines (bounded by `maxLines`). */
let buffer: ChatLine[] = [];
/** Numeric line ids currently in `buffer` — a re-emitted line is skipped. */
let seenIds = new Set<number>();
/** The card's per-battle line cap. */
let maxLines = DEFAULT_MAX_LINES;
/** The card element; created on the first line and detached when empty. */
let panel: HTMLDivElement | null = null;

function clampMaxLines(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_LINES_CEILING, Math.max(1, Math.round(n)));
}

/** Trim `buffer` to the current cap and rebuild the id index with it. */
function trimBuffer() {
  if (buffer.length > maxLines) buffer = buffer.slice(buffer.length - maxLines);
  seenIds = new Set<number>();
  for (const line of buffer) {
    if (typeof line.id === "number") seenIds.add(line.id);
  }
}

function ensurePanel(): HTMLDivElement {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.className = "chat-panel";
  panel.setAttribute("role", "log");
  panel.setAttribute("aria-label", localized("title"));
  document.body.appendChild(panel);
  return panel;
}

function render() {
  if (buffer.length === 0) {
    // Empty buffer = NOTHING rendered (the window is fully transparent; an
    // empty glass slab at the screen corner would read as a glitch).
    panel?.remove();
    panel = null;
    return;
  }
  const root = ensurePanel();
  // Chat reads top-to-bottom in arrival order; rebuilding at most a few
  // dozen tiny rows per event is cheaper than diffing stale nodes.
  root.replaceChildren();
  for (const line of buffer) {
    const row = document.createElement("div");
    row.className = "chat-panel__line";
    if (line.lang) row.lang = line.lang;
    const from = (line.from ?? "").trim();
    if (from) {
      const who = document.createElement("span");
      who.className = "chat-panel__from";
      who.textContent = from;
      row.appendChild(who);
    }
    const body = document.createElement("span");
    body.className = "chat-panel__text";
    const translated = (line.translated ?? "").trim();
    body.textContent = translated || (line.text ?? "");
    row.appendChild(body);
    root.appendChild(row);
  }
}

function acceptLines(lines: ChatLine[]) {
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    if (typeof line.id === "number") {
      if (seenIds.has(line.id)) continue;
      seenIds.add(line.id);
    }
    buffer.push(line);
  }
  trimBuffer();
  render();
}

// ── Wiring ───────────────────────────────────────────────────────────────

async function main() {
  if (!tauri) return;
  const { listen } = tauri.event;
  // Listeners attach before anything else (the window can be shown within
  // ms of creation — the sibling pages' rule).
  await listen("wowsp://chat-translate", (e: { payload: unknown }) => {
    const payload = e.payload as ChatTranslatePayload | null;
    if (!payload || typeof payload !== "object") return;
    const nextBattle = typeof payload.battle === "string" ? payload.battle : "";
    if (nextBattle && nextBattle !== battle) {
      // A new battle: nothing of the previous one may survive.
      battle = nextBattle;
      buffer = [];
      seenIds = new Set<number>();
    }
    const nextMax = clampMaxLines(payload.maxLines);
    if (nextMax != null) maxLines = nextMax;
    acceptLines(Array.isArray(payload.lines) ? payload.lines : []);
  });
  await listen("wowsp://chat-prefs", (e: { payload: unknown }) => {
    const payload = e.payload as ChatPrefsPayload | null;
    const nextMax = clampMaxLines(payload?.maxLines);
    if (nextMax == null || nextMax === maxLines) return;
    maxLines = nextMax;
    trimBuffer();
    render();
  });
  // The native window title (invisible, but keeps task switcher / dev tools
  // honest) and the card's accessible name use the same localized copy.
  document.title = localized("title");
}

void main();
