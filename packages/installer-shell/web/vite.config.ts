import vueSfc from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import { dirname, resolve } from "path";
import { defineConfig } from "vite";

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

// outDir lives inside the package and is consumed by the installer shell's
// tauri.conf.json (frontendDist). plain `cargo build` embeds it at compile
// time via generate_context!, so run `pnpm build` before `cargo build`.
export default defineConfig({
  plugins: [vueSfc(), vueJsx()],
  // hikari ships uncompiled Vue JSX source; Vite 8's Rolldown dep optimizer
  // strips types but leaves JSX raw, so it must be excluded and served
  // through the plugin pipeline where vue-jsx transforms it.
  optimizeDeps: {
    exclude: ["@celestia-island/hikari"],
  },
  resolve: {
    alias: {
      "highlight.js/lib": hljsEsDir,
    },
  },
  publicDir: resolve(__dirname, "public"),
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "es2020",
  },
});
