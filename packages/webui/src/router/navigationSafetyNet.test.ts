import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sanitizeHistoryUrl } from "@celestia-island/hikari/runtime";

/**
 * Field regression (2026-11-05): a history entry whose persisted router
 * state carried a garbage `current` segment ("undefined/") made every
 * router.push() die in vue-router's HTML5 history — the composed
 * `origin + base + to` URL fails to parse (invalid port), its pushState
 * throws, and the router's catch-branch full-page
 * `location.replace(url)` throws the SyntaxError the user saw toasted:
 * "Failed to execute 'replace' on 'Location':
 * 'http://127.0.0.1:5199undefined/' is not a valid URL". The shell's
 * navigation buttons were dead from then on, and the state rides the
 * history entry, so reloading did not heal it.
 *
 * The router module wires hikari's navigation safety net at module scope
 * (see router/index.ts); these tests pin the two behaviors that close the
 * crash class: the History-prototype fold below the router, and the
 * self-heal once a navigation succeeds.
 */

/** The exact state shape a poisoned producer leaves on the entry. */
function poisonedRouterState(current: string) {
  return {
    back: null,
    current,
    forward: null,
    position: 1,
    replaced: true,
    scroll: null,
  };
}

describe("router navigation safety net", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("a push over a poisoned history entry folds, navigates, and heals the state", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { router } = await import("./index");

    // First navigation after boot (the router's isReady() navigation) —
    // lands clean; this is what a healthy session looks like.
    await router.push("/live");
    expect(router.currentRoute.value.path).toBe("/live");

    // The poison arrives afterwards (a producer pushing a garbage target
    // whose stringified form lacks a leading "/"), exactly as observed in
    // the field report.
    window.history.replaceState(poisonedRouterState("undefined/"), "", "/live");
    expect(window.history.state?.current).toBe("undefined/");

    // WITHOUT the net this push rejects with "Failed to execute 'replace'
    // on 'Location': '…undefined/' is not a valid URL" (vue-router's
    // catch-branch fallback); WITH the net it must fold the off-origin
    // target onto the app landing, complete the navigation, and rewrite
    // the entry state clean in the same move.
    await router.push("/ships");

    expect(router.currentRoute.value.path).toBe("/ships");
    expect(window.history.state?.current).toBe("/ships");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[HistoryNet] Blocked off-origin history replaceState"),
      expect.anything(),
    );
  });

  it("a direct off-origin pushState producer is folded below the History API", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await import("./index");

    window.history.pushState({}, "", "https://evil.example/poison");

    expect(window.location.pathname).toBe("/");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[HistoryNet] Blocked off-origin history pushState"),
      expect.anything(),
    );
  });

  it("sanitizeHistoryUrl folds the field's poisoned targets and passes clean ones", async () => {
    // The literal field artifact: origin glued to "undefined" — an invalid
    // URL (unparseable port), which is what made location.replace throw.
    expect(sanitizeHistoryUrl("http://127.0.0.1:5199undefined/")).toBe("/");
    // Bare poisoned literals are always producer bugs.
    expect(sanitizeHistoryUrl("undefined")).toBe("/");
    expect(sanitizeHistoryUrl("null")).toBe("/");
    // Same-origin targets pass through untouched.
    const sameOrigin = window.location.origin + "/live";
    expect(sanitizeHistoryUrl(sameOrigin)).toBe(sameOrigin);
    expect(sanitizeHistoryUrl("/ships")).toBe("/ships");
  });
});
