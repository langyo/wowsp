/**
 * Battle-chat translation card bootstrap — the THIRD transparent overlay
 * window (the Tab-table window's main.ts is the first, the aim card's
 * aimcard.ts the second). Bare DOM like its siblings.
 *
 * The card shows the recent battle-chat lines at the bottom-left of the game
 * screen while the player HOLDS Tab. The native window's show/hide is the
 * Rust watcher's job (battle known + the chat card enabled in the overlay
 * settings + Tab down, OR the outgoing paste hint is up — M3); this page only
 * ever paints what it was last handed, and paints NOTHING when it has no
 * lines and no hint (the window is fully transparent then — no card, no
 * border, no empty shell).
 *
 * Each line renders as (up to) TWO rows:
 *   - the ORIGINAL row: channel marker (team channels only) + sender + the
 *     self tag on the local player's own line + the original text (muted,
 *     ONE line, ellipsized) + the language badge right-aligned;
 *   - the TRANSLATED row — absent when the translation is empty (an
 *     untranslatable / own-echo / pending line still reads through its
 *     original): the translated body in the card's main color, clamped to
 *     two rows.
 *
 * The outgoing paste HINT (M3) stacks UNDER the reading panel in the same
 * bottom-left column (the hint is the bottom-most, z-order-above element):
 *   - "translating": the three-dot loader (the Tab table's own face) +
 *     overlay.chat.loading;
 *   - "ready": the composed preview (two-line clamp) + overlay.chat.pasteHint
 *     + overlay.chat.remaining ("{count} left to paste") when more messages
 *     wait behind the first;
 *   - "error": the shell's user-facing message (muted red);
 *   - "dismissed": the hint node is removed (the reading panel stays).
 * A BATTLE change removes the hint too — a hint for a finished battle must
 * never survive into the next one.
 *
 * Data intake (the bridge's wire contract):
 *   - `wowsp://chat-translate` — `{ battle, lines, maxLines }`: the most
 *     recent translated lines of the battle (an oldest→newest snapshot; the
 *     page merges them by id and keeps the newest `maxLines`), the battle's
 *     stable id, and the card's current line cap.
 *     A DIFFERENT `battle` id starts a new battle and clears everything
 *     first, so a late line of a finished battle can never leak into the
 *     next one.
 *   - `wowsp://chat-prefs` — `{ maxLines }`: the settings' live line-cap
 *     flip (the watcher re-reads the config every tick; this event keeps the
 *     page in step without waiting for the next line).
 *   - `wowsp://chat-hint` — the outgoing paste hint state (see above). The
 *     hint is scoped to its own `battle` id; a hint event for a different
 *     battle replaces the node, and a dismissed/empty state removes it.
 * A line is `{ id, t, from, ns, lang, text, translated, selfLine }`: `lang`
 * is the BCP-47 tag the engine attached (it rides the row's `lang`
 * attribute — so a CJK/Cyrillic mix renders with the right face — and is
 * drawn as the right-aligned badge), `from` the sender's nickname (drawn
 * muted, omitted when empty), `ns` the chat channel (`battle_team` and
 * `battle_prebattle` get a colored marker, every other channel none),
 * `selfLine` true when the sender is the local player (its row is
 * highlighted and carries the localized "me" tag), `text` the original body
 * and `translated` the translated body (empty → no translated row).
 *
 * DOM safety: chat text is arbitrary player input, so this page NEVER builds
 * markup — one element per line, `textContent` only, no innerHTML anywhere.
 */
import { installNativeMenuBlock } from "@/utils/nativeMenu";
import type { HostWindow } from "@/utils/typing";
import "./chat.scss";

// Desktop surface: never show the WebView's own context menu.
installNativeMenuBlock();

/** One translated chat line from the bridge (the fields this page reads). */
interface ChatLine {
  /** Stable per-battle sequence id — a re-emitted id updates its own row. */
  id?: number;
  /** Bridge timestamp (ms since epoch; unused by the face, kept for order). */
  t?: number;
  /** Sender nickname ("[TAG]Name" or bare); omitted when unknown. */
  from?: string;
  /** Chat channel namespace (battle_common / battle_team / …). */
  ns?: string;
  /** BCP-47 tag the engine attached: the line's SOURCE language on a
   *  translated line (the model's detection — it also drives the row's lang
   *  attr so the ORIGINAL renders with the right glyphs), the script hint
   *  on a skipped one. Shown as the right-aligned badge. */
  lang?: string;
  /** Original message body. */
  text?: string;
  /** Translated message body; empty/absent → no translated row. */
  translated?: string;
  /** The sender is the local player (row highlight + the localized "me"
   *  tag). Wire field name is `selfLine`; absent/false on every other row. */
  selfLine?: boolean;
}

interface ChatTranslatePayload {
  /** Stable battle id (the probe session stamp in production). */
  battle?: string;
  /** The battle's recent lines, oldest→newest snapshot (merged by id). */
  lines?: ChatLine[];
  /** The card's current per-battle line cap. */
  maxLines?: number;
}

interface ChatPrefsPayload {
  /** The card's current per-battle line cap. */
  maxLines?: number;
}

/** The four states the outgoing paste hint can be in (wire strings). */
type ChatHintState = "translating" | "ready" | "error" | "dismissed";

/** `wowsp://chat-hint` payload (the outgoing pipeline's paste card). */
interface ChatHintPayload {
  /** The battle the hint belongs to; a different id replaces the node. */
  battle?: string;
  /** Which face to draw; unknown/absent states remove the hint. */
  state?: ChatHintState | string;
  /** "ready": the composed translation preview (two-line clamp). */
  preview?: string | null;
  /** "ready": messages still waiting behind the first (paste count). */
  remaining?: number | null;
  /** "ready": total messages composed for this own line. */
  total?: number | null;
  /** "error": the shell's user-facing failure sentence. */
  message?: string | null;
}

/** The overlay.json namespace this page reads (nested `chat` object). */
interface OverlayChatMessages {
  chat: {
    /** Accessible name for the card + the document title. */
    title: string;
    /** "Translating…" — the paste hint's translating face. */
    loading: string;
    /** "Translation ready" — reserved (the ready face is the preview). */
    ready: string;
    /** "Press Enter to open chat, Ctrl+V to paste and send". */
    pasteHint: string;
    /** "Translation unavailable" — the error face's fallback text. */
    unavailable: string;
    /** Remaining-paste count pattern carrying `{count}`. */
    remaining: string;
    /** Short team-channel marker ("[Team]" / "[队]" …). */
    teamTag: string;
    /** The local player's own-line tag ("me" / "我" …). */
    selfTag: string;
    /** Accessible description of a line's original row, carrying `{name}`. */
    lineOriginalA11y: string;
  };
}

type OverlayChatKey = keyof OverlayChatMessages["chat"];

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
function localized(key: OverlayChatKey): string {
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

/** `localized` with `{placeholder}` substitution (the a11y template's
 *  `{name}`, the hint's `{count}`). Unknown placeholders are left verbatim
 *  rather than dropped. */
function localizedWith(key: OverlayChatKey, params: Record<string, string>): string {
  return localized(key).replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}

interface OverlayTauriApi {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: {
    listen: (ev: string, h: (e: { payload: unknown }) => void) => Promise<() => void>;
  };
}
const tauri = (window as HostWindow<{ __TAURI__?: OverlayTauriApi }>).__TAURI__;

// ── Player markers (玩家标记) ── the sender's nickname gains the same colored
// dot the Tab table's rows carry. Chat lines carry a nickname only (no
// account id), so the match is nickname-first. Fetched lazily through the
// bare invoke; wowsp://markers-changed re-fetches mid-session.
type OverlayMarkerColor = "red" | "yellow" | "purple";
const markersByNickname = new Map<string, OverlayMarkerColor>();
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
      for (const entry of list ?? []) {
        markersByNickname.set(normNick(entry.nickname), entry.color);
      }
      markersLoaded = true;
      render();
    } catch {
      // Cooldown: a dead backend must not be retried on every chat event.
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

/** The marker color for a chat nickname ("[TAG]Name" tolerated — the name
 *  is matched with the roster's [tag] prefix stripped). */
function markerColorOf(from: string): OverlayMarkerColor | null {
  const bare = from.replace(/^\[[^\]]*\]\s*/, "");
  return markersByNickname.get(normNick(bare)) ?? markersByNickname.get(normNick(from)) ?? null;
}

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
/** The card's per-battle line cap. */
let maxLines = DEFAULT_MAX_LINES;
/** The bottom-left column (reading panel + paste hint); created on demand and
 *  detached again when both children are gone. */
let root: HTMLDivElement | null = null;
/** The reading card element; created on the first line and detached when
 *  empty. */
let panel: HTMLDivElement | null = null;
/** The outgoing paste hint card; null when no hint is up. */
let hint: HTMLDivElement | null = null;

/** The bottom-left stacking column. Children stack top→bottom: the reading
 *  panel first, the paste hint LAST (the hint is the bottom-most element and
 *  carries a higher z-index, per the paste-card contract). */
function ensureRoot(): HTMLDivElement {
  if (root) return root;
  root = document.createElement("div");
  root.className = "chat-overlay";
  document.body.appendChild(root);
  return root;
}

/** Detach the column when it has no children — an empty glass shell at the
 *  screen corner would read as a glitch. */
function disposeRootIfEmpty() {
  if (!root) return;
  if (root.childElementCount === 0) {
    root.remove();
    root = null;
  }
}

function clampMaxLines(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_LINES_CEILING, Math.max(1, Math.round(n)));
}

/** Trim `buffer` to the current cap (the array is kept in chat order). */
function trimBuffer() {
  if (buffer.length > maxLines) buffer = buffer.slice(buffer.length - maxLines);
}

/** The chat channel's visual class: team chat (blue marker) and pre-battle/
 *  division chat (gold marker); every other namespace renders no marker. */
type ChannelKind = "team" | "prebattle";

function channelKind(ns: unknown): ChannelKind | null {
  if (typeof ns !== "string") return null;
  const value = ns.trim().toLowerCase();
  if (value === "battle_team") return "team";
  if (value === "battle_prebattle") return "prebattle";
  return null;
}

function channelMarker(kind: ChannelKind): HTMLSpanElement {
  const marker = document.createElement("span");
  marker.className = `chat-panel__ns chat-panel__ns--${kind}`;
  if (kind === "team") {
    // The localized tag names the channel; the CSS tints it muted blue.
    marker.textContent = localized("teamTag");
  } else {
    // Division chat: a language-neutral gold diamond — the team tag would
    // name the WRONG channel here.
    marker.textContent = "◆";
    marker.setAttribute("aria-hidden", "true");
  }
  return marker;
}

function ensurePanel(): HTMLDivElement {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.className = "chat-panel";
  panel.setAttribute("role", "log");
  panel.setAttribute("aria-label", localized("title"));
  const host = ensureRoot();
  // The reading panel always sits ABOVE the paste hint in the column: when a
  // hint is already up, the panel inserts before it instead of appending
  // under it.
  if (hint && hint.parentNode === host) host.insertBefore(panel, hint);
  else host.appendChild(panel);
  return panel;
}

/** Build ONE line's nodes: the original row always, the translated row only
 *  when a translation exists. `textContent` only — chat input is arbitrary
 *  and is never parsed as markup. */
function buildLine(line: ChatLine): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "chat-panel__line";
  const isSelf = line.selfLine === true;
  if (isSelf) row.classList.add("chat-panel__line--self");
  const lang = (line.lang ?? "").trim();
  if (lang) row.lang = lang;

  const from = (line.from ?? "").trim();
  if (from) {
    // Each line is one accessible group named after its original sender;
    // the visible translation row stays inside it.
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", localizedWith("lineOriginalA11y", { name: from }));
  }

  const original = document.createElement("div");
  original.className = "chat-panel__orig";

  const kind = channelKind(line.ns);
  if (kind) original.appendChild(channelMarker(kind));

  if (from) {
    const who = document.createElement("span");
    who.className = "chat-panel__from";
    who.textContent = from;
    original.appendChild(who);
    // Player marker (玩家标记): the same dot the Tab rows/aim card carry,
    // built with createElement only (this page never builds markup).
    const color = markerColorOf(from);
    if (color) {
      const mk = document.createElement("span");
      mk.className = `chat-panel__mk chat-panel__mk--${color}`;
      original.appendChild(mk);
    }
  }
  if (isSelf) {
    const me = document.createElement("span");
    me.className = "chat-panel__self";
    me.textContent = localized("selfTag");
    original.appendChild(me);
  }

  const source = document.createElement("span");
  source.className = "chat-panel__text";
  source.textContent = line.text ?? "";
  original.appendChild(source);

  if (lang) {
    const badge = document.createElement("span");
    badge.className = "chat-panel__lang";
    badge.textContent = lang;
    original.appendChild(badge);
  }
  row.appendChild(original);

  const translated = (line.translated ?? "").trim();
  if (translated) {
    const body = document.createElement("div");
    body.className = "chat-panel__translated";
    body.textContent = translated;
    row.appendChild(body);
  }
  return row;
}

function render() {
  ensureMarkers();
  if (buffer.length === 0) {
    // Empty buffer = NOTHING rendered (the window is fully transparent; an
    // empty glass slab at the screen corner would read as a glitch).
    panel?.remove();
    panel = null;
    disposeRootIfEmpty();
    return;
  }
  const host = ensurePanel();
  // Chat reads top-to-bottom in arrival order; rebuilding at most a few
  // dozen tiny rows per event is cheaper than diffing stale nodes.
  host.replaceChildren();
  for (const line of buffer) host.appendChild(buildLine(line));
}

/** Merge one event's lines into the buffer. The bridge sends a SNAPSHOT of
 *  the battle's recent lines (oldest→newest), not a delta, so:
 *   - a line id already known is UPDATED in place (the newest copy wins — a
 *     pending line whose translation landed later keeps its row but gains
 *     the translated body);
 *   - ids are monotonic within a battle, so the merged buffer is sorted by
 *     id: lines that enter the snapshot late (e.g. after the line cap grew)
 *     still sit in chat order instead of after newer ones;
 *   - anonymous lines (no numeric id) append after the sorted block. */
function acceptLines(lines: ChatLine[]) {
  const byId = new Map<number, ChatLine>();
  const anonymous: ChatLine[] = [];
  for (const line of buffer) {
    if (typeof line.id === "number") byId.set(line.id, line);
    else anonymous.push(line);
  }
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    if (typeof line.id === "number") byId.set(line.id, line);
    else anonymous.push(line);
  }
  buffer = [
    ...[...byId.values()].sort((a, b) => (a.id as number) - (b.id as number)),
    ...anonymous,
  ];
  trimBuffer();
  render();
}

// ── Outgoing paste hint ───────────────────────────────────────────────────

/** The chasing three-dot bead row (the Tab table's own face, copied into
 *  chat.scss). Bead animation delays are phase-locked from one shared clock,
 *  exactly like the source family. */
const DOTS_PERIOD_MS = 1200;

function buildDots(): HTMLSpanElement {
  const dots = document.createElement("span");
  dots.className = "overlay-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) {
    const bead = document.createElement("i");
    bead.style.animationDelay = `${-(DOTS_PERIOD_MS * index) / 3}ms`;
    dots.appendChild(bead);
  }
  return dots;
}

function hintRow(className: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = className;
  return row;
}

/** One hint payload → the hint card (or its removal). The node is rebuilt per
 *  event: the card holds at most four short lines, diffing adds nothing.
 *  `textContent` only — the preview is translated chat input. */
function renderHint(payload: ChatHintPayload) {
  const state = typeof payload.state === "string" ? payload.state : "";
  if (state === "dismissed" || (state !== "translating" && state !== "ready" && state !== "error")) {
    clearHint();
    return;
  }
  const card = document.createElement("div");
  card.className = `chat-hint chat-hint--${state}`;
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");

  if (state === "translating") {
    const row = hintRow("chat-hint__row");
    row.appendChild(buildDots());
    const label = document.createElement("span");
    label.className = "chat-hint__label";
    label.textContent = localized("loading");
    row.appendChild(label);
    card.appendChild(row);
  } else if (state === "ready") {
    const preview = (payload.preview ?? "").trim();
    if (preview) {
      const body = document.createElement("div");
      body.className = "chat-hint__preview";
      body.textContent = preview;
      card.appendChild(body);
    }
    const foot = hintRow("chat-hint__footer");
    const paste = document.createElement("span");
    paste.className = "chat-hint__paste";
    paste.textContent = localized("pasteHint");
    foot.appendChild(paste);
    const remaining = typeof payload.remaining === "number" ? payload.remaining : 0;
    if (Number.isFinite(remaining) && remaining > 0) {
      const left = document.createElement("span");
      left.className = "chat-hint__remaining";
      left.textContent = localizedWith("remaining", { count: String(Math.round(remaining)) });
      foot.appendChild(left);
    }
    card.appendChild(foot);
  } else {
    const message = (payload.message ?? "").trim();
    const error = document.createElement("div");
    error.className = "chat-hint__message";
    error.textContent = message || localized("unavailable");
    card.appendChild(error);
  }

  hint?.remove();
  hint = card;
  ensureRoot().appendChild(card);
}

function clearHint() {
  hint?.remove();
  hint = null;
  disposeRootIfEmpty();
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
    // An empty battle string is treated as "same battle, unspecified": the
    // Rust source structurally NEVER emits battle="" (its silent paths
    // suppress the whole event), so the missing-clear here is safe — but it
    // is a coupling: if the source ever grows a battle-less emit, this must
    // become an explicit clear.
    if (nextBattle && nextBattle !== battle) {
      // A new battle: nothing of the previous one may survive — the lines
      // AND the outgoing paste hint belong to the battle they were made in.
      battle = nextBattle;
      buffer = [];
      clearHint();
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
  // The marker list changed (main-window add/remove): re-fetch and repaint —
  // the sender dots must track the list mid-session.
  await listen("wowsp://markers-changed", () => {
    markersLoaded = false;
    markersFailedAt = 0;
    markersDirty = true;
    ensureMarkers();
  });
  await listen("wowsp://chat-hint", (e: { payload: unknown }) => {
    const payload = e.payload as ChatHintPayload | null;
    if (!payload || typeof payload !== "object") return;
    const nextBattle = typeof payload.battle === "string" ? payload.battle : "";
    // The hint is battle-scoped: an event from a battle that is not the one
    // the reading panel is showing is stale (a finished battle's hint must
    // never paint over the next battle).
    if (nextBattle && battle && nextBattle !== battle) {
      clearHint();
      return;
    }
    renderHint(payload);
  });
  // The native window title (invisible, but keeps task switcher / dev tools
  // honest) and the card's accessible name use the same localized copy.
  document.title = localized("title");
}

void main();
