import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import {
  applyDpiPrefs,
  DPI_MAX,
  DPI_MIN,
  DPI_REVERT_SECONDS,
  DPI_STEP,
  getDpiCountdownRemaining,
  getDpiCountdownRemainingMs,
  getPreviewedDpiScale,
  initDpiPrefs,
  isDpiCountdownActive,
  isDpiRisky,
  keepDpiScale,
  loadDpiScale,
  previewDpiScale,
  resetDpiScale,
  revertPreviewDpiScale,
  saveDpiScale,
  resetAppliedDpiScaleForTest,
  shutdownDpiPrefs,
  useAppliedDpiScale,
  useDpiCountdown,
} from "./dpiPrefs";

function resetRootScale() {
  delete document.documentElement.dataset.dpiScale;
  document.documentElement.style.removeProperty("zoom");
}

describe("dpiPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
    resetRootScale();
  });

  afterEach(() => {
    // Every initDpiPrefs() call arms an app-lifetime resize listener;
    // drop it so tests never leak handlers into each other.
    shutdownDpiPrefs();
  });

  it("exposes the 100–300 range with 25% notches and a 10s revert window", () => {
    expect(DPI_MIN).toBe(100);
    expect(DPI_MAX).toBe(300);
    expect(DPI_STEP).toBe(25);
    expect((DPI_MAX - DPI_MIN) / DPI_STEP).toBe(8);
    expect(DPI_REVERT_SECONDS).toBe(10);
  });

  it("returns null (Auto) when nothing is stored", () => {
    expect(loadDpiScale()).toBeNull();
  });

  it("round-trips a saved manual scale", () => {
    saveDpiScale(150);
    expect(loadDpiScale()).toBe(150);
    saveDpiScale(null);
    expect(loadDpiScale()).toBeNull();
  });

  it("falls back to Auto for invalid stored values — and heals them off disk", () => {
    for (const raw of ["42", "400", "chonky"]) {
      localStorage.setItem("wowsp-dpi", raw);
      expect(loadDpiScale()).toBeNull();
      // Heal-write: the invalid value is removed (Auto is the key's
      // absence) so the fix sticks instead of re-defaulting every boot.
      expect(localStorage.getItem("wowsp-dpi")).toBeNull();
    }
  });

  it("applyDpiPrefs sets root CSS zoom and the dataset notch", () => {
    saveDpiScale(175);
    applyDpiPrefs();
    expect(document.documentElement.dataset.dpiScale).toBe("175");
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.75");
  });

  it("applyDpiPrefs clears the override in Auto so the browser zoom rules", () => {
    saveDpiScale(200);
    applyDpiPrefs();
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("2");
    saveDpiScale(null);
    applyDpiPrefs();
    expect(document.documentElement.dataset.dpiScale).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("");
  });

  it("initDpiPrefs applies the persisted preference at boot", () => {
    saveDpiScale(125);
    initDpiPrefs();
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.25");
  });
});

describe("isDpiRisky", () => {
  it("flags scales that squeeze a 390px window under the 360px layout floor", () => {
    expect(isDpiRisky(250, 390)).toBe(true); // 390 / 2.5 = 156px effective
    expect(isDpiRisky(150, 390)).toBe(true); // 390 / 1.5 = 260px effective
  });

  it("leaves mid-range scales safe on viewports wide enough for them", () => {
    expect(isDpiRisky(125, 500)).toBe(false); // 500 / 1.25 = 400px effective
    expect(isDpiRisky(150, 500)).toBe(true); // 500 / 1.5 = 333px effective
  });

  it("never flags desktop-width viewports", () => {
    expect(isDpiRisky(300, 1920)).toBe(false); // 1920 / 3 = 640px effective
  });

  it("treats the 360px floor as a strict boundary", () => {
    expect(isDpiRisky(100, 360)).toBe(false); // exactly at the floor is fine
    expect(isDpiRisky(125, 400)).toBe(true); // 400 / 1.25 = 320px effective
  });

  it("rejects nonsensical scales instead of dividing by zero", () => {
    expect(isDpiRisky(0, 390)).toBe(false);
    expect(isDpiRisky(Number.NaN, 390)).toBe(false);
  });
});

describe("initDpiPrefs boot guard", () => {
  beforeEach(() => {
    localStorage.clear();
    resetRootScale();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    shutdownDpiPrefs();
  });

  it("clears a persisted scale that is risky for the current viewport", () => {
    saveDpiScale(250);
    vi.stubGlobal("innerWidth", 390);
    initDpiPrefs();
    expect(loadDpiScale()).toBeNull();
    expect(document.documentElement.dataset.dpiScale).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("");
  });

  it("keeps a persisted scale that fits the current viewport", () => {
    saveDpiScale(150);
    vi.stubGlobal("innerWidth", 1200);
    initDpiPrefs();
    expect(loadDpiScale()).toBe(150);
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.5");
  });
});

describe("preview / keep / revert lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    resetRootScale();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    shutdownDpiPrefs();
  });

  it("applies a risky preview without persisting it and starts the countdown", () => {
    vi.stubGlobal("innerWidth", 390);
    saveDpiScale(100);
    previewDpiScale(250);
    expect(document.documentElement.dataset.dpiScale).toBe("250");
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("2.5");
    expect(loadDpiScale()).toBe(100); // unchanged — preview only
    expect(getPreviewedDpiScale()).toBe(250);
    expect(isDpiCountdownActive()).toBe(true);
    // The app-level store reflects the running countdown task.
    const countdown = useDpiCountdown();
    expect(countdown.active).toBe(true);
    expect(countdown.remaining).toBe(DPI_REVERT_SECONDS);
    expect(countdown.scale).toBe(250);
  });

  it("exposes the remaining countdown time through the store", () => {
    vi.stubGlobal("innerWidth", 390);
    previewDpiScale(250);
    expect(getDpiCountdownRemainingMs()).toBe(DPI_REVERT_SECONDS * 1000);
    expect(getDpiCountdownRemaining()).toBe(DPI_REVERT_SECONDS);
    // The controller ticks once a second, decrementing whole seconds.
    vi.advanceTimersByTime(2500);
    expect(useDpiCountdown().remaining).toBe(DPI_REVERT_SECONDS - 2);
    expect(getDpiCountdownRemaining()).toBe(DPI_REVERT_SECONDS - 2);
    expect(getDpiCountdownRemainingMs()).toBe((DPI_REVERT_SECONDS - 2) * 1000);
  });

  it("reverts to the persisted value and resets the store when the countdown expires", () => {
    vi.stubGlobal("innerWidth", 390);
    saveDpiScale(100);
    previewDpiScale(250);
    vi.advanceTimersByTime(DPI_REVERT_SECONDS * 1000);
    expect(isDpiCountdownActive()).toBe(false);
    expect(getPreviewedDpiScale()).toBeNull();
    const countdown = useDpiCountdown();
    expect(countdown.active).toBe(false);
    expect(countdown.remaining).toBe(0);
    expect(countdown.scale).toBeNull();
    expect(document.documentElement.dataset.dpiScale).toBe("100");
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1");
    expect(loadDpiScale()).toBe(100);
  });

  it("keeps the previewed scale when kept before the deadline", () => {
    vi.stubGlobal("innerWidth", 390);
    saveDpiScale(100);
    previewDpiScale(250);
    vi.advanceTimersByTime(3000);
    keepDpiScale();
    expect(isDpiCountdownActive()).toBe(false);
    expect(loadDpiScale()).toBe(250);
    // Keeping cancels the countdown task and resets the store.
    const countdown = useDpiCountdown();
    expect(countdown.active).toBe(false);
    expect(countdown.remaining).toBe(0);
    expect(countdown.scale).toBeNull();
    // Even past the original deadline the kept value stays applied.
    vi.advanceTimersByTime(DPI_REVERT_SECONDS * 1000);
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("2.5");
  });

  it("arms the countdown for any previewed scale, safe or risky", () => {
    // The confirm modal shows a live countdown for EVERY applied scale,
    // and the expiry is the safety net that reverts unanswered applies.
    vi.stubGlobal("innerWidth", 1920);
    previewDpiScale(300);
    expect(isDpiCountdownActive()).toBe(true);
    expect(useDpiCountdown().active).toBe(true);
    expect(getPreviewedDpiScale()).toBe(300);
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("3");
    expect(loadDpiScale()).toBeNull(); // not persisted until kept
    keepDpiScale();
    expect(loadDpiScale()).toBe(300);
    expect(isDpiCountdownActive()).toBe(false);
    expect(useDpiCountdown().active).toBe(false);
  });

  it("replacing a preview restarts the countdown from zero", () => {
    vi.stubGlobal("innerWidth", 390);
    previewDpiScale(250);
    vi.advanceTimersByTime((DPI_REVERT_SECONDS - 5) * 1000);
    previewDpiScale(275); // restarts the task with a full window
    const countdown = useDpiCountdown();
    expect(countdown.active).toBe(true);
    expect(countdown.remaining).toBe(DPI_REVERT_SECONDS);
    expect(countdown.scale).toBe(275);
    vi.advanceTimersByTime(6 * 1000); // the old deadline has passed by now
    expect(isDpiCountdownActive()).toBe(true);
    expect(getPreviewedDpiScale()).toBe(275);
    vi.advanceTimersByTime(5 * 1000); // a full window since the replacement
    expect(isDpiCountdownActive()).toBe(false);
    expect(getPreviewedDpiScale()).toBeNull();
    expect(countdown.active).toBe(false);
  });

  it("revertPreviewDpiScale returns to the persisted value immediately", () => {
    vi.stubGlobal("innerWidth", 390);
    saveDpiScale(125);
    previewDpiScale(250);
    revertPreviewDpiScale();
    expect(isDpiCountdownActive()).toBe(false);
    expect(getPreviewedDpiScale()).toBeNull();
    expect(useDpiCountdown().active).toBe(false);
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.25");
    expect(loadDpiScale()).toBe(125);
  });
});

describe("runtime resize downgrade", () => {
  beforeEach(() => {
    localStorage.clear();
    resetRootScale();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    shutdownDpiPrefs();
  });

  it("downgrades a manual scale that turns risky after a viewport change", () => {
    vi.stubGlobal("innerWidth", 1200);
    saveDpiScale(150);
    initDpiPrefs();
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.5");
    // Shrink the window: 400 / 1.5 < 360px effective — no longer usable.
    vi.stubGlobal("innerWidth", 400);
    window.dispatchEvent(new Event("resize"));
    expect(loadDpiScale()).toBe(150); // debounced — not downgraded yet
    vi.advanceTimersByTime(300);
    expect(loadDpiScale()).toBeNull();
    expect(document.documentElement.dataset.dpiScale).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("");
  });

  it("keeps the manual scale when the resized viewport still fits", () => {
    vi.stubGlobal("innerWidth", 1200);
    saveDpiScale(150);
    initDpiPrefs();
    vi.stubGlobal("innerWidth", 1000);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(300);
    expect(loadDpiScale()).toBe(150);
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.5");
  });

  it("leaves an active preview alone while it counts down", () => {
    vi.stubGlobal("innerWidth", 1200);
    saveDpiScale(150);
    initDpiPrefs();
    vi.stubGlobal("innerWidth", 400);
    previewDpiScale(250); // arms its own revert countdown
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(300);
    // The resize downgrade must not fight the preview's own revert path…
    expect(getPreviewedDpiScale()).toBe(250);
    // …and on expiry the preview falls back to the persisted (safe) value.
    vi.advanceTimersByTime(DPI_REVERT_SECONDS * 1000);
    expect(getPreviewedDpiScale()).toBeNull();
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.5");
  });
});

describe("escape hatches (the guaranteed way back)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetRootScale();
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.useRealTimers();
    shutdownDpiPrefs();
    window.history.replaceState(null, "", "/");
  });

  it("resetDpiScale clears the persisted scale and the applied zoom", () => {
    saveDpiScale(300);
    applyDpiPrefs();
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("3");
    resetDpiScale();
    expect(loadDpiScale()).toBeNull();
    expect(document.documentElement.dataset.dpiScale).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("");
  });

  it("resetDpiScale also cancels a live preview mid-countdown", () => {
    vi.useFakeTimers();
    saveDpiScale(150);
    previewDpiScale(300);
    expect(isDpiCountdownActive()).toBe(true);
    resetDpiScale();
    expect(isDpiCountdownActive()).toBe(false);
    expect(getPreviewedDpiScale()).toBeNull();
    expect(loadDpiScale()).toBeNull();
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("");
  });

  it("initDpiPrefs clears the persisted scale when the URL asks for it", () => {
    saveDpiScale(300);
    window.history.replaceState(null, "", "/?dpi=auto");
    initDpiPrefs();
    expect(loadDpiScale()).toBeNull();
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("");
  });

  it("accepts the reset token through the hash and the value aliases", () => {
    saveDpiScale(300);
    window.history.replaceState(null, "", "/#dpi=reset");
    initDpiPrefs();
    expect(loadDpiScale()).toBeNull();
    shutdownDpiPrefs();

    localStorage.clear();
    saveDpiScale(300);
    window.history.replaceState(null, "", "/?dpi=100");
    initDpiPrefs();
    expect(loadDpiScale()).toBeNull();
  });

  it("keeps the persisted scale when the URL carries no reset token", () => {
    saveDpiScale(150);
    window.history.replaceState(null, "", "/?dpi=200&other=1");
    initDpiPrefs();
    expect(loadDpiScale()).toBe(150);
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.5");
  });

  function press(key: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean }) {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        ctrlKey: mods.ctrl ?? false,
        metaKey: mods.meta ?? false,
        altKey: mods.alt ?? false,
      }),
    );
  }

  it("Ctrl/Cmd+Alt+0 anywhere resets to Auto instantly", () => {
    saveDpiScale(300);
    applyDpiPrefs();
    initDpiPrefs();
    press("0", { ctrl: true, alt: true });
    expect(loadDpiScale()).toBeNull();
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("");
  });

  it("ignores lookalike key combos so typing stays safe", () => {
    saveDpiScale(150);
    applyDpiPrefs();
    initDpiPrefs();
    press("0", { ctrl: true }); // browser-zoom-reset lookalike, no Alt
    press("0", {}); // plain digit
    press("9", { ctrl: true, alt: true }); // wrong digit
    expect(loadDpiScale()).toBe(150);
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.5");
    press("0", { meta: true, alt: true }); // macOS command variant resets
    expect(loadDpiScale()).toBeNull();
  });
});

describe("dpiPrefs — the applied root zoom canvas hosts read", () => {
  let originalObserver: typeof MutationObserver | undefined;

  beforeEach(() => {
    originalObserver = globalThis.MutationObserver;
    // Each guard starts from Auto, whatever the previous one persisted.
    resetDpiScale();
    resetRootScale();
    resetAppliedDpiScaleForTest();
  });

  afterEach(() => {
    if (originalObserver) globalThis.MutationObserver = originalObserver;
    resetRootScale();
    resetAppliedDpiScaleForTest();
  });

  it("reads 1 while DPI is Auto", () => {
    expect(useAppliedDpiScale().value).toBe(1);
  });

  it("reads the notch the preference applies", () => {
    saveDpiScale(175);
    applyDpiPrefs();
    expect(useAppliedDpiScale().value).toBe(1.75);
  });

  it("follows a live preview without a remount", async () => {
    const scale = useAppliedDpiScale();
    expect(scale.value).toBe(1);
    previewDpiScale(250);
    await nextTick();
    expect(scale.value).toBe(2.5);
    revertPreviewDpiScale();
    await nextTick();
    expect(scale.value).toBe(1);
  });

  it("reads an inline zoom that was set without the data notch", () => {
    document.documentElement.style.setProperty("zoom", "1.5");
    resetAppliedDpiScaleForTest();
    expect(useAppliedDpiScale().value).toBe(1.5);
  });

  it("keeps reading the DOM when the observer is unavailable", () => {
    // SSR / old engines: no observer, so the value is the boot-time read.
    (globalThis as { MutationObserver?: unknown }).MutationObserver = undefined;
    resetAppliedDpiScaleForTest();
    saveDpiScale(200);
    applyDpiPrefs();
    expect(useAppliedDpiScale().value).toBe(2);
  });
});
