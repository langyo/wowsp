import vueSfc from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import { readdirSync, rmSync, rmdirSync, readFileSync, statSync } from "fs";
import { dirname, resolve } from "path";
import { defineConfig, type Plugin } from "vite";

import UnoCSS from "unocss/vite";

// NO file extension on purpose: `vite.config.ts` belongs to the composite
// `tsconfig.node.json` projection, where a `.ts`-suffixed import needs
// `allowImportingTsExtensions` (impossible next to `composite`'s emit
// requirements) and trips TS5097/TS6307. The trade-off is Vite's forward-compat
// notice about extensionless local imports (its future `configLoader: 'native'`
// route cannot resolve them) — accepted and recorded in the PR.
import { bootChromePluginsFor, WEBUI_PAGES } from "./src/bootChrome";

function readPkgVersion(pkgDir: string): string {
  try {
    const raw = readFileSync(resolve(pkgDir, 'package.json'), 'utf-8');
    return JSON.parse(raw).version || 'dev';
  } catch {
    return 'dev';
  }
}

// `import.meta.dirname` resolves to THIS file's directory in every loader Vite
// supports (the ESM config bundle rewrites it to the original config path, and
// the native loader has it natively); `__dirname` does not survive the native
// route Vite is moving to, and warns on every config load today.
const pkgDir = import.meta.dirname;

const mockTarget = process.env.WOWSP_MOCK_URL || 'http://localhost:8787';

// Mobile-bundle builds (justfile android recipes) keep the baked GLBs and
// the offline gameparams pack in dist so they embed into the APK's assets;
// every other build prunes both (see pruneBakedGlb / pruneGameparams).
const mobileBundle = process.env.WOWSP_MOBILE_BUNDLE === '1';

// Two build routes produce an Android bundle: the justfile recipes above
// (WOWSP_MOBILE_BUNDLE=1) and Tauri's own `tauri android` pipeline, which
// exports TAURI_ENV_PLATFORM=android to the frontend build.
const androidBundle = mobileBundle || process.env.TAURI_ENV_PLATFORM === 'android';

// hikari imports highlight.js through its CJS `lib/` deep paths. With hikari
// excluded from optimizeDeps those files are served raw in dev, and a raw CJS
// module has no default export. Alias the whole `lib/` tree onto the package's
// identical ESM build under `es/` — resolved through hikari's own dependency
// set, since highlight.js is not a direct dependency here. hikari's bare "."
// export is import-condition-only, so locate the package through its
// condition-free `./components/*` export instead.
const hikariDir = dirname(
  dirname(require.resolve('@celestia-island/hikari/components/HkButton.tsx')),
);
const hljsEsDir = resolve(
  dirname(require.resolve('highlight.js/package.json', { paths: [hikariDir] })),
  'es',
);

// outDir lives outside the package (../../dist/webui) and is consumed by the
// Tauri shell (frontendDist). Because it can be Docker bind-mounted we wipe
// the CONTENTS rather than deleting the directory inode, matching shittim's
// cleanOutDirContents plugin.
function cleanOutDirContents(outDir: string): Plugin {
  return {
    name: 'clean-outdir-contents',
    apply: 'build',
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

// Split heavy, stable vendor libraries into cacheable chunks. `three` is by far
// the biggest win (≈600KB, holographic-map-only). Pattern lifted from
// shittim-chest; regexes use [\\/] to match both POSIX and Windows separators.
function vendorChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return;
  // The meshopt decoder must stay OUT of the 'three' chunk: modelLoader
  // imports it DYNAMICALLY (inside getLoader) so pages that never parse a
  // GLB don't evaluate its import-time WebAssembly.instantiate — but
  // manualChunks ignores import dynamism, and folding it into the
  // eagerly-imported 'three' chunk would undo that and re-expose every
  // three-importing page (the tech tree included) to a blocked-WASM
  // rejection under a CSP without 'wasm-unsafe-eval'. Returning undefined
  // leaves it to Rollup's default: a dedicated lazy chunk.
  if (/[\\/]node_modules[\\/]three[\\/]examples[\\/]jsm[\\/]libs[\\/]meshopt_decoder/.test(id)) {
    return;
  }
  if (/[\\/]node_modules[\\/](three|@types[\\/]three)[\\/]/.test(id)) return 'three';
  if (/[\\/]node_modules[\\/](lucide-vue-next)[\\/]/.test(id)) return 'icons';
  return;
}

// The baked GLB pack (src/res/models/**/*.glb — untracked bake output, ~1.1 GB
// on a machine holding a full bake) rides publicDir into outDir, and the Tauri
// shell then embeds the whole dist into wowsp.exe: a second, dead copy of the
// model pack that the installer already ships as its stage/models payload
// (scripts/build_installers.py). Production serves models from the relocated
// model-pack cache; publicDir paths are only the DEV fallback, where Vite
// serves src/res directly and this plugin never runs. So the build prunes
// every .glb from outDir and keeps the git-tracked 2D subset (~10 MB of
// WebP silhouettes/minimaps — the exact set a fresh CI checkout carries),
// making local builds byte-equivalent to release CI's dist. The ship
// preview portraits (images/ships/[0-9]*.webp — .png on trees the
// archive/channel has not republished yet) are ALSO gitignored derived
// files, but unlike the GLBs they are wanted in the shipped binary:
// release CI fetches them from the res-latest wowsp-images archive before
// the webui build (scripts/build_installers.py --images), so they embed on
// every side. The GLB pruning itself matches only the .glb extension — it
// never filters by image format.
//
// MOBILE BUNDLE exception (WOWSP_MOBILE_BUNDLE=1): the Android build embeds
// dist into the APK's read-only assets and the app loads GLBs SAME-ORIGIN
// from there (see modelLoader.ts / commands/model_pack.rs mobile paths), so
// the GLBs must survive the build. The env flag is exported by the justfile
// android recipes only — desktop builds keep pruning.
function pruneBakedGlb(outDir: string): Plugin {
  return {
    name: 'prune-baked-glb',
    apply: 'build',
    // closeBundle: vite lays publicDir down early in the build (vite 8 does
    // it in vite:prepare-out-dir's renderStart), so the copied files are
    // guaranteed on disk by Rollup's final hook.
    closeBundle() {
      const modelsDir = resolve(outDir, 'models');
      let removed = 0;
      let freed = 0;
      const visit = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            visit(path);
            // Bake-only kinds (planes/, props/) hold nothing tracked; drop
            // them once emptied so the layout matches a fresh checkout.
            try {
              rmdirSync(path);
            } catch {
              // not empty — tracked content stays
            }
          } else if (entry.name.toLowerCase().endsWith('.glb')) {
            freed += statSync(path).size;
            rmSync(path);
            removed += 1;
          }
        }
      };
      try {
        visit(modelsDir);
      } catch {
        return; // no models directory was copied — nothing to prune
      }
      if (removed > 0) {
        console.log(
          `[prune-baked-glb] removed ${removed} baked .glb files ` +
            `(${(freed / 1024 / 1024).toFixed(0)} MB) from ${modelsDir}`,
        );
      }
    },
  };
}

// The offline GameParams ship-data pack (src/res/data/gameparams/*.json —
// untracked extraction output from scripts/extract_gameparams.py, ~135 MB raw
// / ~13 MB compressed, one armed-ship subtree per file + upgrade prices +
// build marker) rides publicDir into outDir like every other res asset.
// Desktop never reads it (ship data comes from the install, and a stale
// bundled copy would lag the client), so desktop builds prune the whole
// directory to keep dist — and the embedded desktop binary — free of dead
// weight; WOWSP_MOBILE_BUNDLE=1 keeps it for the APK assets where the
// mobile gameparams fallback reads it (commands/gameparams.rs). Same gating
// shape as pruneBakedGlb above.
function pruneGameparams(outDir: string): Plugin {
  return {
    name: 'prune-gameparams',
    apply: 'build',
    closeBundle() {
      const packDir = resolve(outDir, 'data/gameparams');
      let freed = 0;
      let removed = 0;
      const visit = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            visit(path);
          } else {
            freed += statSync(path).size;
            rmSync(path);
            removed += 1;
          }
        }
      };
      try {
        visit(packDir);
      } catch {
        return; // no gameparams pack was copied — nothing to prune
      }
      rmSync(packDir, { recursive: true, force: true });
      if (removed > 0) {
        console.log(
          `[prune-gameparams] removed ${removed} offline gameparams files ` +
            `(${(freed / 1024 / 1024).toFixed(0)} MB) from ${packDir}`,
        );
      }
    },
  };
}

// The res-pack insights rail source (src/res/insights/* — the untracked
// FULL map-insights corpus from `replay-corpus insights` plus the
// `replay-drain credits` envelope, dropped there by the maintainer or
// extracted by scripts/fetch_models.py) rides publicDir into outDir like
// every other res asset — but NOTHING serves it same-origin on any
// platform: the insights loaders (features/holographic/insightsLoader.ts)
// read the DOWNLOADED res-pack cache and fall back to the JS-bundled lite
// doc (src/res/map-insights.json / contributors.json placeholders), so a
// same-origin copy would only bloat the embedded binary/APK with the
// 96×96 heat grids the JS bundle deliberately omits. Pruned from EVERY
// build — desktop and mobile alike, unlike the two gates above.
function pruneResInsights(outDir: string): Plugin {
  return {
    name: 'prune-res-insights',
    apply: 'build',
    closeBundle() {
      const railDir = resolve(outDir, 'insights');
      let freed = 0;
      let removed = 0;
      const visit = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            visit(path);
          } else {
            freed += statSync(path).size;
            rmSync(path);
            removed += 1;
          }
        }
      };
      try {
        visit(railDir);
      } catch {
        return; // no insights dir was copied — nothing to prune
      }
      rmSync(railDir, { recursive: true, force: true });
      if (removed > 0) {
        console.log(
          `[prune-res-insights] removed ${removed} insights rail file(s) ` +
            `(${(freed / 1024 / 1024).toFixed(1)} MB) from ${railDir}`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [
    cleanOutDirContents(resolve(pkgDir, '../../dist/webui')),
    // See pruneResInsights above — the full corpus doc never ships inside a
    // binary; the res-pack update channel is its only rail.
    pruneResInsights(resolve(pkgDir, '../../dist/webui')),
    // Desktop/dev builds prune the baked GLBs (the pack serves from the
    // cache dir) and the offline gameparams pack (ship data reads the
    // install); WOWSP_MOBILE_BUNDLE=1 keeps both for the APK assets.
    ...(mobileBundle
      ? []
      : [pruneBakedGlb(resolve(pkgDir, '../../dist/webui')), pruneGameparams(resolve(pkgDir, '../../dist/webui'))]),
    vueSfc(),
    vueJsx(),
    // hikari's pre-boot window chrome bar (res/boot-chrome.js): draws the
    // caption buttons from the first frame — before this bundle exists — so a
    // frameless window stays closable even when the app hangs; it removes
    // itself when AppTitleBar (hikari HkTitleBar) mounts and claims the window.
    // `bootChrome.ts` owns the page table: ONLY index.html is an app window —
    // every other page is a shell-managed window (the transparent game overlays
    // and the fixed tray panel) — and the bar is DESKTOP-ONLY. Android builds
    // (BOTH routes: WOWSP_MOBILE_BUNDLE=1 and Tauri's TAURI_ENV_PLATFORM=android)
    // run inside a phone shell that owns its own window (tao's Android
    // minimize/maximize are no-ops, and AppTitleBar hides the caption buttons
    // when isMobileApp()), so injecting the three-button bar there would paint
    // dead chrome.
    ...bootChromePluginsFor(androidBundle),
    // @vitejs/plugin-vue-jsx (rolldown-vite mode) injects
    // optimizeDeps.rolldownOptions.transform.jsx = "preserve" so the
    // dep-scanner keeps JSX in its transform output. The scanner's
    // import.meta.glob rewriter matches that string as a SUBSTRING of the
    // code, so any module merely mentioning it (even in a comment) takes
    // the rewriter path, which emits the preserved-JSX code tagged as
    // plain js — and the scan parser then dies with "JSX syntax is
    // disabled", silently skipping dependency pre-bundling on cold dev
    // starts. Override the scanner transform to compile JSX with vue's
    // import source so its output stays parseable; the real dev/build
    // transform (babel via vueJsx above) is unaffected.
    {
      name: "wowsp:scan-jsx-compile",
      config(config) {
        const optimizeDeps = (config.optimizeDeps ??= {});
        const rolldownOptions = (optimizeDeps.rolldownOptions ??= {});
        const transform = (rolldownOptions.transform ??= {});
        transform.jsx = { runtime: "automatic", importSource: "vue" };
      },
    },
    UnoCSS(),
  ],
  resolve: {
    alias: {
      'highlight.js/lib': hljsEsDir,
      '@': resolve(pkgDir, 'src'),
      '@wowsp/shared_ui': resolve(pkgDir, 'src'),
      '@shaders': resolve(pkgDir, '.generated/shaders'),
    },
  },
  // hikari ships uncompiled Vue JSX source; Vite 8's Rolldown dep optimizer
  // strips types but leaves JSX raw, so it must be excluded and served
  // through the plugin pipeline where vue-jsx transforms it.
  optimizeDeps: {
    exclude: ['@celestia-island/hikari'],
  },
  define: {
    __APP_VERSION__: JSON.stringify(readPkgVersion(pkgDir)),
  },
  publicDir: resolve(pkgDir, 'src/res'),
  base: '/',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: mockTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(pkgDir, '../../dist/webui'),
    emptyOutDir: false,
    target: 'es2020',
    rollupOptions: {
      // Five entries, DERIVED from WEBUI_PAGES (src/bootChrome.ts) — the same
      // table the pre-boot bar's htmlFiles comes from, so a page cannot be
      // added to the build without also classifying it as app window/overlay:
      // the main shell (Vue app), the three pre-rendered overlay pages (bare
      // DOM) the Rust watcher loads — the Tab-table window
      // (src/overlay/main.ts), the crosshair aim card (src/overlay/aimcard.ts)
      // and the battle-chat translation card (src/overlay/chat.ts) — and the
      // tray panel (mini Vue app) the tray left click loads — see
      // src/tray/main.ts. (The manual-locate drag-box picker used to be an
      // extra entry rendered in a dedicated window; it now lives inside the
      // main app as features/replay/ManualLocateOverlay.)
      input: Object.fromEntries(
        WEBUI_PAGES.map((page): [string, string] => [page.entry, resolve(pkgDir, page.html)]),
      ),
      output: {
        manualChunks: vendorChunks,
      },
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    globals: true,
    // The theme tests use `vi.resetModules()` + dynamic import; on a 183-file
    // parallel run the 5 s default times out while cold module graphs resolve.
    // 20 s is a ceiling for the slow case, not a budget any test should spend.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
