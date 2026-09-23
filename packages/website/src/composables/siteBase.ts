// The same site build serves at TWO origins: GitHub Pages under
// /wowsp/ (the fast, first resource candidate) and the pairing worker
// at the root (the fallback). Every runtime reference to bundled files
// must use THIS base: it resolves to the build base on Pages and to
// "/" when the page landed on the worker (landing path without the
// /wowsp/ prefix). Must stay in sync with router/index.ts.
let base = import.meta.env.BASE_URL || "/";
if (base !== "/" && !window.location.pathname.startsWith(base)) {
  base = "/";
}

export const siteBase = base;
