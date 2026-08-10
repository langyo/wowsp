import { resolve } from "path";
import { defineConfig, type Plugin } from "vite";
import { copyFileSync, readdirSync, rmSync } from "fs";

import vueSfc from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";

const pkgDir = resolve(__dirname);

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
  resolve: {
    alias: {
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
