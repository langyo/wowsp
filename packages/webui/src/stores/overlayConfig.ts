/**
 * In-game overlay (Mode 2) user settings, persisted by the shell as
 * `overlay-config.toml` (schema v2) through the typed get/set commands —
 * the window switches are each independent, each with its own off state:
 *
 * - `table` — the hold-Tab view mode: "detect" (the transparent window
 *   overlay on the pixel-detected team table, the default) or "off" (the
 *   Tab TABLE window is kept down; the aim card below may stay on — the
 *   lifecycle keeps the mode up while either switch wants a window). A
 *   stored "ingame" pick — the retired in-game plugin rendering, whose
 *   stats bridge this build no longer starts — migrates to "detect".
 * - `aimCard` — the aimed-player stats card's window (hangs below the
 *   crosshair during battles): on unless the user turned it off. The
 *   watcher consults the persisted flag every tick, so a flip applies
 *   live without touching the window lifecycle.
 * - `aimCardHangPx` — how far that card hangs below the crosshair
 *   (logical px, DPI-scaled at placement): 60 by default. The settings
 *   slider offers 60–240; the edit box beside it commits any value ≥ 0
 *   (the Rust side sanity-clamps at 100 000 and the placement pins
 *   oversized hangs to the game window's bottom edge). Same live path:
 *   the watcher re-reads the config every tick, so a change re-places
 *   the card immediately — no window reload, no restart.
 * - `chatPanel` — the battle-chat translation card's window (the third
 *   transparent window, bottom-left while Tab is held). Off by default: the
 *   feature is opt-in and its Rust side only shows the window when this
 *   switch AND the translation feature toggle are both on. `chatPanelMaxLines`
 *   is the card's per-battle line cap (8 by default, clamped 3–30 shell-side);
 *   like the aim card's hang, the watcher re-reads both every tick, so a
 *   change applies live without touching the window lifecycle.
 * - `roster` — roster attribution: "plugin" (the default and preferred:
 *   the in-game plugin's telemetry is the primary detector) or "passive"
 *   (the screen-capture pipeline; a stored "off" pick lands here — the
 *   table switch owns the table window's off state). Stored
 *   "inferred"/"ocr" picks (the retired pixel-comparison pipeline)
 *   migrate to "plugin".
 *
 * The Rust side owns every on-disk concern: the flat TOML file, the
 * one-shot migration of the pre-TOML `overlay-config.json`, the v1
 * `{enabled: boolean}` shape (enabled → detect + plugin, disabled →
 * off + plugin), and the fallback that resets an unknown value to the
 * field's safe default and FORCES the corrected value back to disk (see
 * commands/overlay_config.rs). This store keeps a thin client-side guard
 * as defense in depth: values arriving from an older shell still land on
 * the defaults without ever throwing.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

import { api } from "@/api";
import { notifySettingsSaved } from "@/stores/settingsSavedFlash";

/** Live-battle view modes (schema v2 `table` field). */
export type TableAnchorMode = "detect" | "off";
/** Roster attribution modes (schema v2 `roster` field): "plugin" = the
 *  in-game plugin is the primary detector; "passive" = the screen-capture
 *  pipeline (a stored "off" pick lands here — the table switch owns the
 *  table window's off state). */
export type RosterRecognitionMode = "plugin" | "passive";

const DEFAULT_TABLE: TableAnchorMode = "detect";
const DEFAULT_ROSTER: RosterRecognitionMode = "plugin";
const DEFAULT_AIM_CARD = true;
/** The chat-translation card's window switch (schema v2 `chat_panel`):
 *  OFF by default — the translation feature is opt-in, and a user who never
 *  enabled it must not see a third transparent window. */
const DEFAULT_CHAT_PANEL = false;
/** The card's per-battle line cap (schema v2 `chat_panel_max_lines`; the
 *  Rust-side clamp band's default, must stay in sync with overlay_config.rs). */
const DEFAULT_CHAT_PANEL_MAX_LINES = 8;
/** The card's line-cap band (the settings slider's options; the shell
 *  clamps to the same 3–30 window, so no write can land outside it). */
export const CHAT_PANEL_MAX_LINES_MIN = 3;
export const CHAT_PANEL_MAX_LINES_MAX = 30;
/** Default hang of the aim card below the crosshair, in logical px (the
 *  Rust-side `AIM_CARD_HANG_DEFAULT_PX`; must stay in sync). */
export const DEFAULT_AIM_CARD_HANG_PX = 60;
/** The settings slider's selectable band; the edit box beside it is
 *  deliberately NOT bounded by this (any value ≥ 0 commits — the
 *  placement clamps the card inside the game rect). */
export const AIM_CARD_HANG_SLIDER_MIN = 60;
export const AIM_CARD_HANG_SLIDER_MAX = 240;

/** Unknown values (incl. future ones) → the safe default. A stored
 *  "ingame" pick — the retired in-game plugin rendering — lands on the
 *  default, so the overlay window takes over as the display backend (the
 *  Rust side heals the file to the same value, see
 *  commands/overlay_config.rs). */
function parseTable(raw: unknown): TableAnchorMode {
  if (raw === "off") return "off";
  return DEFAULT_TABLE;
}

function parseRoster(raw: unknown): RosterRecognitionMode {
  // Migration: stored "inferred"/"ocr" picks — the retired pixel-
  // comparison pipeline — move to the plugin as the primary; a stored
  // "off" lands on passive (the table switch owns the table window's off).
  if (raw === "passive") return "passive";
  if (raw === "plugin") return "plugin";
  if (raw === "off") return "passive";
  return DEFAULT_ROSTER;
}

function parseAimCard(raw: unknown): boolean {
  return typeof raw === "boolean" ? raw : DEFAULT_AIM_CARD;
}

function parseChatPanel(raw: unknown): boolean {
  return typeof raw === "boolean" ? raw : DEFAULT_CHAT_PANEL;
}

/** The line cap in whole lines, clamped to the shell's 3–30 band; anything
 *  but a finite number (older shell, wrong type, junk) lands on the default
 *  — the Rust read path heals the file to the same value. */
function parseChatPanelMaxLines(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_CHAT_PANEL_MAX_LINES;
  return Math.min(
    CHAT_PANEL_MAX_LINES_MAX,
    Math.max(CHAT_PANEL_MAX_LINES_MIN, Math.round(n)),
  );
}

/** The hang in whole logical px; anything but a non-negative finite number
 *  (older shell, wrong type, junk) lands on the default — the Rust read
 *  path heals the file to the same value. */
function parseAimCardHangPx(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AIM_CARD_HANG_PX;
  return Math.round(n);
}

export const useOverlayConfigStore = defineStore("overlayConfig", () => {
  const table = ref<TableAnchorMode>(DEFAULT_TABLE);
  const roster = ref<RosterRecognitionMode>(DEFAULT_ROSTER);
  const aimCard = ref(DEFAULT_AIM_CARD);
  const aimCardHangPx = ref(DEFAULT_AIM_CARD_HANG_PX);
  const chatPanel = ref(DEFAULT_CHAT_PANEL);
  const chatPanelMaxLines = ref(DEFAULT_CHAT_PANEL_MAX_LINES);
  const loaded = ref(false);
  let pendingLoad: Promise<void> | null = null;
  let pendingSave = Promise.resolve();
  let saveSequence = 0;

  function load(): Promise<void> {
    if (!pendingLoad) {
      pendingLoad = (async () => {
        try {
          const cfg = await api.getOverlayConfig();
          table.value = parseTable(cfg?.table);
          roster.value = parseRoster(cfg?.roster);
          aimCard.value = parseAimCard(cfg?.aimCard);
          aimCardHangPx.value = parseAimCardHangPx(cfg?.aimCardHangPx);
          chatPanel.value = parseChatPanel(cfg?.chatPanel);
          chatPanelMaxLines.value = parseChatPanelMaxLines(cfg?.chatPanelMaxLines);
        } catch {
          // missing command / mock backend — keep the defaults
        } finally {
          loaded.value = true;
        }
      })();
    }
    return pendingLoad;
  }

  /** Persist through the typed command; the shell sanitizes and writes the
   *  TOML file. Captured writes stay ordered, and an older reply cannot
   *  roll back a choice the user made while that write was pending. */
  function persist(): Promise<void> {
    const sequence = ++saveSequence;
    const snapshot = {
      table: table.value,
      roster: roster.value,
      aimCard: aimCard.value,
      aimCardHangPx: aimCardHangPx.value,
      chatPanel: chatPanel.value,
      chatPanelMaxLines: chatPanelMaxLines.value,
    };
    pendingSave = pendingSave.then(async () => {
      try {
        const saved = await api.setOverlayConfig(
          snapshot.table,
          snapshot.roster,
          snapshot.aimCard,
          snapshot.aimCardHangPx,
          snapshot.chatPanel,
          snapshot.chatPanelMaxLines,
        );
        if (sequence !== saveSequence) return;
        table.value = parseTable(saved?.table);
        roster.value = parseRoster(saved?.roster);
        aimCard.value = parseAimCard(saved?.aimCard);
        aimCardHangPx.value = parseAimCardHangPx(saved?.aimCardHangPx);
        chatPanel.value = parseChatPanel(saved?.chatPanel);
        chatPanelMaxLines.value = parseChatPanelMaxLines(saved?.chatPanelMaxLines);
        notifySettingsSaved();
      } catch {
        // best-effort persistence; the in-memory flag still applies
      }
    });
    return pendingSave;
  }

  async function setTable(v: TableAnchorMode) {
    await load();
    table.value = v;
    await persist();
  }

  async function setRoster(v: RosterRecognitionMode) {
    await load();
    roster.value = v;
    await persist();
  }

  async function setAimCard(v: boolean) {
    await load();
    aimCard.value = v;
    await persist();
  }

  /** The chat-translation card's window switch. Persisted like every other
   *  switch; the watcher's per-tick read is what actually shows/hides the
   *  window, so no lifecycle call rides a flip. */
  async function setChatPanel(v: boolean) {
    await load();
    if (chatPanel.value === v) return;
    chatPanel.value = v;
    await persist();
  }

  /** Set the card's per-battle line cap (whole lines, clamped 3–30 — the
   *  same band the shell sanitizes to, so the stored value can never drift
   *  out of range). A no-op value skips the IPC round-trip. */
  async function setChatPanelMaxLines(v: number) {
    await load();
    if (!Number.isFinite(v)) return;
    const next = Math.min(
      CHAT_PANEL_MAX_LINES_MAX,
      Math.max(CHAT_PANEL_MAX_LINES_MIN, Math.round(v)),
    );
    if (next === chatPanelMaxLines.value) return;
    chatPanelMaxLines.value = next;
    await persist();
  }

  /** Set the hang (logical px). Input is rounded to whole pixels and
   *  clamped ≥ 0 (the box can sit BELOW the slider's 60 floor, but not
   *  above the crosshair) and deliberately NOT capped on this side — the
   *  shell sanity-clamps at 100 000 and the placement pins oversized
   *  values to the game window's bottom edge, so "as far as the screen
   *  allows" degrades gracefully instead of erroring. */
  async function setAimCardHangPx(v: number) {
    await load();
    if (!Number.isFinite(v)) return;
    const next = Math.max(0, Math.round(v));
    if (next === aimCardHangPx.value) return;
    aimCardHangPx.value = next;
    await persist();
  }

  return {
    table,
    roster,
    aimCard,
    aimCardHangPx,
    chatPanel,
    chatPanelMaxLines,
    loaded,
    load,
    setTable,
    setRoster,
    setAimCard,
    setAimCardHangPx,
    setChatPanel,
    setChatPanelMaxLines,
  };
});
