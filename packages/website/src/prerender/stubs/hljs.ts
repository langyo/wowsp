// Prerender stub for highlight.js's CJS core (see
// scripts/prerender.ts): hikari's useHighlight imports
// lib/core through the es/core.js shim, and the SSR module runner
// evaluates the CJS file as ESM (bare `module.exports` blows up) where
// dev/build wrap it. Nothing on the marketing site highlights code
// while prerendering — the default export below only needs to import
// cleanly.
const hljs = {
  registerLanguage(): void {},
  configure(): void {},
  getLanguage(): null {
    return null;
  },
  highlight(code: string, { language }: { language?: string } = {}) {
    return { value: code ?? "", language: language ?? "" };
  },
};

export default hljs;
