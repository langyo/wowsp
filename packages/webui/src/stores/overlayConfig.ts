/**
 * In-game overlay (Mode 2) user settings, persisted by the shell as
 * `overlay-config.toml` (schema v2) through the typed get/set commands —
 * TWO independent switches, each with its own off state:
 *
 * - `table` — the live-battle view mode: "detect" (the transparent window
 *   overlay on the pixel-detected team table, the default), "ingame" (the
 *   stats render INSIDE the game through the first-party plugin's unbound
 *   view — no overlay window; `useOverlayLifecycle` starts the stats
 *   bridge instead, and the Rust watcher suppresses shows too), or "off"
 *   (the WHOLE Tab overlay is disabled: no window, no watcher shows, no
 *   bridge).
 * - `roster` — roster attribution: "plugin" (the default and preferred:
 *   the in-game plugin's telemetry is the primary detector) or "passive"
 *   (the screen-capture pipeline; a stored "off" pick lands here — the
 *   table switch owns the overlay's off state). Stored "inferred"/"ocr"
 *   picks (the retired pixel-comparison pipeline) migrate to "plugin".
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

/** Live-battle view modes (schema v2 `table` field). */
export type TableAnchorMode = "detect" | "ingame" | "off";
/** Roster attribution modes (schema v2 `roster` field): "plugin" = the
 *  in-game plugin is the primary detector; "passive" = the screen-capture
 *  pipeline (a stored "off" pick lands here — the table switch owns the
 *  overlay's off state). */
export type RosterRecognitionMode = "plugin" | "passive";

const DEFAULT_TABLE: TableAnchorMode = "detect";
const DEFAULT_ROSTER: RosterRecognitionMode = "plugin";

/** Unknown values (incl. future ones) → the safe default. */
function parseTable(raw: unknown): TableAnchorMode {
  if (raw === "off") return "off";
  if (raw === "ingame") return "ingame";
  return DEFAULT_TABLE;
}

function parseRoster(raw: unknown): RosterRecognitionMode {
  // Migration: stored "inferred"/"ocr" picks — the retired pixel-
  // comparison pipeline — move to the plugin as the primary; a stored
  // "off" lands on passive (the table switch owns the overlay's off).
  if (raw === "passive") return "passive";
  if (raw === "plugin") return "plugin";
  if (raw === "off") return "passive";
  return DEFAULT_ROSTER;
}

export const useOverlayConfigStore = defineStore("overlayConfig", () => {
  const table = ref<TableAnchorMode>(DEFAULT_TABLE);
  const roster = ref<RosterRecognitionMode>(DEFAULT_ROSTER);
  const loaded = ref(false);

  async function load() {
    if (loaded.value) return;
    loaded.value = true;
    try {
      const cfg = await api.getOverlayConfig();
      table.value = parseTable(cfg?.table);
      roster.value = parseRoster(cfg?.roster);
    } catch {
      // missing command / mock backend — keep the defaults
    }
  }

  /** Persist through the typed command; the shell sanitizes and writes the
   *  TOML file, and the returned values are what actually landed. */
  async function persist() {
    try {
      const saved = await api.setOverlayConfig(table.value, roster.value);
      table.value = parseTable(saved?.table);
      roster.value = parseRoster(saved?.roster);
    } catch {
      // best-effort persistence; the in-memory flag still applies
    }
  }

  async function setTable(v: TableAnchorMode) {
    table.value = v;
    await persist();
  }

  async function setRoster(v: RosterRecognitionMode) {
    roster.value = v;
    await persist();
  }

  return { table, roster, loaded, load, setTable, setRoster };
});
