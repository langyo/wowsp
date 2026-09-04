import vueSfc from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import { resolve } from "path";
import { defineConfig } from "vite";

// outDir lives inside the package and is consumed by the installer shell's
// tauri.conf.json (frontendDist). plain `cargo build` embeds it at compile
// time via generate_context!, so run `pnpm build` before `cargo build`.
export default defineConfig({
  plugins: [vueSfc(), vueJsx()],
  publicDir: resolve(__dirname, "public"),
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "es2020",
  },
});
