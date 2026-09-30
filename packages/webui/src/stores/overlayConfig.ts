/**
 * In-game overlay (Mode 2) user settings, persisted by the shell as
 * `overlay-config.toml` (schema v2) through the typed get/set commands —
 * TWO independent switches, each with its own off state:
 *
 * - `table` — table anchoring: "detect" (pixel detection, the default)
 *   anchors the chips to the detected team table; "off" disables the WHOLE
 *   Tab overlay (no overlay window, no watcher — `useOverlayLifecycle`
 *   never creates it, and the Rust watcher suppresses shows too).
 * - `roster` — roster attribution: "inferred" (the default and preferred:
 *   the row→name mapping derived from the game's own Tab sort key —
 *   class rank, tier descending, nation, ship name, '[tag]nickname — over
 *   the roster plus the luma probe's alive flags, kept exact mid-battle
 *   by the sink solver; no OCR), or "off" (chips follow roster/index
 *   order, the historical fallback). A stored "ocr" pick (the removed
 *   Windows pipeline) migrates to "inferred".
 *
 * The Rust side owns every on-disk concern: the flat TOML file, the
 * one-shot migration of the pre-TOML `overlay-config.json`, the v1
 * `{enabled: boolean}` shape (enabled → detect + inferred, disabled →
 * off + inferred), and the fallback that resets an unknown value to the
 * field's safe default and FORCES the corrected value back to disk (see
 * commands/overlay_config.rs). This store keeps a thin client-side guard
 * as defense in depth: values arriving from an older shell still land on
 * the defaults without ever throwing.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

import { api } from "@/api";

/** Table anchoring modes (schema v2 `table` field). */
export type TableAnchorMode = "detect" | "off";
/** Roster attribution modes (schema v2 `roster` field): "plugin" = the
 *  in-game plugin is the primary detector; "passive" = the screen-capture
 *  pipeline (renamed from the retired "inferred" pick); "off" = off. */
export type RosterRecognitionMode = "plugin" | "passive";

const DEFAULT_TABLE: TableAnchorMode = "detect";
const DEFAULT_ROSTER: RosterRecognitionMode = "plugin";

/** Unknown values (incl. future ones) → the safe default. */
function parseTable(raw: unknown): TableAnchorMode {
  return raw === "off" ? "off" : DEFAULT_TABLE;
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
