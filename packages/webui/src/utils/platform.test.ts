/** Platform classification gates: the phone-app build flag must require the
 *  Tauri shell (a phone UA in a plain browser is still a browser), the
 *  ?mobileApp=1 dev override must force the gates WITHOUT faking the shell
 *  (it must never leak into isTauri/mock-mode detection), and the phone
 *  LAYOUT check keys off the viewport media query, not the UA. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Internals = Record<string, unknown> | undefined;
const w = () => window as unknown as {
  __TAURI_INTERNALS__?: Internals;
  history: { pushState: (s: unknown, t: string, u: string) => void };
};

let savedInternals: Internals;
let savedUa: string;

beforeEach(() => {
  savedInternals = w().__TAURI_INTERNALS__;
  savedUa = navigator.userAgent;
});

afterEach(() => {
  w().__TAURI_INTERNALS__ = savedInternals;
  Object.defineProperty(navigator, "userAgent", {
    value: savedUa,
    configurable: true,
  });
  w().history.pushState({}, "", "/");
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function importPlatform() {
  return import("./platform");
}

function setUa(ua: string) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
}

describe("isTauri", () => {
  it("is false in a plain browser and true once the shell injects internals", async () => {
    delete w().__TAURI_INTERNALS__;
    const p = await importPlatform();
    expect(p.isTauri()).toBe(false);
  });

  it("flips on with __TAURI_INTERNALS__", async () => {
    w().__TAURI_INTERNALS__ = { invoke: () => {} };
    const p = await importPlatform();
    expect(p.isTauri()).toBe(true);
  });
});

describe("isMobileApp", () => {
  it("stays false in a plain browser even with a phone UA (shell required)", async () => {
    delete w().__TAURI_INTERNALS__;
    setUa(
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36",
    );
    const p = await importPlatform();
    expect(p.isTauri()).toBe(false);
    expect(p.isMobileApp()).toBe(false);
  });

  it("is true for the Tauri shell on Android / iPhone / iPad UAs", async () => {
    w().__TAURI_INTERNALS__ = { invoke: () => {} };
    setUa(
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36",
    );
    const p = await importPlatform();
    expect(p.isMobileApp()).toBe(true);
  });

  it("covers the iPadOS desktop-masquerade UA (Macintosh + iPad token)", async () => {
    w().__TAURI_INTERNALS__ = { invoke: () => {} };
    // iPadOS 13+ Safari identifier — the one phone UA without "Mobile".
    setUa(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 iPad",
    );
    const p = await importPlatform();
    expect(p.isMobileApp()).toBe(true);
  });

  it("is false for the desktop WebView (Windows UA in the shell)", async () => {
    w().__TAURI_INTERNALS__ = { invoke: () => {} };
    setUa(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 Edg/130.0",
    );
    const p = await importPlatform();
    expect(p.isTauri()).toBe(true);
    expect(p.isMobileApp()).toBe(false);
  });
});

describe("?mobileApp=1 dev override", () => {
  it("forces the phone-app gates in a desktop browser without faking the shell", async () => {
    delete w().__TAURI_INTERNALS__;
    w().history.pushState({}, "", "/?mobileApp=1");
    const p = await importPlatform();
    expect(p.isMobileApp()).toBe(true);
    // The override is a FEATURE gate, not a shell fake — transport selection
    // (mock vs tauri) must keep seeing a plain browser.
    expect(p.isTauri()).toBe(false);
  });

  it("does not trip on unrelated or absent values", async () => {
    delete w().__TAURI_INTERNALS__;
    w().history.pushState({}, "", "/replay?mobileApp=0");
    const p0 = await importPlatform();
    expect(p0.isMobileApp()).toBe(false);
    vi.resetModules();
    w().history.pushState({}, "", "/?mobileapp=1");
    const pCase = await importPlatform();
    expect(pCase.isMobileApp()).toBe(false);
  });
});

describe("isPhoneLayout", () => {
  it("keys off the viewport media query, not the UA", async () => {
    delete w().__TAURI_INTERNALS__;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({
        matches: q !== "(min-width: 768px)",
        media: q,
      })),
    );
    const p = await importPlatform();
    expect(p.isPhoneLayout()).toBe(true);
    vi.resetModules();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({
        matches: q === "(min-width: 768px)",
        media: q,
      })),
    );
    const wide = await importPlatform();
    expect(wide.isPhoneLayout()).toBe(false);
  });
});
