import vueSfc from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import { readdirSync, rmSync, readFileSync } from "fs";
import { resolve } from "path";
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

export default defineConfig({
  plugins: [
    cleanOutDirContents(resolve(pkgDir, '../../dist/webui')),
    vueSfc(),
    vueJsx(),
    UnoCSS(),
  ],
  resolve: {
    alias: {
      '@': resolve(pkgDir, 'src'),
      '@wowsp/shared_ui': resolve(pkgDir, 'src'),
      '@shaders': resolve(pkgDir, '.generated/shaders'),
    },
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
