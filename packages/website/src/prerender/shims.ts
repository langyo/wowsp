// Prerender shims: just enough of the browser world for the app's
// modules to IMPORT cleanly under Node. Anything a component only
// touches inside onMounted/lifecycle hooks never runs while
// prerendering — the imports that DO reach for globals at module scope
// are siteBase (window.location) and hikari's theme module
// (window.__celestia*, declared pre-module by index.html in the
// browser). This module must stay the FIRST import of entry.ts: ESM
// executes imports in order.

/** The five globals this module installs are deliberate PARTIAL stand-ins (a
 *  `window` with a location and a few sizes, a `document` with two methods) —
 *  the real DOM types cannot describe them, and they must overwrite the Node
 *  globals. Type exactly those five away for this module: they are written and
 *  boolean-tested here, never read through this view (the module-scope reads
 *  downstream go through the real globals once the shim has run). Every other
 *  global keeps its real type, so a typo in an unrelated name still fails. */
type PrerenderGlobals = Omit<
  typeof globalThis,
  "window" | "document" | "navigator" | "matchMedia" | "history"
> & {
  window?: unknown;
  document?: unknown;
  navigator?: unknown;
  matchMedia?: unknown;
  history?: unknown;
};
const g: PrerenderGlobals = globalThis;
const base = import.meta.env.BASE_URL || "/";

if (!g.window) {
  g.window = {
    // siteBase.ts falls back to "/" when the path lacks the build base;
    // pointing the shim at the build base keeps prerendered asset/route
    // links on the bundled paths (mirrors what the Pages host serves).
    location: {
      pathname: base,
      href: `https://wowsp.langyo.xyz${base}`,
      origin: "https://wowsp.langyo.xyz",
      search: "",
      hash: "",
    },
    __celestiaThemes: { ocean: true },
    __celestiaDefaultTheme: "ocean",
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    setTimeout,
    clearTimeout,
  };
}

if (!g.document) {
  g.document = {
    documentElement: {
      lang: "en",
      clientHeight: 900,
      style: { setProperty() {} },
    },
    body: {
      // hikari's overlayRoot module appends its overlay container to
      // document.body at import time (module side effect, 0.55.19x) —
      // no-op it here; the real root only needs to exist in the browser.
      appendChild() {},
      removeChild() {},
    },
    createElement: () => ({
      style: {},
      setAttribute() {},
      appendChild() {},
      remove() {},
    }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
}

// Node ≥21 ships its own read-only `navigator` (userAgent, no language
// on some versions): replace it when possible so detectLocale-style
// reads see a language, and let a locked global pass through — prerender
// passes locales explicitly and never calls detectLocale itself.
try {
  const existing = g.navigator as Record<string, unknown> | undefined;
  g.navigator = { language: existing?.language ?? "en", ...(existing ?? {}) };
} catch {
  /* read-only global — nothing at import time reads it */
}

if (!g.matchMedia) {
  g.matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
}

// The window shim makes libs' `isBrowser` checks true, so vue-router
// also reaches for the History API a memory router never really uses.
if (!g.history) {
  g.history = {
    state: null,
    length: 1,
    scrollRestoration: "auto",
    pushState() {},
    replaceState() {},
    go() {},
    back() {},
    forward() {},
  };
}
