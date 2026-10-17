// Prerender stub for @xterm/xterm (see scripts/prerender.mjs): hikari's
// barrel re-exports the terminal component, so importing any hikari
// component evaluates the real CJS package — which cannot be
// named-imported under the SSR runner's raw-Node interop. No terminal
// is ever rendered during prerendering; the shapes below only need to
// import cleanly.
export class Terminal {
  constructor() {}
  load() {}
  open() {}
  dispose() {}
}

export default { Terminal };
