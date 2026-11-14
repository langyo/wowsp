import { resolve } from "path";
import { defineConfig } from "vite";
import vueSfc from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";

const pkgDir = resolve(__dirname);

// hikari ships uncompiled Vue JSX source; Vite 8's Rolldown dep optimizer
// strips types but leaves JSX raw, so it must be excluded and served
// through the plugin pipeline where vue-jsx transforms it (same rule as
// @wowsp/website).
export default defineConfig({
  plugins: [vueSfc(), vueJsx()],
  optimizeDeps: {
    exclude: ["@celestia-island/hikari"],
  },
  resolve: {
    alias: {
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
