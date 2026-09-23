import { dirname, resolve } from "path";
import { defineConfig, type Plugin } from "vite";
import { copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";

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
    // LAST: runs after the 404 mirror so both files get the rewritten URLs.
    htmlAssetBase(),
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

// WOWSP_SITE_ASSET_BASE (absolute URL, e.g. the GitHub Pages mirror
// langyo.github.io/wowsp) rewrites every STATIC FILE reference in the
// built HTML (entry JS/CSS, favicon, manifest, …) to that origin: the
// worker at wowsp.langyo.xyz then serves only the HTML shell + /api
// while the heavy downloads come from GitHub. Chunk-to-chunk imports are
// relative to the entry URL and follow automatically; navigation links
// (no file extension) stay on the worker so routing keeps working.
// Runs in closeBundle so it sees the FINAL html — after Vite injects the
// entry tags. (Vite 8/rolldown ignores experimental.renderBuiltUrl,
// hence the manual rewrite.)
function htmlAssetBase(): Plugin {
  const origin = process.env.WOWSP_SITE_ASSET_BASE;
  return {
    name: "site-html-asset-base",
    apply: "build",
    closeBundle() {
      if (!origin) return;
      const outDir = resolve(pkgDir, "../../dist/website");
      for (const file of ["index.html", "404.html"]) {
        try {
          const p = resolve(outDir, file);
          const html = readFileSync(p, "utf-8");
          const rewritten = html.replace(
            /((?:src|href)=")\/([^"#?]+\.[a-zA-Z0-9]+)([#?][^"]*)?"/g,
            `$1${origin}/$2$3"`,
          );
          if (rewritten !== html) writeFileSync(p, rewritten);
        } catch { /* file missing — nothing to rewrite */ }
      }
    },
  };
}
