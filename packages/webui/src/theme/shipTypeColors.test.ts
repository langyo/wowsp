/** Ship-type color preference: the exact WG official default palette, the
 *  storage sanitize / heal-write branches (including the legacy flat-blob
 *  migration onto the per-mode shape), and the chart-facing lookups. The
 *  module initializes its ref at import time, so each case re-imports
 *  against freshly seeded storage. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SHIP_TYPE_COLOR_STORAGE_KEY } from "./shipTypeColors";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

/** The module under test plus the hikari surface it binds to — imported
 *  AFTER the reset so both share one module graph. The static hikari
 *  import of a test file would pin the PRE-reset instance, whose
 *  currentMode ref is not the one the fresh store's computed reads. */
async function freshModule() {
  const [hikari, store] = await Promise.all([
    import("@celestia-island/hikari"),
    import("./shipTypeColors"),
  ]);
  return { useTheme: hikari.useTheme, ...store };
}

/** The persisted blob as an object (callers only run it after a heal). */
function stored(): { dark: Record<string, unknown>; light: Record<string, unknown> } {
  return JSON.parse(localStorage.getItem(SHIP_TYPE_COLOR_STORAGE_KEY)!);
}

/** A full six-key palette with per-class overrides on top of the defaults. */
function withOverrides(
  defaults: Record<string, { r: number; g: number; b: number }>,
  overrides: Partial<Record<string, { r: number; g: number; b: number }>>,
) {
  return { ...defaults, ...overrides };
}

describe("default palette", () => {
  it("pins the exact WG official class colors", async () => {
    const { DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
    expect(DEFAULT_SHIP_TYPE_COLORS.battleship).toEqual({ r: 209, g: 72, b: 66 }); // #d14842
    expect(DEFAULT_SHIP_TYPE_COLORS.aircarrier).toEqual({ r: 243, g: 189, b: 127 }); // #f3bd7f
    expect(DEFAULT_SHIP_TYPE_COLORS.cruiser).toEqual({ r: 52, g: 151, b: 218 }); // #3497da
    expect(DEFAULT_SHIP_TYPE_COLORS.destroyer).toEqual({ r: 207, g: 212, b: 216 }); // #cfd4d8
    expect(DEFAULT_SHIP_TYPE_COLORS.submarine).toEqual({ r: 128, g: 139, b: 141 }); // #808b8d
    // WG defines none — the distinct soft green placeholder.
    expect(DEFAULT_SHIP_TYPE_COLORS.auxiliary).toEqual({ r: 106, g: 174, b: 127 }); // #6aae7f
  });
});

describe("stored value", () => {
  it("defaults both modes to the WG palette with no stored value (nothing written)", async () => {
    const { shipTypeColors, DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
    expect(shipTypeColors.value).toEqual({
      dark: { ...DEFAULT_SHIP_TYPE_COLORS },
      light: { ...DEFAULT_SHIP_TYPE_COLORS },
    });
    expect(localStorage.getItem(SHIP_TYPE_COLOR_STORAGE_KEY)).toBe(null);
  });

  it("reads back a valid per-mode blob verbatim (no rewrite)", async () => {
    const blob = {
      dark: {
        battleship: { r: 1, g: 2, b: 3 },
        aircarrier: { r: 4, g: 5, b: 6 },
        cruiser: { r: 7, g: 8, b: 9 },
        destroyer: { r: 10, g: 11, b: 12 },
        submarine: { r: 13, g: 14, b: 15 },
        auxiliary: { r: 16, g: 17, b: 18 },
      },
      light: {
        battleship: { r: 21, g: 22, b: 23 },
        aircarrier: { r: 24, g: 25, b: 26 },
        cruiser: { r: 27, g: 28, b: 29 },
        destroyer: { r: 30, g: 31, b: 32 },
        submarine: { r: 33, g: 34, b: 35 },
        auxiliary: { r: 36, g: 37, b: 38 },
      },
    };
    localStorage.setItem(SHIP_TYPE_COLOR_STORAGE_KEY, JSON.stringify(blob));
    const { shipTypeColors } = await freshModule();
    expect(shipTypeColors.value).toEqual(blob);
    expect(stored()).toEqual(blob);
  });

  it("migrates the legacy flat palette onto BOTH modes", async () => {
    const flat = {
      battleship: { r: 1, g: 2, b: 3 },
      aircarrier: { r: 4, g: 5, b: 6 },
      cruiser: { r: 7, g: 8, b: 7 },
      destroyer: { r: 8, g: 8, b: 8 },
      submarine: { r: 9, g: 9, b: 9 },
      auxiliary: { r: 10, g: 10, b: 10 },
    };
    localStorage.setItem(SHIP_TYPE_COLOR_STORAGE_KEY, JSON.stringify(flat));
    const { shipTypeColors } = await freshModule();
    expect(shipTypeColors.value.dark).toEqual(flat);
    expect(shipTypeColors.value.light).toEqual(flat);
    // The migrated shape is forced back to disk (heal-write).
    expect(stored()).toEqual({ dark: flat, light: flat });
  });

  it("heals unparseable JSON to the defaults", async () => {
    localStorage.setItem(SHIP_TYPE_COLOR_STORAGE_KEY, "{not json");
    const { shipTypeColors, DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
    expect(shipTypeColors.value).toEqual({
      dark: { ...DEFAULT_SHIP_TYPE_COLORS },
      light: { ...DEFAULT_SHIP_TYPE_COLORS },
    });
    expect(stored()).toEqual({
      dark: { ...DEFAULT_SHIP_TYPE_COLORS },
      light: { ...DEFAULT_SHIP_TYPE_COLORS },
    });
  });

  it("heals non-object blobs (array / string / number) to the defaults", async () => {
    for (const junk of ['[1,2,3]', '"nope"', "42"]) {
      localStorage.setItem(SHIP_TYPE_COLOR_STORAGE_KEY, junk);
      // resetModules per iteration: within one test the dynamic import
      // would otherwise be cached and skip the load path entirely.
      vi.resetModules();
      const { shipTypeColors, DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
      expect(shipTypeColors.value).toEqual({
        dark: { ...DEFAULT_SHIP_TYPE_COLORS },
        light: { ...DEFAULT_SHIP_TYPE_COLORS },
      });
      expect(stored()).toEqual({
        dark: { ...DEFAULT_SHIP_TYPE_COLORS },
        light: { ...DEFAULT_SHIP_TYPE_COLORS },
      });
    }
  });

  it("heals a blob missing a whole mode to the defaults for that mode", async () => {
    localStorage.setItem(
      SHIP_TYPE_COLOR_STORAGE_KEY,
      JSON.stringify({ dark: { battleship: { r: 1, g: 1, b: 1 } } }),
    );
    vi.resetModules();
    const { shipTypeColors, DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
    expect(shipTypeColors.value.dark.battleship).toEqual({ r: 1, g: 1, b: 1 });
    expect(shipTypeColors.value.dark.cruiser).toEqual(DEFAULT_SHIP_TYPE_COLORS.cruiser);
    expect(shipTypeColors.value.light).toEqual({ ...DEFAULT_SHIP_TYPE_COLORS });
  });

  it("replaces entries with missing / non-numeric / non-finite channels by their defaults", async () => {
    // Hand-written JSON: 1e999 parses to Infinity, proving the finite
    // check (not just the typeof check) rejects it. The literal cannot be
    // written as a JS number without losing precision.
    localStorage.setItem(
      SHIP_TYPE_COLOR_STORAGE_KEY,
      '{"dark":{"battleship":{"r":1,"g":2},"cruiser":{"r":"3","g":4,"b":5},"submarine":{"r":null,"g":0,"b":0},"aircarrier":{"r":1e999,"g":0,"b":0}}}',
    );
    const { shipTypeColors, DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
    // missing channel / non-numeric channel / null channel / Infinity:
    expect(shipTypeColors.value.dark.battleship).toEqual(DEFAULT_SHIP_TYPE_COLORS.battleship);
    expect(shipTypeColors.value.dark.cruiser).toEqual(DEFAULT_SHIP_TYPE_COLORS.cruiser);
    expect(shipTypeColors.value.dark.submarine).toEqual(DEFAULT_SHIP_TYPE_COLORS.submarine);
    expect(shipTypeColors.value.dark.aircarrier).toEqual(DEFAULT_SHIP_TYPE_COLORS.aircarrier);
    // Absent entries (destroyer / auxiliary here) heal to defaults too.
    expect(stored()).toEqual({
      dark: { ...DEFAULT_SHIP_TYPE_COLORS },
      light: { ...DEFAULT_SHIP_TYPE_COLORS },
    });
  });

  it("clamps out-of-range finite channels and normalizes them onto disk", async () => {
    localStorage.setItem(
      SHIP_TYPE_COLOR_STORAGE_KEY,
      JSON.stringify({ dark: { battleship: { r: 300, g: -20, b: 240.5 } } }),
    );
    const { shipTypeColors } = await freshModule();
    expect(shipTypeColors.value.dark.battleship).toEqual({ r: 255, g: 0, b: 241 });
    expect(stored().dark.battleship).toEqual({ r: 255, g: 0, b: 241 });
  });

  it("drops unknown keys while keeping valid entries", async () => {
    localStorage.setItem(
      SHIP_TYPE_COLOR_STORAGE_KEY,
      JSON.stringify({ light: { battleship: { r: 9, g: 9, b: 9 }, torpedo_boat: { r: 1, g: 1, b: 1 } } }),
    );
    const { shipTypeColors, DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
    expect(shipTypeColors.value.light.battleship).toEqual({ r: 9, g: 9, b: 9 });
    expect(stored().light).toEqual(
      withOverrides({ ...DEFAULT_SHIP_TYPE_COLORS }, { battleship: { r: 9, g: 9, b: 9 } }),
    );
    expect(Object.keys(stored().light)).not.toContain("torpedo_boat");
  });

  it("heals exactly once — the rewritten blob reloads verbatim", async () => {
    localStorage.setItem(SHIP_TYPE_COLOR_STORAGE_KEY, "{bad");
    const first = await freshModule();
    const healed = localStorage.getItem(SHIP_TYPE_COLOR_STORAGE_KEY)!;
    expect(healed).not.toBe("{bad");
    // Second module load (next boot): the healed storage needs no repair.
    vi.resetModules();
    const second = await freshModule();
    expect(second.shipTypeColors.value).toEqual(first.shipTypeColors.value);
    expect(localStorage.getItem(SHIP_TYPE_COLOR_STORAGE_KEY)).toBe(healed);
  });

  it("prunes unknown top-level siblings of dark/light", async () => {
    localStorage.setItem(
      SHIP_TYPE_COLOR_STORAGE_KEY,
      JSON.stringify({ dark: {}, junk: { a: 1 } }),
    );
    const { shipTypeColors, DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
    expect(shipTypeColors.value).toEqual({
      dark: { ...DEFAULT_SHIP_TYPE_COLORS },
      light: { ...DEFAULT_SHIP_TYPE_COLORS },
    });
    expect(Object.keys(stored())).toEqual(["dark", "light"]);
  });
});

describe("setShipTypeColor", () => {
  it("replaces the whole record objects (new identity) and persists per mode", async () => {
    const { shipTypeColors, setShipTypeColor } = await freshModule();
    const before = shipTypeColors.value;
    setShipTypeColor("dark", "destroyer", { r: 12, g: 34, b: 56 });
    // Plain watch(shipTypeColors, …) fires — the identity changed.
    expect(shipTypeColors.value).not.toBe(before);
    expect(shipTypeColors.value.dark.destroyer).toEqual({ r: 12, g: 34, b: 56 });
    // The other mode and everything else ride along untouched.
    expect(shipTypeColors.value.light.destroyer).toEqual(before.light.destroyer);
    expect(shipTypeColors.value.dark.battleship).toEqual(before.dark.battleship);
    expect(stored().dark.destroyer).toEqual({ r: 12, g: 34, b: 56 });
  });

  it("sanitizes channels to clamped ints before persisting", async () => {
    const { shipTypeColors, setShipTypeColor } = await freshModule();
    setShipTypeColor("light", "cruiser", { r: 999, g: -3, b: 12.6 });
    expect(shipTypeColors.value.light.cruiser).toEqual({ r: 255, g: 0, b: 13 });
    expect(stored().light.cruiser).toEqual({ r: 255, g: 0, b: 13 });
  });
});

describe("setShipTypePalette", () => {
  it("writes several slots in one store update and persists", async () => {
    const { shipTypeColors, setShipTypePalette } = await freshModule();
    const before = shipTypeColors.value;
    setShipTypePalette("dark", {
      battleship: { r: 1, g: 1, b: 1 },
      cruiser: { r: 2, g: 2, b: 2 },
    });
    expect(shipTypeColors.value).not.toBe(before);
    expect(shipTypeColors.value.dark.battleship).toEqual({ r: 1, g: 1, b: 1 });
    expect(shipTypeColors.value.dark.cruiser).toEqual({ r: 2, g: 2, b: 2 });
    // The other mode rides along untouched.
    expect(shipTypeColors.value.light.battleship).toEqual(before.light.battleship);
    expect(stored().dark.battleship).toEqual({ r: 1, g: 1, b: 1 });
  });

  it("clamps channels and ignores unknown slots", async () => {
    const { shipTypeColors, setShipTypePalette, DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
    setShipTypePalette("light", {
      submarine: { r: 300, g: -1, b: 10.4 },
      torpedo_boat: { r: 1, g: 2, b: 3 },
    } as Partial<Record<string, { r: number; g: number; b: number }>>);
    expect(shipTypeColors.value.light.submarine).toEqual({ r: 255, g: 0, b: 10 });
    expect(shipTypeColors.value.light.battleship).toEqual(DEFAULT_SHIP_TYPE_COLORS.battleship);
    expect(stored().light).toEqual(
      withOverrides({ ...DEFAULT_SHIP_TYPE_COLORS }, { submarine: { r: 255, g: 0, b: 10 } }),
    );
  });
});

describe("resetShipTypeColors", () => {
  it("restores the factory palette in BOTH modes and persists", async () => {
    const { shipTypeColors, setShipTypeColor, resetShipTypeColors, DEFAULT_SHIP_TYPE_COLORS } =
      await freshModule();
    setShipTypeColor("dark", "battleship", { r: 1, g: 1, b: 1 });
    setShipTypeColor("light", "cruiser", { r: 2, g: 2, b: 2 });
    const customized = shipTypeColors.value;
    resetShipTypeColors();
    expect(shipTypeColors.value).not.toBe(customized);
    expect(shipTypeColors.value).toEqual({
      dark: { ...DEFAULT_SHIP_TYPE_COLORS },
      light: { ...DEFAULT_SHIP_TYPE_COLORS },
    });
    expect(stored()).toEqual({
      dark: { ...DEFAULT_SHIP_TYPE_COLORS },
      light: { ...DEFAULT_SHIP_TYPE_COLORS },
    });
  });
});

describe("shipTypeChartColor / shipTypeCssColor", () => {
  it("looks the palette up case-insensitively (the pie keys are lowercase)", async () => {
    const { shipTypeChartColor, setShipTypeColor, useTheme } = await freshModule();
    // The mode ref defaults to "system" (clock-resolved); pin dark so the
    // per-mode assertions are deterministic.
    useTheme().currentMode.value = "dark";
    setShipTypeColor("dark", "destroyer", { r: 10, g: 20, b: 30 });
    expect(shipTypeChartColor("destroyer")).toEqual({ r: 10, g: 20, b: 30 });
    expect(shipTypeChartColor("Destroyer")).toEqual({ r: 10, g: 20, b: 30 });
    expect(shipTypeChartColor("DESTROYER")).toEqual({ r: 10, g: 20, b: 30 });
  });

  it("resolves against the EFFECTIVE theme mode (per-mode palettes)", async () => {
    const { shipTypeChartColor, setShipTypeColor, useTheme } = await freshModule();
    const theme = useTheme();
    // The mode ref defaults to "system" (solar-resolved, clock-dependent);
    // pin it so the assertion is deterministic, then flip it.
    theme.currentMode.value = "dark";
    setShipTypeColor("dark", "cruiser", { r: 1, g: 1, b: 1 });
    setShipTypeColor("light", "cruiser", { r: 2, g: 2, b: 2 });
    expect(shipTypeChartColor("cruiser")).toEqual({ r: 1, g: 1, b: 1 });
    theme.currentMode.value = "light";
    expect(shipTypeChartColor("cruiser")).toEqual({ r: 2, g: 2, b: 2 });
  });

  it("falls back to the auxiliary color for unknown or missing keys", async () => {
    const { shipTypeChartColor, setShipTypeColor, useTheme } = await freshModule();
    useTheme().currentMode.value = "dark";
    setShipTypeColor("dark", "auxiliary", { r: 7, g: 8, b: 9 });
    expect(shipTypeChartColor("torpedo_boat")).toEqual({ r: 7, g: 8, b: 9 });
    expect(shipTypeChartColor("")).toEqual({ r: 7, g: 8, b: 9 });
  });

  it("formats the ECharts-friendly rgb() CSS string", async () => {
    const { shipTypeCssColor } = await freshModule();
    expect(shipTypeCssColor({ r: 239, g: 68, b: 68 })).toBe("rgb(239, 68, 68)");
  });
});
