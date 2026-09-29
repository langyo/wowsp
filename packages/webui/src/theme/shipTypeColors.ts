/**
 * Ship-type pie colors — the FIXED per-class palette for the
 * ship-distribution donut (lookup screen and the replay post-battle panel,
 * components/stats/ShipDistCharts). Slices used to draw from an index-based
 * palette, so a class's color drifted with data order; here every ship type
 * owns a stable color (BB red, CA green, DD yellow, CV blue, SS purple,
 * AX slate) that the user can retint in the settings appearance section.
 *
 * Stored as a JSON object keyed by the six canonical ship-type strings
 * under `wowsp-ship-type-colors`. No CSS variables are written — consumers
 * (the ECharts canvas) read the ref at render time, so no bootstrap init
 * hook is needed; the chart component watches the ref to repaint live.
 */
import { ref } from "vue";

export interface ShipTypeRgbColor {
  r: number;
  g: number;
  b: number;
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
 *  (the settings picker rows). */
export const SHIP_TYPE_COLOR_LABEL_KEYS: Record<ShipTypeColorKey, string> = {
  battleship: "Battleship",
  aircarrier: "AirCarrier",
  cruiser: "Cruiser",
  destroyer: "Destroyer",
  submarine: "Submarine",
  auxiliary: "Auxiliary",
};

export const DEFAULT_SHIP_TYPE_COLORS: Readonly<
  Record<ShipTypeColorKey, ShipTypeRgbColor>
> = {
  battleship: { r: 239, g: 68, b: 68 }, // #ef4444 red
  cruiser: { r: 34, g: 197, b: 94 }, // #22c55e green
  destroyer: { r: 250, g: 204, b: 21 }, // #facc15 yellow
  aircarrier: { r: 59, g: 130, b: 246 }, // #3b82f6 blue
  submarine: { r: 168, g: 85, b: 247 }, // #a855f7 purple
  auxiliary: { r: 148, g: 163, b: 184 }, // #94a3b8 slate gray
};

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

function loadStoredShipTypeColors(): Record<ShipTypeColorKey, ShipTypeRgbColor> {
  const colors: Record<ShipTypeColorKey, ShipTypeRgbColor> = {
    ...DEFAULT_SHIP_TYPE_COLORS,
  };
  try {
    const raw = localStorage.getItem(SHIP_TYPE_COLOR_STORAGE_KEY);
    if (raw == null) return colors;
    let healed = false;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed != null) {
        const rec = parsed as Record<string, unknown>;
        for (const key of SHIP_TYPE_COLOR_ORDER) {
          const color = sanitizeStoredColor(rec[key]);
          if (color) colors[key] = color;
          // missing / invalid entry keeps the default
          else healed = true;
        }
        // unknown keys are dropped on the rewrite below
        for (const k of Object.keys(rec)) {
          if (!(SHIP_TYPE_COLOR_ORDER as readonly string[]).includes(k)) {
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
      localStorage.setItem(SHIP_TYPE_COLOR_STORAGE_KEY, JSON.stringify(colors));
    }
    return colors;
  } catch {
    return colors;
  }
}

/** Reactive palette — the settings pickers bind to it and the charts read
 *  it at render time; writers replace the WHOLE record object so plain
 *  `watch(shipTypeColors, …)` fires. */
export const shipTypeColors = ref<Record<ShipTypeColorKey, ShipTypeRgbColor>>(
  loadStoredShipTypeColors(),
);

function persistShipTypeColors(colors: Record<ShipTypeColorKey, ShipTypeRgbColor>): void {
  try {
    localStorage.setItem(SHIP_TYPE_COLOR_STORAGE_KEY, JSON.stringify(colors));
  } catch {
    // storage unavailable — the choice holds for the session
  }
}

/** Change one ship type's color + persist (settings picker). Channels are
 *  sanitized to clamped ints. */
export function setShipTypeColor(key: ShipTypeColorKey, color: ShipTypeRgbColor): void {
  const next: Record<ShipTypeColorKey, ShipTypeRgbColor> = { ...shipTypeColors.value };
  next[key] = {
    r: clampChannel(color.r),
    g: clampChannel(color.g),
    b: clampChannel(color.b),
  };
  shipTypeColors.value = next;
  persistShipTypeColors(next);
}

/** Restore the factory palette + persist. */
export function resetShipTypeColors(): void {
  shipTypeColors.value = { ...DEFAULT_SHIP_TYPE_COLORS };
  persistShipTypeColors(shipTypeColors.value);
}

/** Chart lookup by the ship-type key the pie aggregates on
 *  (case-insensitive); unknown or missing keys fall back to the auxiliary
 *  slate gray so a new class still gets a visible slice. */
export function shipTypeChartColor(key: string): ShipTypeRgbColor {
  const k = key.toLowerCase();
  if ((SHIP_TYPE_COLOR_ORDER as readonly string[]).includes(k)) {
    return shipTypeColors.value[k as ShipTypeColorKey];
  }
  return shipTypeColors.value.auxiliary;
}

/** ShipTypeRgbColor → ECharts-friendly CSS color string. */
export function shipTypeCssColor(color: ShipTypeRgbColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}
