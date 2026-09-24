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
 *   the row→name mapping derived from the game's verified Tab sort rule —
 *   class rank, tier descending, ship id — over the roster plus the luma
 *   probe's alive flags, no OCR), "ocr" (Windows OCR row→name matching —
 *   exact, offered only when the OS OCR engine is usable), or "off" (chips
 *   follow roster/index order, the historical fallback, with no
 *   "recognizing…" pending hints).
 *
 * The Rust side owns every on-disk concern: the flat TOML file, the
 * one-shot migration of the pre-TOML `overlay-config.json`, the v1
 * `{enabled: boolean}` shape (enabled → detect + ocr, disabled → off +
 * ocr), and the fallback that resets an unknown value to the field's safe
 * default and FORCES the corrected value back to disk (see
 * commands/overlay_config.rs). This store keeps a thin client-side guard
 * as defense in depth: values arriving from an older shell still land on
 * the defaults without ever throwing.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

import { api } from "@/api";

/** Table anchoring modes (schema v2 `table` field). */
export type TableAnchorMode = "detect" | "off";
/** Roster attribution modes (schema v2 `roster` field). */
export type RosterRecognitionMode = "inferred" | "ocr" | "off";

const DEFAULT_TABLE: TableAnchorMode = "detect";
const DEFAULT_ROSTER: RosterRecognitionMode = "inferred";

/** Unknown values (incl. future ones like "plugin") → the safe default. */
function parseTable(raw: unknown): TableAnchorMode {
  return raw === "off" ? "off" : DEFAULT_TABLE;
}

function parseRoster(raw: unknown): RosterRecognitionMode {
  return raw === "ocr" ? "ocr" : raw === "off" ? "off" : DEFAULT_ROSTER;
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
