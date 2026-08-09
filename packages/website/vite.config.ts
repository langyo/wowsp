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
  base: "/",
  server: {
    port: 5174,
  },
  build: {
    outDir: resolve(pkgDir, "../../dist/website"),
    emptyOutDir: false,
    target: "es2020",
  },
});
