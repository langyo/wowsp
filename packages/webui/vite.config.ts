import vueSfc from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import { readdirSync, rmSync, rmdirSync, readFileSync, statSync } from "fs";
import { dirname, resolve } from "path";
import { defineConfig, type Plugin } from "vite";

import UnoCSS from "unocss/vite";

function readPkgVersion(pkgDir: string): string {
  try {
    const raw = readFileSync(resolve(pkgDir, 'package.json'), 'utf-8');
    return JSON.parse(raw).version || 'dev';
  } catch {
    return 'dev';
  }
}

const pkgDir = resolve(__dirname);

const mockTarget = process.env.WOWSP_MOCK_URL || 'http://localhost:8787';

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
  if (/[\\/]node_modules[\\/](three|@types[\\/]three)[\\/]/.test(id)) return 'three';
  if (/[\\/]node_modules[\\/](echarts|zrender)[\\/]/.test(id)) return 'echarts';
  if (/[\\/]node_modules[\\/]lucide-vue-next[\\/]/.test(id)) return 'icons';
  return;
}

// The baked GLB pack (src/res/models/**/*.glb — untracked bake output, ~1.1 GB
// on a machine holding a full bake) rides publicDir into outDir, and the Tauri
// shell then embeds the whole dist into wowsp.exe: a second, dead copy of the
// model pack that the installer already ships as its stage/models payload
// (scripts/build_installers.py). Production serves models from the relocated
// model-pack cache; publicDir paths are only the DEV fallback, where Vite
// serves src/res directly and this plugin never runs. So the build prunes
// every .glb from outDir and keeps the git-tracked 2D subset (~27 MB of
// silhouettes/minimaps — the exact set a fresh CI checkout carries), making
// local builds byte-equivalent to release CI's dist. The ship preview
// portraits (images/ships/[0-9]*.png) are ALSO gitignored derived files, but
// unlike the GLBs they are wanted in the shipped binary: release CI fetches
// them from the res-latest wowsp-images archive before the webui build
// (scripts/build_installers.py --images), so they embed on every side.
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

export default defineConfig({
  plugins: [
    cleanOutDirContents(resolve(pkgDir, '../../dist/webui')),
    pruneBakedGlb(resolve(pkgDir, '../../dist/webui')),
    vueSfc(),
    vueJsx(),
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
      // Three entries: the main shell (Vue app), the pre-rendered overlay
      // page (bare DOM) the Rust Tab watcher loads — see src/overlay/main.ts
      // — and the manual-locate drag-box picker (bare DOM as well).
      input: {
        main: resolve(pkgDir, "index.html"),
        overlay: resolve(pkgDir, "overlay.html"),
        "manual-locate": resolve(pkgDir, "manual-locate.html"),
      },
      output: {
        manualChunks: vendorChunks,
      },
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    globals: true,
  },
});
