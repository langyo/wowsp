/**
 * Ship-type pie colors — the FIXED per-class palette for the
 * ship-distribution donut (lookup screen and the replay post-battle panel,
 * components/stats/ShipDistCharts). Slices used to draw from an index-based
 * palette, so a class's color drifted with data order; here every ship type
 * owns a stable color (the WG official class colors; see
 * DEFAULT_SHIP_TYPE_COLORS below) that the user can retint in the color
 * scheme editor window (ThemeSchemeDialog, via the hikari token-group
 * registry — see theme/shipTypeTokenGroup).
 *
 * The palette is per MODE (dark / light), matching the scheme editor's
 * per-mode grammar: the store carries one palette per mode and the chart
 * resolves against the effective theme mode, so a class can read darker on
 * the light surface without giving up its dark-mode tint. The stored blob
 * started as a single flat palette; loader migrates it onto both modes.
 *
 * Stored as a JSON object `{ dark, light }` keyed by the six canonical
 * ship-type strings under `wowsp-ship-type-colors`. No CSS variables are
 * written by THIS module — consumers (the SVG donut's computeds) read the
 * ref while rendering, so palette edits repaint the chart live for free.
 */
import { ref } from "vue";

import { useTheme } from "@celestia-island/hikari";

export interface ShipTypeRgbColor {
  r: number;
  g: number;
  b: number;
}

/** One mode's palette — the six canonical keys, always complete. */
export type ShipTypeColorPalette = Record<ShipTypeColorKey, ShipTypeRgbColor>;

/** The whole store: one palette per theme mode. */
export interface ShipTypeColorModes {
  dark: ShipTypeColorPalette;
  light: ShipTypeColorPalette;
}

export const SHIP_TYPE_COLOR_STORAGE_KEY = "wowsp-ship-type-colors";

/** Canonical keys — the LOWERCASE ship-type strings the pie chart
 *  aggregates on (they equal the i18n keys stats.dist.<key>). */
export const SHIP_TYPE_COLOR_ORDER = [
  "battleship",
  "aircarrier",
  "cruiser",
  "destroyer",
  "submarine",
  "auxiliary",
] as const;

export type ShipTypeColorKey = (typeof SHIP_TYPE_COLOR_ORDER)[number];

/** CamelCase WG type names for the FULL-NAME i18n labels ships.type.<Name>
 *  (the scheme editor's token-group slot labels). */
export const SHIP_TYPE_COLOR_LABEL_KEYS: Record<ShipTypeColorKey, string> = {
  battleship: "Battleship",
  aircarrier: "AirCarrier",
  cruiser: "Cruiser",
  destroyer: "Destroyer",
  submarine: "Submarine",
  auxiliary: "Auxiliary",
};

/**
 * Factory palette — WG OFFICIAL class colors, extracted from the bundled
 * main.js of profile.worldofwarships.com (their literal map:
 * `{aircarrier:"#f3bd7f", battleship:"#d14842", cruiser:"#3497da",
 * destroyer:"#cfd4d8", submarine:"#808b8d"}`). WG defines no auxiliary
 * color, so that class takes a distinct soft green to stay visible next to
 * the destroyer silver-gray. The same palette seeds BOTH modes.
 */
export const DEFAULT_SHIP_TYPE_COLORS: Readonly<ShipTypeColorPalette> = {
  battleship: { r: 209, g: 72, b: 66 }, // #d14842 red
  cruiser: { r: 52, g: 151, b: 218 }, // #3497da blue
  destroyer: { r: 207, g: 212, b: 216 }, // #cfd4d8 silver gray
  aircarrier: { r: 243, g: 189, b: 127 }, // #f3bd7f flesh
  submarine: { r: 128, g: 139, b: 141 }, // #808b8d gray
  auxiliary: { r: 106, g: 174, b: 127 }, // #6aae7f soft green
};

function defaultModes(): ShipTypeColorModes {
  return {
    dark: { ...DEFAULT_SHIP_TYPE_COLORS },
    light: { ...DEFAULT_SHIP_TYPE_COLORS },
  };
}

function clampChannel(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}

/** One stored entry → sanitized color, or null when the entry is junk
 *  (not an object / non-numeric or missing channels) and must heal to the
 *  default. Finite numbers are clamped into range, never rejected. */
function sanitizeStoredColor(entry: unknown): ShipTypeRgbColor | null {
  if (typeof entry !== "object" || entry == null) return null;
  const { r, g, b } = entry as Record<string, unknown>;
  if (
    typeof r !== "number" ||
    !Number.isFinite(r) ||
    typeof g !== "number" ||
    !Number.isFinite(g) ||
    typeof b !== "number" ||
    !Number.isFinite(b)
  ) {
    return null;
  }
  return {
    r: clampChannel(r),
    g: clampChannel(g),
    b: clampChannel(b),
  };
}

/** One stored palette (flat six-key record) → sanitized copy + whether any
 *  entry needed healing. Missing/invalid entries keep the default. */
function sanitizeStoredPalette(
  raw: Record<string, unknown>,
  base: ShipTypeColorPalette,
): { palette: ShipTypeColorPalette; healed: boolean } {
  const palette: ShipTypeColorPalette = { ...base };
  let healed = false;
  for (const key of SHIP_TYPE_COLOR_ORDER) {
    const color = sanitizeStoredColor(raw[key]);
    if (color) {
      palette[key] = color;
      const rawColor = raw[key] as { r: number; g: number; b: number };
      if (rawColor.r !== color.r || rawColor.g !== color.g || rawColor.b !== color.b) {
        healed = true;
      }
    } else {
      healed = true;
    }
  }
  // Unknown keys are dropped — flag them so the rewrite below prunes them.
  for (const k of Object.keys(raw)) {
    if (!(SHIP_TYPE_COLOR_ORDER as readonly string[]).includes(k)) {
      healed = true;
    }
  }
  return { palette, healed };
}

function loadStoredShipTypeColors(): ShipTypeColorModes {
  const modes = defaultModes();
  try {
    const raw = localStorage.getItem(SHIP_TYPE_COLOR_STORAGE_KEY);
    if (raw == null) return modes;
    let healed = false;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed != null) {
        const rec = parsed as Record<string, unknown>;
        if (typeof rec.dark === "object" && rec.dark != null) {
          const res = sanitizeStoredPalette(rec.dark as Record<string, unknown>, modes.dark);
          modes.dark = res.palette;
          healed = res.healed || healed;
        } else {
          healed = true;
        }
        if (typeof rec.light === "object" && rec.light != null) {
          const res = sanitizeStoredPalette(rec.light as Record<string, unknown>, modes.light);
          modes.light = res.palette;
          healed = res.healed || healed;
        } else {
          healed = true;
        }
        // Legacy flat blob (the pre-per-mode shape): migrate the one
        // palette onto BOTH modes rather than dropping the preference.
        const looksFlat =
          typeof rec.dark !== "object" &&
          typeof rec.light !== "object" &&
          typeof rec.battleship === "object";
        if (looksFlat) {
          const migrated = sanitizeStoredPalette(rec, modes.dark).palette;
          modes.dark = migrated;
          modes.light = { ...migrated };
          healed = true;
        }
        // Unknown top-level keys (junk siblings of dark/light) are dropped
        // on the rewrite below, same contract as unknown palette keys.
        for (const k of Object.keys(rec)) {
          if (k !== "dark" && k !== "light") {
            healed = true;
          }
        }
      } else {
        healed = true; // non-object blob — defaults take over
      }
    } catch {
      healed = true; // unparseable blob — defaults take over
    }
    // Heal-write: same contract as the other preference modules — a blob
    // that needed repair is forced back to disk so the correction sticks
    // instead of re-healing on every boot.
    if (healed) {
      localStorage.setItem(SHIP_TYPE_COLOR_STORAGE_KEY, JSON.stringify(modes));
    }
    return modes;
  } catch {
    return modes;
  }
}

/** Reactive store — the scheme editor's token group binds to it and the
 *  charts read it (through the mode-aware lookup) at render time; writers
 *  replace the WHOLE record objects so plain `watch(shipTypeColors, …)`
 *  fires. */
export const shipTypeColors = ref<ShipTypeColorModes>(loadStoredShipTypeColors());

function persistShipTypeColors(modes: ShipTypeColorModes): void {
  try {
    localStorage.setItem(SHIP_TYPE_COLOR_STORAGE_KEY, JSON.stringify(modes));
  } catch {
    // storage unavailable — the choice holds for the session
  }
}

/** Change one ship type's color in ONE mode + persist (scheme editor).
 *  Channels are sanitized to clamped ints. */
export function setShipTypeColor(
  mode: "dark" | "light",
  key: ShipTypeColorKey,
  color: ShipTypeRgbColor,
): void {
  setShipTypePalette(mode, { [key]: color } as Partial<ShipTypeColorPalette>);
}

/** Change SEVERAL ship type colors in ONE mode with a single persist —
 *  the batch form the scheme editor's save path uses (a six-slot draft
 *  must not write the store twelve times). Channels are sanitized to
 *  clamped ints; slots absent from `partial` ride along untouched. */
export function setShipTypePalette(
  mode: "dark" | "light",
  partial: Partial<ShipTypeColorPalette>,
): void {
  const palette: ShipTypeColorPalette = { ...shipTypeColors.value[mode] };
  for (const key of SHIP_TYPE_COLOR_ORDER) {
    const color = partial[key];
    if (!color) continue;
    palette[key] = {
      r: clampChannel(color.r),
      g: clampChannel(color.g),
      b: clampChannel(color.b),
    };
  }
  shipTypeColors.value = { ...shipTypeColors.value, [mode]: palette };
  persistShipTypeColors(shipTypeColors.value);
}

/** Restore the factory palette in BOTH modes + persist. */
export function resetShipTypeColors(): void {
  shipTypeColors.value = defaultModes();
  persistShipTypeColors(shipTypeColors.value);
}

// Mode-aware chart lookup. hikari's useTheme() builds fresh computeds per
// call, so the effective-mode computed is created ONCE at module scope and
// shared by every lookup — reading it inside a chart computed keeps the
// donut tracking dark/light switches reactively.
const effectiveMode = useTheme().effectiveMode;

/** Chart lookup by the ship-type key the donut aggregates on
 *  (case-insensitive), resolved against the EFFECTIVE theme mode; unknown
 *  or missing keys fall back to the auxiliary class's own color so a new
 *  class still gets a visible slice. */
export function shipTypeChartColor(key: string): ShipTypeRgbColor {
  const k = key.toLowerCase();
  const palette = shipTypeColors.value[effectiveMode.value];
  if ((SHIP_TYPE_COLOR_ORDER as readonly string[]).includes(k)) {
    return palette[k as ShipTypeColorKey];
  }
  return palette.auxiliary;
}

/** ShipTypeRgbColor → CSS color string (SVG fill / legend dot). */
export function shipTypeCssColor(color: ShipTypeRgbColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}
