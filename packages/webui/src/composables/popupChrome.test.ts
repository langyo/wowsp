/** Contract tests for the popup-chrome wiring: the title bar's real box
 *  becomes hikari's popup-bounds band, a boxless/hidden bar clears it,
 *  and teardown restores the no-band state. Geometry itself lives
 *  upstream (tested in @celestia-island/hikari); these pin the glue. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { popupInsets } from "@celestia-island/hikari/runtime";

import { syncChromeInsets, watchChromeInsets } from "./popupChrome";

const stops: Array<() => void> = [];

afterEach(() => {
  while (stops.length) stops.pop()?.();
  configureNull();
  vi.restoreAllMocks();
  document
    .querySelectorAll("[data-popup-chrome-probe]")
    .forEach((el) => el.remove());
});

function configureNull(): void {
  // Direct reset through the same upstream API the glue uses.
  syncChromeInsets(null);
}

function bar(bottom: number): HTMLElement {
  const el = document.createElement("div");
  el.dataset.popupChromeProbe = "true";
  document.body.appendChild(el);
  el.getBoundingClientRect = () =>
    ({
      left: 0, top: 0, right: 1280, bottom, width: 1280,
      height: bottom, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

describe("syncChromeInsets", () => {
  it("declares the bar's bottom edge as the band", () => {
    syncChromeInsets(bar(32));
    expect(popupInsets()).toEqual({ top: 32, right: 0, bottom: 0, left: 0 });
  });

  it("replaces the band when the bar re-measures taller (phone layout)", () => {
    syncChromeInsets(bar(32));
    syncChromeInsets(bar(48));
    expect(popupInsets().top).toBe(48);
  });

  it("clears the band for a boxless bar (hidden or absent)", () => {
    syncChromeInsets(bar(32));
    const detached = document.createElement("div");
    syncChromeInsets(detached); // zero rect
    expect(popupInsets().top).toBe(0);
    syncChromeInsets(null);
    expect(popupInsets().top).toBe(0);
  });
});

describe("watchChromeInsets", () => {
  it("declares on wire and clears on teardown", () => {
    stops.push(watchChromeInsets(bar(32)));
    expect(popupInsets().top).toBe(32);
    stops.pop()!();
    expect(popupInsets().top).toBe(0);
  });

  it("re-declares when the window resizes", () => {
    const probe = bar(32);
    stops.push(watchChromeInsets(probe));
    probe.getBoundingClientRect = () =>
      ({
        left: 0, top: 0, right: 1280, bottom: 48, width: 1280,
        height: 48, x: 0, y: 0, toJSON: () => ({}),
      }) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    expect(popupInsets().top).toBe(48);
  });

  it("re-syncs on the deferred frames when styles land late (dev)", () => {
    // Dev injects CSS after mount, so the wiring-time measure can be a
    // pre-stylesheet transient (observed live: 48px unstyled → 32px
    // styled). The deferred frames must re-declare the settled box.
    vi.useFakeTimers();
    try {
      const probe = bar(48);
      stops.push(watchChromeInsets(probe));
      expect(popupInsets().top).toBe(48); // the transient
      probe.getBoundingClientRect = () =>
        ({
          left: 0, top: 0, right: 1280, bottom: 32, width: 1280,
          height: 32, x: 0, y: 0, toJSON: () => ({}),
        }) as DOMRect;
      vi.advanceTimersByTime(50); // happy-dom rAF is timer-based
      expect(popupInsets().top).toBe(32);
    } finally {
      vi.useRealTimers();
    }
  });

  it("teardown during the deferred window cannot resurrect the band", () => {
    // Regression pin for teardown hermeticity: stop() after the first
    // deferred frame fired but before the second — the second frame must
    // NOT re-declare the bar over the cleared band (a pre-fix
    // implementation flipped the band back to 32 here).
    vi.useFakeTimers();
    try {
      const probe = bar(32);
      const stop = watchChromeInsets(probe);
      vi.advanceTimersByTime(20); // one frame in, inner frame pending
      probe.getBoundingClientRect = () =>
        ({
          left: 0, top: 0, right: 1280, bottom: 48, width: 1280,
          height: 48, x: 0, y: 0, toJSON: () => ({}),
        }) as DOMRect;
      stop();
      expect(popupInsets().top).toBe(0);
      vi.advanceTimersByTime(50);
      expect(popupInsets().top).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
