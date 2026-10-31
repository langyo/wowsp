import { afterEach, describe, expect, it, vi } from "vitest";

import { readStageThemeMode, watchStageThemeMode } from "@wowsp/holo";

import { fakeAs } from "@/test-utils/fakes";

/**
 * Contract tests for the shared 3D stage theme source (@wowsp/holo
 * stageTheme) — the ONE data source + refresh logic every 3D renderer
 * (ship viewer, replay map, mod-hub stage, site replay stage, shared
 * homepage turntable) reads and subscribes to, so a mid-session theme
 * flip reaches every canvas at once instead of waiting for the next
 * model load. Run under happy-dom: the module observes the live document.
 */

/** Drive the root attribute hikari writes (the module's data source). */
function setMode(mode: "dark" | "light" | null): void {
  if (mode == null) document.documentElement.removeAttribute("data-mode");
  else document.documentElement.setAttribute("data-mode", mode);
}

/** MutationObserver deliveries land on a task past the microtask queue —
 *  yield a macrotask so an observer armed in the same tick has run. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  setMode(null);
});

describe("readStageThemeMode", () => {
  it("reads the resolved data-mode attribute both ways", () => {
    setMode("dark");
    expect(readStageThemeMode()).toBe("dark");
    setMode("light");
    expect(readStageThemeMode()).toBe("light");
  });

  it("falls back to the OS color scheme when no attribute is set", () => {
    setMode(null);
    // The OS preference is a GETTER in the double (MediaQueryList.matches is
    // read-only); flipping the backing flag is how a real media query changes.
    let prefersDark = true;
    const mq = fakeAs<MediaQueryList>({
      get matches() {
        return prefersDark;
      },
    });
    const spy = vi.spyOn(window, "matchMedia").mockReturnValue(mq);
    try {
      expect(readStageThemeMode()).toBe("dark");
      prefersDark = false;
      expect(readStageThemeMode()).toBe("light");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("watchStageThemeMode", () => {
  it("fires on a live flip, dedupes same-mode writes, and stops on unsubscribe", async () => {
    setMode("dark");
    const seen: string[] = [];
    const stop = watchStageThemeMode((m) => seen.push(m), { immediate: false });
    setMode("light");
    await settle();
    expect(seen).toEqual(["light"]);
    // Rewriting the SAME mode must not re-fire (hikari re-applies its
    // preference on unrelated settings saves).
    setMode("light");
    await settle();
    expect(seen).toEqual(["light"]);
    setMode("dark");
    await settle();
    expect(seen).toEqual(["light", "dark"]);
    stop();
    setMode("light");
    await settle();
    expect(seen).toEqual(["light", "dark"]);
  });

  it("fires immediately with the current mode by default", () => {
    setMode("light");
    const seen: string[] = [];
    const stop = watchStageThemeMode((m) => seen.push(m));
    expect(seen).toEqual(["light"]);
    stop();
  });

  it("fans one source out to many watchers; mid-fanout unsubscribe is safe", async () => {
    setMode("dark");
    const a: string[] = [];
    const b: string[] = [];
    let stopA: (() => void) | null = null;
    const stopB = watchStageThemeMode(
      (m) => { b.push(m); if (stopA) stopA(); },
      { immediate: false },
    );
    stopA = watchStageThemeMode((m) => a.push(m), { immediate: false });
    setMode("light");
    await settle();
    // B's callback ran after A's and unsubscribed it — both saw the flip.
    expect(a).toEqual(["light"]);
    expect(b).toEqual(["light"]);
    setMode("dark");
    await settle();
    expect(b).toEqual(["light", "dark"]);
    expect(a).toEqual(["light"]); // stayed silent after unsubscribing
    stopB();
  });

  it("a late joiner sees the current mode without re-firing earlier peers", async () => {
    setMode("dark");
    const first: string[] = [];
    const second: string[] = [];
    const stop1 = watchStageThemeMode((m) => first.push(m), { immediate: true });
    const stop2 = watchStageThemeMode((m) => second.push(m), { immediate: true });
    expect(first).toEqual(["dark"]);
    expect(second).toEqual(["dark"]);
    setMode("light");
    await settle();
    expect(first).toEqual(["dark", "light"]);
    expect(second).toEqual(["dark", "light"]);
    stop1();
    stop2();
  });

  it("the same function reference may subscribe twice with independent handles", async () => {
    setMode("dark");
    const calls: string[] = [];
    const fn = (m: string) => calls.push(m);
    const stop1 = watchStageThemeMode(fn, { immediate: false });
    const stop2 = watchStageThemeMode(fn, { immediate: false });
    setMode("light");
    await settle();
    expect(calls).toEqual(["light", "light"]);
    stop1(); // one handle out — the OTHER subscription must survive
    setMode("dark");
    await settle();
    expect(calls).toEqual(["light", "light", "dark"]);
    stop2();
    setMode("light");
    await settle();
    expect(calls).toEqual(["light", "light", "dark"]);
  });

  it("a throwing watcher does not starve its peers of the flip", async () => {
    setMode("dark");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy: string[] = [];
    const stopBad = watchStageThemeMode(
      () => { throw new Error("boom"); },
      { immediate: false },
    );
    const stopGood = watchStageThemeMode((m) => healthy.push(m), { immediate: false });
    setMode("light");
    await settle();
    expect(healthy).toEqual(["light"]); // got the flip despite the thrower
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    stopBad();
    stopGood();
  });
});
