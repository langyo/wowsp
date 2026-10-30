/** Legacy-basis migration: the wowsp-local `wowsp-solar-location-basis`
 *  key maps onto hikari's strategy storage exactly once and never over an
 *  explicit engine-side choice. Uses the REAL hikari engine (its setter
 *  owns the persisted shape); each case re-imports against fresh storage. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SOLAR_LOCATION_STRATEGY_STORAGE_KEY } from "@celestia-island/hikari";

const LEGACY_KEY = "wowsp-solar-location-basis";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function freshModule() {
  return import("./solarStrategyMigration");
}

describe("migrateSolarLocationBasis", () => {
  it("does nothing without a legacy key", async () => {
    const { migrateSolarLocationBasis } = await freshModule();
    expect(migrateSolarLocationBasis()).toBeNull();
    expect(localStorage.getItem(SOLAR_LOCATION_STRATEGY_STORAGE_KEY)).toBeNull();
  });

  it("maps the legacy coordinates basis onto the engine's ip strategy", async () => {
    localStorage.setItem(LEGACY_KEY, "coordinates");
    const { migrateSolarLocationBasis } = await freshModule();
    expect(migrateSolarLocationBasis()).toBe("ip");
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(SOLAR_LOCATION_STRATEGY_STORAGE_KEY)).toBe("ip");
  });

  it("drops a legacy timezone basis without writing the engine key", async () => {
    localStorage.setItem(LEGACY_KEY, "timezone");
    const { migrateSolarLocationBasis } = await freshModule();
    expect(migrateSolarLocationBasis()).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    // "timezone" IS the engine default — leaving the key absent keeps a
    // future hikari default change reachable.
    expect(localStorage.getItem(SOLAR_LOCATION_STRATEGY_STORAGE_KEY)).toBeNull();
  });

  it("never overwrites an explicit engine-side strategy", async () => {
    localStorage.setItem(LEGACY_KEY, "coordinates");
    localStorage.setItem(SOLAR_LOCATION_STRATEGY_STORAGE_KEY, "manual");
    const { migrateSolarLocationBasis } = await freshModule();
    expect(migrateSolarLocationBasis()).toBeNull();
    expect(localStorage.getItem(SOLAR_LOCATION_STRATEGY_STORAGE_KEY)).toBe("manual");
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("tolerates unavailable storage", async () => {
    const { migrateSolarLocationBasis } = await freshModule();
    const spy = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    expect(migrateSolarLocationBasis()).toBeNull();
    spy.mockRestore();
  });
});
