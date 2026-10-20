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

export const useOverlayConfigStore = defineStore("overlayConfig", () => {
  const table = ref<TableAnchorMode>(DEFAULT_TABLE);
  const roster = ref<RosterRecognitionMode>(DEFAULT_ROSTER);
  const aimCard = ref(DEFAULT_AIM_CARD);
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
    const snapshot = { table: table.value, roster: roster.value, aimCard: aimCard.value };
    pendingSave = pendingSave.then(async () => {
      try {
        const saved = await api.setOverlayConfig(snapshot.table, snapshot.roster, snapshot.aimCard);
        if (sequence !== saveSequence) return;
        table.value = parseTable(saved?.table);
        roster.value = parseRoster(saved?.roster);
        aimCard.value = parseAimCard(saved?.aimCard);
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

  return { table, roster, aimCard, loaded, load, setTable, setRoster, setAimCard };
});
