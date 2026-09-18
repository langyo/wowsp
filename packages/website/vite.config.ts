import { dirname, resolve } from "path";
import { defineConfig, type Plugin } from "vite";
import { copyFileSync, readdirSync, rmSync } from "fs";

import vueSfc from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";

const pkgDir = resolve(__dirname);

// hikari imports highlight.js through its CJS `lib/` deep paths. With hikari
// excluded from optimizeDeps those files are served raw in dev, and a raw CJS
// module has no default export. Alias the whole `lib/` tree onto the package's
// identical ESM build under `es/` — resolved through hikari's own dependency
// set, since highlight.js is not a direct dependency here. hikari's bare "."
// export is import-condition-only, so locate the package through its
// condition-free `./components/*` export instead.
const hikariDir = dirname(
  dirname(require.resolve("@celestia-island/hikari/components/HkButton.tsx")),
);
const hljsEsDir = resolve(
  dirname(require.resolve("highlight.js/package.json", { paths: [hikariDir] })),
  "es",
);

// The website builds into the shared dist/ tree (mirroring @wowsp/webui's
// layout) so a single deploy workflow can merge docs + website + landing.
function cleanOutDirContents(outDir: string): Plugin {
  return {
    name: "clean-outdir-contents",
    apply: "build",
    buildStart() {
      let entries: string[];
      try {
        entries = readdirSync(outDir);
      } catch {
        return;
      }
      for (const entry of entries) {
        rmSync(resolve(outDir, entry), { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [
    cleanOutDirContents(resolve(pkgDir, "../../dist/website")),
    // SPA on static hosting (GitHub Pages / nginx): direct hits on /lookup
    // etc. must fall back to the app shell instead of a hard 404.
    {
      name: "spa-404-fallback",
      apply: "build",
      closeBundle() {
        const outDir = resolve(pkgDir, "../../dist/website");
        try {
          copyFileSync(resolve(outDir, "index.html"), resolve(outDir, "404.html"));
        } catch { /* index.html missing — nothing to mirror */ }
      },
    },
    vueSfc(),
    vueJsx(),
  ],
  // hikari ships uncompiled Vue JSX source; Vite 8's Rolldown dep optimizer
  // strips types but leaves JSX raw, so it must be excluded and served
  // through the plugin pipeline where vue-jsx transforms it.
  optimizeDeps: {
    exclude: ["@celestia-island/hikari"],
  },
  resolve: {
    alias: {
      "highlight.js/lib": hljsEsDir,
      "@": resolve(pkgDir, "src"),
    },
  },
  publicDir: resolve(pkgDir, "src/res"),
  // The deploy workflow sets WOWSP_SITE_BASE for GitHub Pages project-site
  // serving (`/wowsp/`); the custom domain wowsp.langyo.xyz serves from the
  // root and should use `/` (the default). vue-router reads the same base
  // via import.meta.env.BASE_URL.
  base: process.env.WOWSP_SITE_BASE || "/",
  server: {
    port: 5174,
  },
  build: {
    outDir: resolve(pkgDir, "../../dist/website"),
    emptyOutDir: false,
    target: "es2020",
  },
});
