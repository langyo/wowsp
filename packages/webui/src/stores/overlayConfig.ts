/**
 * In-game overlay (Mode 2) user settings, persisted to AppData as
 * `overlay-config.json` (schema v2) — TWO independent switches, each with
 * its own off state:
 *
 * - `table` — table anchoring: "detect" (pixel detection, the default)
 *   anchors the chips to the detected team table; "off" disables the WHOLE
 *   Tab overlay (no overlay window, no watcher — `useOverlayLifecycle`
 *   never creates it, and the Rust watcher suppresses shows too).
 * - `roster` — roster recognition: "ocr" (the default pipeline: Windows
 *   OCR row→name matching) or "off" (chips follow roster/index order, the
 *   historical fallback, with no "recognizing…" pending hints).
 *
 * Both value sets are open enums on purpose: a future third option (e.g.
 * "plugin") can be added without schema churn, and unknown/legacy values
 * fall back to each field's safe default. Schema v1 (`{enabled: boolean}` —
 * a single master switch) migrates on load: enabled → detect + ocr,
 * disabled → off + ocr; the file is always written back in the v2 shape.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

import { api } from "@/api";

const OVERLAY_CONFIG_FILE = "overlay-config.json";

/** Table anchoring modes (schema v2 `table` field). */
export type TableAnchorMode = "detect" | "off";
/** Roster recognition modes (schema v2 `roster` field). */
export type RosterRecognitionMode = "ocr" | "off";

const DEFAULT_TABLE: TableAnchorMode = "detect";
const DEFAULT_ROSTER: RosterRecognitionMode = "ocr";

/** Unknown values (incl. future ones like "plugin") → the safe default. */
function parseTable(raw: unknown): TableAnchorMode {
  return raw === "off" ? "off" : DEFAULT_TABLE;
}

function parseRoster(raw: unknown): RosterRecognitionMode {
  return raw === "off" ? "off" : DEFAULT_ROSTER;
}

/** Shape a v1 or v2 file may carry; parsed defensively on load. */
interface OverlayConfigFile {
  enabled?: unknown;
  table?: unknown;
  roster?: unknown;
}

export const useOverlayConfigStore = defineStore("overlayConfig", () => {
  const table = ref<TableAnchorMode>(DEFAULT_TABLE);
  const roster = ref<RosterRecognitionMode>(DEFAULT_ROSTER);
  const loaded = ref(false);

  async function load() {
    if (loaded.value) return;
    loaded.value = true;
    try {
      const raw = await api.appdataRead(OVERLAY_CONFIG_FILE);
      if (raw) {
        const parsed = JSON.parse(raw) as OverlayConfigFile;
        table.value =
          parsed.table !== undefined
            ? parseTable(parsed.table)
            : // v1 migration: the legacy master switch was the table
              // overlay's on/off — enabled (or missing entirely) maps onto
              // the default, disabled onto "off".
              parsed.enabled === false
              ? "off"
              : DEFAULT_TABLE;
        // v1 had no roster switch — recognition keeps its default.
        roster.value = parseRoster(parsed.roster);
      }
    } catch {
      // missing file / parse error — keep the defaults
    }
  }

  /** Best-effort persistence in the v2 shape; in-memory state applies regardless. */
  async function persist() {
    try {
      await api.appdataWrite(
        OVERLAY_CONFIG_FILE,
        JSON.stringify({ table: table.value, roster: roster.value }),
      );
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
