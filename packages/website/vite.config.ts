import { resolve } from "path";
import { defineConfig, type Plugin } from "vite";
import { readdirSync, rmSync } from "fs";

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
