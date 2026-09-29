/** Ship-type color preference: the exact WG official default palette, the
 *  storage sanitize / heal-write branches, and the chart-facing lookups.
 *  The module initializes its ref at import time, so each case re-imports
 *  against freshly seeded storage. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SHIP_TYPE_COLOR_STORAGE_KEY } from "./shipTypeColors";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function freshModule() {
  return import("./shipTypeColors");
}

/** The persisted blob as an object (callers only run it after a heal). */
function stored(): Record<string, { r: number; g: number; b: number }> {
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
  it("defaults to the WG palette with no stored value (nothing written)", async () => {
    const { shipTypeColors, DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
    expect(shipTypeColors.value).toEqual({ ...DEFAULT_SHIP_TYPE_COLORS });
    expect(localStorage.getItem(SHIP_TYPE_COLOR_STORAGE_KEY)).toBe(null);
  });

  it("reads back a valid stored palette verbatim (no rewrite)", async () => {
    const blob = {
      battleship: { r: 1, g: 2, b: 3 },
      aircarrier: { r: 4, g: 5, b: 6 },
      cruiser: { r: 7, g: 8, b: 9 },
      destroyer: { r: 10, g: 11, b: 12 },
      submarine: { r: 13, g: 14, b: 15 },
      auxiliary: { r: 16, g: 17, b: 18 },
    };
    localStorage.setItem(SHIP_TYPE_COLOR_STORAGE_KEY, JSON.stringify(blob));
    const { shipTypeColors } = await freshModule();
    expect(shipTypeColors.value).toEqual(blob);
    expect(stored()).toEqual(blob);
  });

  it("heals unparseable JSON to the defaults", async () => {
    localStorage.setItem(SHIP_TYPE_COLOR_STORAGE_KEY, "{not json");
    const { shipTypeColors, DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
    expect(shipTypeColors.value).toEqual({ ...DEFAULT_SHIP_TYPE_COLORS });
    expect(stored()).toEqual({ ...DEFAULT_SHIP_TYPE_COLORS });
  });

  it("heals non-object blobs (array / string / number) to the defaults", async () => {
    for (const junk of ['[1,2,3]', '"nope"', "42"]) {
      localStorage.setItem(SHIP_TYPE_COLOR_STORAGE_KEY, junk);
      // resetModules per iteration: within one test the dynamic import
      // would otherwise be cached and skip the load path entirely.
      vi.resetModules();
      const { shipTypeColors, DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
      expect(shipTypeColors.value).toEqual({ ...DEFAULT_SHIP_TYPE_COLORS });
      expect(stored()).toEqual({ ...DEFAULT_SHIP_TYPE_COLORS });
    }
  });

  it("replaces entries with missing / non-numeric / non-finite channels by their defaults", async () => {
    // Hand-written JSON: 1e999 parses to Infinity, proving the finite
    // check (not just the typeof check) rejects it. The literal cannot be
    // written as a JS number without losing precision.
    localStorage.setItem(
      SHIP_TYPE_COLOR_STORAGE_KEY,
      '{"battleship":{"r":1,"g":2},"cruiser":{"r":"3","g":4,"b":5},"submarine":{"r":null,"g":0,"b":0},"aircarrier":{"r":1e999,"g":0,"b":0}}',
    );
    const { shipTypeColors, DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
    // missing channel / non-numeric channel / null channel / Infinity:
    expect(shipTypeColors.value.battleship).toEqual(DEFAULT_SHIP_TYPE_COLORS.battleship);
    expect(shipTypeColors.value.cruiser).toEqual(DEFAULT_SHIP_TYPE_COLORS.cruiser);
    expect(shipTypeColors.value.submarine).toEqual(DEFAULT_SHIP_TYPE_COLORS.submarine);
    expect(shipTypeColors.value.aircarrier).toEqual(DEFAULT_SHIP_TYPE_COLORS.aircarrier);
    // Absent entries (destroyer / auxiliary here) heal to defaults too.
    expect(stored()).toEqual({ ...DEFAULT_SHIP_TYPE_COLORS });
  });

  it("clamps out-of-range finite channels and normalizes them onto disk", async () => {
    localStorage.setItem(
      SHIP_TYPE_COLOR_STORAGE_KEY,
      JSON.stringify({ battleship: { r: 300, g: -20, b: 240.5 } }),
    );
    const { shipTypeColors } = await freshModule();
    expect(shipTypeColors.value.battleship).toEqual({ r: 255, g: 0, b: 241 });
    expect(stored().battleship).toEqual({ r: 255, g: 0, b: 241 });
  });

  it("drops unknown keys while keeping valid entries", async () => {
    localStorage.setItem(
      SHIP_TYPE_COLOR_STORAGE_KEY,
      JSON.stringify({
        battleship: { r: 9, g: 9, b: 9 },
        torpedo_boat: { r: 1, g: 1, b: 1 },
      }),
    );
    const { shipTypeColors, DEFAULT_SHIP_TYPE_COLORS } = await freshModule();
    expect(shipTypeColors.value.battleship).toEqual({ r: 9, g: 9, b: 9 });
    expect(stored()).toEqual(withOverrides({ ...DEFAULT_SHIP_TYPE_COLORS }, { battleship: { r: 9, g: 9, b: 9 } }));
    expect(Object.keys(stored())).not.toContain("torpedo_boat");
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
});

describe("setShipTypeColor", () => {
  it("replaces the whole record object (new identity) and persists", async () => {
    const { shipTypeColors, setShipTypeColor } = await freshModule();
    const before = shipTypeColors.value;
    setShipTypeColor("destroyer", { r: 12, g: 34, b: 56 });
    // Plain watch(shipTypeColors, …) fires — the identity changed.
    expect(shipTypeColors.value).not.toBe(before);
    expect(shipTypeColors.value.destroyer).toEqual({ r: 12, g: 34, b: 56 });
    // Everything else rides along untouched.
    expect(shipTypeColors.value.battleship).toEqual(before.battleship);
    expect(stored().destroyer).toEqual({ r: 12, g: 34, b: 56 });
  });

  it("sanitizes channels to clamped ints before persisting", async () => {
    const { shipTypeColors, setShipTypeColor } = await freshModule();
    setShipTypeColor("cruiser", { r: 999, g: -3, b: 12.6 });
    expect(shipTypeColors.value.cruiser).toEqual({ r: 255, g: 0, b: 13 });
    expect(stored().cruiser).toEqual({ r: 255, g: 0, b: 13 });
  });
});

describe("resetShipTypeColors", () => {
  it("restores the factory palette (new identity) and persists", async () => {
    const { shipTypeColors, setShipTypeColor, resetShipTypeColors, DEFAULT_SHIP_TYPE_COLORS } =
      await freshModule();
    setShipTypeColor("battleship", { r: 1, g: 1, b: 1 });
    const customized = shipTypeColors.value;
    resetShipTypeColors();
    expect(shipTypeColors.value).not.toBe(customized);
    expect(shipTypeColors.value).toEqual({ ...DEFAULT_SHIP_TYPE_COLORS });
    expect(stored()).toEqual({ ...DEFAULT_SHIP_TYPE_COLORS });
  });
});

describe("shipTypeChartColor / shipTypeCssColor", () => {
  it("looks the palette up case-insensitively (the pie keys are lowercase)", async () => {
    const { shipTypeChartColor, setShipTypeColor } = await freshModule();
    setShipTypeColor("destroyer", { r: 10, g: 20, b: 30 });
    expect(shipTypeChartColor("destroyer")).toEqual({ r: 10, g: 20, b: 30 });
    expect(shipTypeChartColor("Destroyer")).toEqual({ r: 10, g: 20, b: 30 });
    expect(shipTypeChartColor("DESTROYER")).toEqual({ r: 10, g: 20, b: 30 });
  });

  it("falls back to the auxiliary color for unknown or missing keys", async () => {
    const { shipTypeChartColor, setShipTypeColor } = await freshModule();
    setShipTypeColor("auxiliary", { r: 7, g: 8, b: 9 });
    expect(shipTypeChartColor("torpedo_boat")).toEqual({ r: 7, g: 8, b: 9 });
    expect(shipTypeChartColor("")).toEqual({ r: 7, g: 8, b: 9 });
  });

  it("formats the ECharts-friendly rgb() CSS string", async () => {
    const { shipTypeCssColor } = await freshModule();
    expect(shipTypeCssColor({ r: 239, g: 68, b: 68 })).toBe("rgb(239, 68, 68)");
  });
});
