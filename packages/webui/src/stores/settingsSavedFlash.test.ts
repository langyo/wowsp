/** Saved-flash state: the one-second title-bar chip flag — re-entry
 *  restarts the dismiss clock (coalescing a slider's rapid writes into one
 *  flash) and the flag settles back once a second of quiet passes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notifySettingsSaved, settingsSavedFlash } from "./settingsSavedFlash";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  // Leave the flag down for the next case (a stray true would leak across
  // module state — the module owns one app-wide ref).
  settingsSavedFlash.value = false;
});

describe("settingsSavedFlash", () => {
  it("starts hidden", () => {
    expect(settingsSavedFlash.value).toBe(false);
  });

  it("flashes for one second after a notify", () => {
    notifySettingsSaved();
    expect(settingsSavedFlash.value).toBe(true);
    vi.advanceTimersByTime(999);
    expect(settingsSavedFlash.value).toBe(true);
    vi.advanceTimersByTime(1);
    expect(settingsSavedFlash.value).toBe(false);
  });

  it("restarts the clock on re-entry instead of stacking", () => {
    notifySettingsSaved();
    vi.advanceTimersByTime(600);
    notifySettingsSaved();
    // 600ms after the SECOND notify: the first flash's 1s has lapsed, but
    // the restarted clock keeps the chip up.
    vi.advanceTimersByTime(600);
    expect(settingsSavedFlash.value).toBe(true);
    vi.advanceTimersByTime(400);
    expect(settingsSavedFlash.value).toBe(false);
  });
});
