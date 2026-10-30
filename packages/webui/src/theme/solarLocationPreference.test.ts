/** Solar location basis preference: the storage default/heal contract and
 *  the hikari geolocation seam it drives (setGeolocationProvider /
 *  refreshThemeClock / timezoneFallback are mocked — this module only wires
 *  them, hikari owns the resolution). The module initializes its ref at
 *  import time, so each case re-imports against freshly seeded storage.
 *  The clock-refresh queue (last-switch-wins serialization, boot settle) is
 *  covered by the final describes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GeoLocationProvider } from "@celestia-island/hikari";

import { SOLAR_LOCATION_BASIS_STORAGE_KEY } from "./solarLocationPreference";

/** hikari's geolocation seam. vi.hoisted keeps ONE set of mocks across
 *  vi.resetModules(), so assertions see the calls the freshly imported
 *  module made (a factory-defined vi.fn() would be replaced on re-import). */
const hikari = vi.hoisted(() => ({
  setGeolocationProvider:
    vi.fn<(provider: GeoLocationProvider | null) => void>(),
  refreshThemeClock: vi.fn(() => Promise.resolve({ lat: 0, lng: 0 })),
  timezoneFallback: vi.fn(() => ({ lat: 31.23, lng: 120 })),
}));

const saved = vi.hoisted(() => ({ notifySettingsSaved: vi.fn() }));

vi.mock("@celestia-island/hikari", () => hikari);
vi.mock("@/stores/settingsSavedFlash", () => saved);

const TZ_LOCATION = { lat: 31.23, lng: 120 };

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function freshModule() {
  return import("./solarLocationPreference");
}

/** hikari's provider argument from the latest registration. */
function lastProvider(): GeoLocationProvider | null {
  const calls = hikari.setGeolocationProvider.mock.calls;
  return calls.length > 0 ? calls[calls.length - 1][0] : null;
}

describe("readStoredSolarLocationBasis", () => {
  it("defaults to timezone (offline estimate) with no stored value", async () => {
    const {
      SOLAR_LOCATION_BASIS_DEFAULT,
      readStoredSolarLocationBasis,
      solarLocationBasis,
    } = await freshModule();
    expect(SOLAR_LOCATION_BASIS_DEFAULT).toBe("timezone");
    expect(readStoredSolarLocationBasis()).toBe("timezone");
    expect(solarLocationBasis.value).toBe("timezone");
    // Import alone registers nothing: the boot hook does, before initTheme().
    expect(hikari.setGeolocationProvider).not.toHaveBeenCalled();
    // The default needs no heal-write — nothing is wrong on disk.
    expect(localStorage.getItem(SOLAR_LOCATION_BASIS_STORAGE_KEY)).toBeNull();
  });

  it("honors a stored coordinates choice", async () => {
    localStorage.setItem(SOLAR_LOCATION_BASIS_STORAGE_KEY, "coordinates");
    const { readStoredSolarLocationBasis, solarLocationBasis } =
      await freshModule();
    expect(readStoredSolarLocationBasis()).toBe("coordinates");
    expect(solarLocationBasis.value).toBe("coordinates");
  });

  it("falls back to timezone on a corrupt value — and heals it onto disk", async () => {
    localStorage.setItem(SOLAR_LOCATION_BASIS_STORAGE_KEY, "moon");
    const { readStoredSolarLocationBasis } = await freshModule();
    expect(readStoredSolarLocationBasis()).toBe("timezone");
    // Heal-write: the corrupt value is forced back to the default so the
    // fix sticks instead of re-defaulting on every boot.
    expect(localStorage.getItem(SOLAR_LOCATION_BASIS_STORAGE_KEY)).toBe(
      "timezone",
    );
  });

  it("degrades to timezone when storage throws", async () => {
    // happy-dom binds Storage methods PER INSTANCE (Proxy + ClassMethodBinder),
    // so the throw has to be planted on the localStorage instance itself — a
    // Storage.prototype spy never intercepts a binding already made.
    const spy = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    const { readStoredSolarLocationBasis } = await freshModule();
    expect(readStoredSolarLocationBasis()).toBe("timezone");
    spy.mockRestore();
  });
});

describe("setSolarLocationBasis", () => {
  it("persists timezone, notifies, registers the offline provider, and refreshes the clock", async () => {
    localStorage.setItem(SOLAR_LOCATION_BASIS_STORAGE_KEY, "coordinates");
    const { setSolarLocationBasis, solarLocationBasis } = await freshModule();
    setSolarLocationBasis("timezone");
    expect(solarLocationBasis.value).toBe("timezone");
    expect(localStorage.getItem(SOLAR_LOCATION_BASIS_STORAGE_KEY)).toBe(
      "timezone",
    );
    expect(saved.notifySettingsSaved).toHaveBeenCalledTimes(1);
    expect(hikari.setGeolocationProvider).toHaveBeenCalledTimes(1);
    // The timezone branch answers from hikari's sync estimate — no fetch.
    const provider = lastProvider();
    expect(provider).not.toBeNull();
    expect(await provider!()).toEqual(TZ_LOCATION);
    await vi.waitFor(() =>
      expect(hikari.refreshThemeClock).toHaveBeenCalledTimes(1),
    );
  });

  it("persists coordinates, notifies, and clears the provider for hikari's cascade", async () => {
    const { setSolarLocationBasis } = await freshModule();
    setSolarLocationBasis("coordinates");
    expect(localStorage.getItem(SOLAR_LOCATION_BASIS_STORAGE_KEY)).toBe(
      "coordinates",
    );
    expect(saved.notifySettingsSaved).toHaveBeenCalledTimes(1);
    expect(hikari.setGeolocationProvider).toHaveBeenCalledTimes(1);
    expect(lastProvider()).toBeNull();
    await vi.waitFor(() =>
      expect(hikari.refreshThemeClock).toHaveBeenCalledTimes(1),
    );
  });

  it("re-registers the timezone provider when switching back and refreshes on every switch", async () => {
    const { setSolarLocationBasis } = await freshModule();
    setSolarLocationBasis("timezone");
    setSolarLocationBasis("coordinates");
    setSolarLocationBasis("timezone");
    expect(hikari.setGeolocationProvider).toHaveBeenCalledTimes(3);
    await vi.waitFor(() =>
      expect(hikari.refreshThemeClock).toHaveBeenCalledTimes(3),
    );
    const registered = hikari.setGeolocationProvider.mock.calls.map(
      ([provider]) => provider,
    );
    expect(registered[0]).toBeTypeOf("function");
    expect(registered[1]).toBeNull();
    expect(registered[2]).toBeTypeOf("function");
    expect(await registered[2]!()).toEqual(TZ_LOCATION);
  });

  it("keeps the session choice and skips the Saved flash when the write throws", async () => {
    const { setSolarLocationBasis, solarLocationBasis } = await freshModule();
    // Instance spy, not Storage.prototype — see the getItem case above.
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    setSolarLocationBasis("coordinates");
    spy.mockRestore();
    expect(solarLocationBasis.value).toBe("coordinates");
    expect(saved.notifySettingsSaved).not.toHaveBeenCalled();
    // The seam still follows the session choice.
    expect(lastProvider()).toBeNull();
  });
});

describe("initSolarLocationPreference", () => {
  it("registers the timezone provider for the default stored basis", async () => {
    const { initSolarLocationPreference } = await freshModule();
    initSolarLocationPreference();
    expect(saved.notifySettingsSaved).not.toHaveBeenCalled();
    const provider = lastProvider();
    expect(provider).not.toBeNull();
    expect(await provider!()).toEqual(TZ_LOCATION);
    // initTheme() starts the clock against this seam — no eager refresh.
    expect(hikari.refreshThemeClock).not.toHaveBeenCalled();
  });

  it("clears the provider when the stored basis is coordinates", async () => {
    localStorage.setItem(SOLAR_LOCATION_BASIS_STORAGE_KEY, "coordinates");
    const { initSolarLocationPreference } = await freshModule();
    initSolarLocationPreference();
    expect(hikari.setGeolocationProvider).toHaveBeenCalledTimes(1);
    expect(lastProvider()).toBeNull();
    expect(hikari.refreshThemeClock).not.toHaveBeenCalled();
  });
});

describe("location helpers", () => {
  it("timezoneBasisLocation delegates to hikari's timezoneFallback", async () => {
    const { timezoneBasisLocation } = await freshModule();
    expect(timezoneBasisLocation()).toEqual(TZ_LOCATION);
    expect(hikari.timezoneFallback).toHaveBeenCalledTimes(1);
  });

  it("systemTimeZoneId returns a non-empty IANA id", async () => {
    const { systemTimeZoneId } = await freshModule();
    const zone = systemTimeZoneId();
    expect(typeof zone).toBe("string");
    expect(zone.length).toBeGreaterThan(0);
  });
});

/** The refresh queue: hikari's refreshThemeClock applies EVERY resolution
 *  it is handed, so a slow in-flight coordinates lookup must not land after
 *  a later timezone switch — the stale basis would then persist until the
 *  next switch or boot. Serialization is observable as the second refresh
 *  not starting until the first settles; the seam itself was already
 *  re-applied synchronously by the later switch. */
describe("refresh serialization", () => {
  it("queues a later switch behind a slow in-flight fix and ends on the last basis", async () => {
    const pending: Array<(geo: { lat: number; lng: number }) => void> = [];
    hikari.refreshThemeClock.mockImplementation(
      () =>
        new Promise<{ lat: number; lng: number }>((resolve) => {
          pending.push(resolve);
        }),
    );
    const { setSolarLocationBasis } = await freshModule();
    setSolarLocationBasis("coordinates");
    // Let the coordinates lookup actually get in flight first (the queue
    // starts on the next microtask, hence waitFor).
    await vi.waitFor(() =>
      expect(hikari.refreshThemeClock).toHaveBeenCalledTimes(1),
    );
    expect(pending).toHaveLength(1);
    // A later timezone switch now waits for that in-flight fix instead of
    // racing it (a race would let the stale IP fix overwrite the clock
    // AFTER the timezone resolution had already landed).
    setSolarLocationBasis("timezone");
    expect(hikari.refreshThemeClock).toHaveBeenCalledTimes(1);
    pending[0]({ lat: 1, lng: 2 });
    await vi.waitFor(() =>
      expect(hikari.refreshThemeClock).toHaveBeenCalledTimes(2),
    );
    expect(pending).toHaveLength(2);
    pending[1](TZ_LOCATION);
    // The seam still ends on the last-picked basis (the offline provider).
    const provider = lastProvider();
    expect(provider).not.toBeNull();
    expect(await provider!()).toEqual(TZ_LOCATION);
  });
});

/** The boot settle: hikari starts its own boot clock resolution inside
 *  initTheme(), before any host switch can exist, so bootstrap() queues one
 *  settle refresh behind it (settleSolarLocationPreference). Every later
 *  switch then lands after the boot fix — the stored-basis="coordinates"
 *  case where a slow boot IP fix would otherwise overwrite a switch the
 *  user already made. */
describe("settleSolarLocationPreference", () => {
  it("queues one refresh behind hikari's boot clock resolution", async () => {
    const { initSolarLocationPreference, settleSolarLocationPreference } =
      await freshModule();
    initSolarLocationPreference();
    expect(hikari.setGeolocationProvider).toHaveBeenCalledTimes(1);
    settleSolarLocationPreference();
    // The queue starts on the next microtask — not synchronously.
    expect(hikari.refreshThemeClock).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(hikari.refreshThemeClock).toHaveBeenCalledTimes(1),
    );
  });

  it("keeps a later basis switch behind the settled boot resolution", async () => {
    const pending: Array<(geo: { lat: number; lng: number }) => void> = [];
    hikari.refreshThemeClock.mockImplementation(
      () =>
        new Promise<{ lat: number; lng: number }>((resolve) => {
          pending.push(resolve);
        }),
    );
    const { settleSolarLocationPreference, setSolarLocationBasis } =
      await freshModule();
    settleSolarLocationPreference();
    setSolarLocationBasis("timezone");
    await vi.waitFor(() =>
      expect(hikari.refreshThemeClock).toHaveBeenCalledTimes(1),
    );
    expect(pending).toHaveLength(1);
    // The switch's refresh has NOT started yet — it queues behind the boot
    // settle, which itself waits for the boot resolution.
    pending[0](TZ_LOCATION);
    await vi.waitFor(() =>
      expect(hikari.refreshThemeClock).toHaveBeenCalledTimes(2),
    );
    expect(lastProvider()).not.toBeNull();
  });
});
