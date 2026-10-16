/** Analytics gating: nothing loads before the first-run wizard completes,
 *  the Settings → About switch persists and stops a running session, and
 *  turning it back on loads the tag. The module keeps session state, so
 *  every case re-imports a fresh instance (vi.resetModules). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KILL_SWITCH = "ga-disable-G-BGD43VPDEJ";

async function freshModule() {
  vi.resetModules();
  return import("./analytics");
}

/** gtag.js script tags initAnalytics tried to inject. appendChild is
 *  intercepted so the test never fetches the real tag over the network. */
let injected: string[] = [];
let scripts: HTMLScriptElement[] = [];

function commands(): unknown[][] {
  return ((win().dataLayer ?? []) as ArrayLike<unknown>[]).map((entry) => Array.from(entry));
}

function finishLoading() {
  scripts.at(-1)!.dispatchEvent(new Event("load"));
}

function win(): Record<string, unknown> {
  return window as unknown as Record<string, unknown>;
}

beforeEach(() => {
  // happy-dom's Storage proxy does not restore spies on individual methods
  // reliably. A fresh Storage-shaped object keeps failure cases isolated.
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } satisfies Storage);
  injected = [];
  scripts = [];
  window.history.replaceState({}, "", "/");
  document.title = "WoWSP";
  vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
    if (node instanceof HTMLScriptElement) {
      injected.push(node.src);
      scripts.push(node);
    }
    return node;
  });
  delete win().gtag;
  delete win().dataLayer;
  delete win()[KILL_SWITCH];
  win().__TAURI_INTERNALS__ = {};
  vi.stubEnv("DEV", false);
});

afterEach(() => {
  delete win().__TAURI_INTERNALS__;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("initAnalytics", () => {
  it("does nothing before the onboarding wizard completes", async () => {
    const { initAnalytics } = await freshModule();
    initAnalytics();
    expect(injected).toEqual([]);
    expect(win().gtag).toBeUndefined();
  });

  it("loads once the wizard has completed", async () => {
    const { initAnalytics } = await freshModule();
    initAnalytics();
    expect(injected).toEqual([]);
    localStorage.setItem("wowsp-onboarding-completed", "1");
    initAnalytics();
    initAnalytics();
    expect(injected).toEqual(["https://www.googletagmanager.com/gtag/js?id=G-BGD43VPDEJ"]);
  });

  it("stays off when the user opted out", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    localStorage.setItem("wowsp-analytics-disabled", "1");
    const { initAnalytics, isAnalyticsEnabled } = await freshModule();
    expect(isAnalyticsEnabled()).toBe(false);
    initAnalytics();
    expect(injected).toEqual([]);
  });

  it("stays off in dev builds", async () => {
    vi.stubEnv("DEV", true);
    localStorage.setItem("wowsp-onboarding-completed", "1");
    const { initAnalytics } = await freshModule();
    initAnalytics();
    expect(injected).toEqual([]);
  });

  it("stays off outside the Tauri shell", async () => {
    delete win().__TAURI_INTERNALS__;
    localStorage.setItem("wowsp-onboarding-completed", "1");
    const { initAnalytics } = await freshModule();
    initAnalytics();
    expect(injected).toEqual([]);
  });

  it("fails closed when the stored opt-out cannot be read", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    const getItem = localStorage.getItem.bind(localStorage);
    vi.spyOn(localStorage, "getItem").mockImplementation((key) => {
      if (key === "wowsp-analytics-disabled") throw new Error("Storage unavailable");
      return getItem(key);
    });
    const { initAnalytics, isAnalyticsEnabled } = await freshModule();
    initAnalytics();
    expect(isAnalyticsEnabled()).toBe(false);
    expect(injected).toEqual([]);
  });

  it("can retry after the tag fails to load", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    const { initAnalytics } = await freshModule();
    initAnalytics();
    scripts[0].dispatchEvent(new Event("error"));
    initAnalytics();
    expect(scripts).toHaveLength(2);
    finishLoading();
    expect(commands().filter(([kind]) => kind === "config")).toHaveLength(1);
  });

  it("uses the command format accepted by the Google tag", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    const { initAnalytics } = await freshModule();
    initAnalytics();
    finishLoading();
    const queue = win().dataLayer as unknown[];
    expect(queue).not.toHaveLength(0);
    // The real tag ignores plain rest-parameter arrays. Its documented
    // dataLayer protocol consumes the Arguments object from gtag calls.
    expect(queue.every((entry) => Object.prototype.toString.call(entry) === "[object Arguments]")).toBe(true);
  });
});

describe("page-view privacy", () => {
  it("overrides browser URL, document title and referrer with public route metadata", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    window.history.replaceState({}, "", "/lookup?name=Test_Player&realm=asia#private-fragment");
    document.title = "Test_Player's battle";
    vi.spyOn(document, "referrer", "get").mockReturnValue("https://example.org/?name=Test_Player");
    const { initAnalytics } = await freshModule();
    initAnalytics();
    finishLoading();
    expect(scripts[0].referrerPolicy).toBe("no-referrer");

    const safePage = {
      page_title: "lookup",
      page_path: "/lookup",
      page_location: "https://app.wowsp.langyo.xyz/lookup",
      page_referrer: "",
    };
    expect(commands()).toContainEqual(["config", "G-BGD43VPDEJ", expect.objectContaining({
      ...safePage,
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    })]);
    expect(commands()).toContainEqual(["event", "page_view", safePage]);
    expect(JSON.stringify(commands())).not.toMatch(/Test_Player|private-fragment|example\.org/);
  });

  it("strips replay paths in queries and rejects unknown routes", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    const { initAnalytics, trackPageView } = await freshModule();
    initAnalytics();
    finishLoading();
    trackPageView("/replay?open=C%3A%2FUsers%2FTest_Player%2Fbattle.wowsreplay#private");
    expect(commands().at(-1)).toEqual(["event", "page_view", {
      page_title: "replay",
      page_path: "/replay",
      page_location: "https://app.wowsp.langyo.xyz/replay",
      page_referrer: "",
    }]);
    const count = commands().length;
    trackPageView("/players/Test_Player");
    expect(commands()).toHaveLength(count);
    expect(JSON.stringify(commands())).not.toMatch(/Test_Player|wowsreplay|private/);
  });

  it("never uses an unknown initial path as a title or location", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    window.history.replaceState({}, "", "/players/Test_Player");
    const { initAnalytics, trackPageView } = await freshModule();
    initAnalytics();
    finishLoading();
    expect(commands()).toEqual([]);
    trackPageView("/lookup");
    expect(commands().at(-1)).toEqual(["event", "page_view", expect.objectContaining({ page_path: "/lookup" })]);
    expect(JSON.stringify(commands())).not.toContain("Test_Player");
  });

  it("reports a feature once when only its query changes", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    const { initAnalytics, trackPageView } = await freshModule();
    initAnalytics();
    finishLoading();
    trackPageView("/lookup?name=Test_Player");
    const count = commands().length;
    trackPageView("/lookup?name=Another_Player");
    expect(commands()).toHaveLength(count);
  });
});

describe("setAnalyticsEnabled", () => {
  it("cannot bypass onboarding by turning telemetry on", async () => {
    const { setAnalyticsEnabled } = await freshModule();
    setAnalyticsEnabled(true);
    expect(scripts).toEqual([]);
    expect(commands()).toEqual([]);
  });

  it("persists the opt-out and raises the gtag kill switch", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    const { initAnalytics, setAnalyticsEnabled, trackPageView } = await freshModule();
    initAnalytics();
    finishLoading();
    const pushed = (win().dataLayer as unknown[]).length;

    setAnalyticsEnabled(false);
    expect(localStorage.getItem("wowsp-analytics-disabled")).toBe("1");
    expect(win()[KILL_SWITCH]).toBe(true);
    trackPageView("/lookup");
    expect((win().dataLayer as unknown[]).length).toBe(pushed);
  });

  it("re-enabling clears the opt-out and loads the tag", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    localStorage.setItem("wowsp-analytics-disabled", "1");
    const { setAnalyticsEnabled, isAnalyticsEnabled } = await freshModule();

    setAnalyticsEnabled(true);
    expect(isAnalyticsEnabled()).toBe(true);
    expect(localStorage.getItem("wowsp-analytics-disabled")).toBeNull();
    expect(win()[KILL_SWITCH]).toBe(false);
    expect(injected).toEqual(["https://www.googletagmanager.com/gtag/js?id=G-BGD43VPDEJ"]);
  });

  it("keeps two reactive settings consumers in sync", async () => {
    const { isAnalyticsEnabled, setAnalyticsEnabled } = await freshModule();
    const { nextTick, watchEffect } = await import("vue");
    const first: boolean[] = [];
    const second: boolean[] = [];
    const stopFirst = watchEffect(() => { first.push(isAnalyticsEnabled()); });
    const stopSecond = watchEffect(() => { second.push(isAnalyticsEnabled()); });
    try {
      setAnalyticsEnabled(false);
      await nextTick();
      setAnalyticsEnabled(true);
      await nextTick();
      expect(first).toEqual([true, false, true]);
      expect(second).toEqual(first);
    } finally {
      stopFirst();
      stopSecond();
    }
  });

  it("honors a session opt-out even when persistence fails", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    const { initAnalytics, isAnalyticsEnabled, setAnalyticsEnabled, trackPageView } = await freshModule();
    initAnalytics();
    finishLoading();
    const count = commands().length;
    const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    setAnalyticsEnabled(false);
    expect(write).toHaveBeenCalledWith("wowsp-analytics-disabled", "1");
    trackPageView("/lookup");
    expect(isAnalyticsEnabled()).toBe(false);
    expect(win()[KILL_SWITCH]).toBe(true);
    expect(commands()).toHaveLength(count);
  });

  it("honors a session opt-in even when removing the stored opt-out fails", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    localStorage.setItem("wowsp-analytics-disabled", "1");
    const { isAnalyticsEnabled, setAnalyticsEnabled } = await freshModule();
    const remove = vi.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    setAnalyticsEnabled(true);
    expect(remove).toHaveBeenCalledWith("wowsp-analytics-disabled");
    expect(isAnalyticsEnabled()).toBe(true);
    expect(scripts).toHaveLength(1);
  });

  it("does not replay buffered visits when disabled while the tag is loading", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    const { initAnalytics, setAnalyticsEnabled, trackPageView } = await freshModule();
    initAnalytics();
    trackPageView("/lookup");
    setAnalyticsEnabled(false);
    finishLoading();
    expect(commands()).toEqual([]);

    window.history.replaceState({}, "", "/settings?section=about");
    setAnalyticsEnabled(true);
    expect(scripts).toHaveLength(1);
    const events = commands().filter(([kind]) => kind === "event");
    expect(events).toEqual([["event", "page_view", {
      page_title: "settings",
      page_path: "/settings",
      page_location: "https://app.wowsp.langyo.xyz/settings",
      page_referrer: "",
    }]]);
  });

  it("resumes an already loaded tag without injecting it again", async () => {
    localStorage.setItem("wowsp-onboarding-completed", "1");
    const { initAnalytics, setAnalyticsEnabled, trackPageView } = await freshModule();
    initAnalytics();
    finishLoading();
    setAnalyticsEnabled(false);
    trackPageView("/lookup");
    window.history.replaceState({}, "", "/settings");
    setAnalyticsEnabled(true);
    expect(scripts).toHaveLength(1);
    expect(win()[KILL_SWITCH]).toBe(false);
    expect(commands().filter(([kind]) => kind === "js")).toHaveLength(1);
    expect(commands().filter(([kind]) => kind === "config").at(-1)?.[2]).toEqual(expect.objectContaining({ update: true }));
    expect(commands().at(-1)).toEqual(["event", "page_view", expect.objectContaining({ page_path: "/settings" })]);
  });
});
