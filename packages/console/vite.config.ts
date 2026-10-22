import { dirname, resolve } from "path";
import { defineConfig } from "vite";
import vueSfc from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";

const pkgDir = resolve(__dirname);

// hikari ships uncompiled Vue JSX source; Vite 8's Rolldown dep optimizer
// strips types but leaves JSX raw, so it must be excluded and served
// through the plugin pipeline where vue-jsx transforms it (same rule as
// @wowsp/website). hikari imports highlight.js through CJS `lib/` deep
// paths — alias them onto the identical ESM build, resolved through
// hikari's own dependency set (same rule as the website).
const hikariDir = dirname(
  dirname(require.resolve("@celestia-island/hikari/components/HkButton.tsx")),
);
const hljsEsDir = resolve(
  dirname(require.resolve("highlight.js/package.json", { paths: [hikariDir] })),
  "es",
);

export default defineConfig({
  plugins: [vueSfc(), vueJsx()],
  optimizeDeps: {
    exclude: ["@celestia-island/hikari"],
  },
  resolve: {
    alias: {
      "highlight.js/lib": hljsEsDir,
      "@": resolve(pkgDir, "src"),
      "@res": resolve(pkgDir, "../../res"),
    },
  },
  // The console serves SAME-ORIGIN from the worker's [assets] layer at
  // /erp and /feedback — every API call is relative, so no base prefix
  // and no cross-origin deployment of these entries is supported.
  base: "/",
  server: {
    port: 5175,
    // Dev against the local wrangler dev worker (or the live gateway):
    // same-origin APIs without CORS setup.
    proxy: {
      "/api": {
        target: process.env.WOWSP_CONSOLE_API || "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: resolve(pkgDir, "../../dist/console"),
    target: "es2020",
    rollupOptions: {
      input: {
        erp: resolve(pkgDir, "erp.html"),
        feedback: resolve(pkgDir, "feedback.html"),
      },
    },
  },
});
