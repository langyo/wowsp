// Build-time prerendering. After `vite build` fills dist/website, this
// script renders every route's markup with the REAL app — App shell +
// view + i18n — through Vite's ssrLoadModule pipeline (same
// TSX/SASS/alias transforms as the browser build), then splices it into
// the built index.html. First paint then shows native, styled HTML with
// zero JavaScript: no white screen while the entry bundle streams in.
//
// Output layout (per route, plus the 404.html SPA mirror = home):
//   dist/website/index.html            prerendered /
//   dist/website/mods/index.html       prerendered /mods
//   dist/website/download/index.html   prerendered /download
//
// Each page carries TWO locale snapshots (zh-Hans visible, en hidden)
// and a tiny inline picker that mirrors main.ts loadLocale — the right
// one shows before first paint, and the live app simply re-renders #app
// when the entry module mounts. The route's CSS chunk is linked in
// <head> so the paint is styled even before the JS that would load it.
//
// Runs as its own process (see package.json "build": embedding this in
// a vite closeBundle plugin instead makes two Vite instances share one
// rolldown-vite process, which eats the JS heap after finishing) via
// Node's type stripping:
//   node --experimental-strip-types scripts/prerender.ts
// (Node >= 23.6 runs .ts natively without the flag.)
import { createServer } from "vite";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(pkgDir, "../../dist/website");

const ROUTES = [
  { path: "/", view: "HomeView", out: "index.html" },
  { path: "/mods", view: "ModsView", out: "mods/index.html" },
  { path: "/download", view: "DownloadView", out: "download/index.html" },
];

// Primary locale first: it is the visible default when JS is disabled.
const LOCALES = ["zh-Hans", "en"];

// In-project TS stubs swapped in for browser-only CJS deps during
// prerendering (loaded through the Vite pipeline, hence .ts sources).
const xtermStub = fileURLToPath(new URL("../src/prerender/stubs/xterm.ts", import.meta.url));
const hljsStubUrl = pathToFileURL(
  fileURLToPath(new URL("../src/prerender/stubs/hljs.ts", import.meta.url)),
).href;

// Locale picker — MUST mirror main.ts loadLocale + locales.ts
// detectLocale (localStorage key, valid set, navigator fallback) and
// main.ts's document.documentElement.lang update. Runs inline right
// after the two snapshots, i.e. before first paint.
const PICKER = `<script>
(function () {
  var saved;
  try { saved = localStorage.getItem("wowsp-site-locale"); } catch (e) {}
  var valid = /^(en|zh-Hans|zh-Hant|ja|ko|fr|es|ru)$/;
  var n = ((navigator && navigator.language) || "en").toLowerCase();
  var loc = valid.test(saved) ? saved
    : n.indexOf("zh") === 0
      ? (n.indexOf("hant") >= 0 || n.indexOf("tw") >= 0 || n.indexOf("hk") >= 0 ? "zh-Hant" : "zh-Hans")
      : n.indexOf("ja") === 0 ? "ja"
      : n.indexOf("ko") === 0 ? "ko"
      : n.indexOf("fr") === 0 ? "fr"
      : n.indexOf("es") === 0 ? "es"
      : n.indexOf("ru") === 0 ? "ru"
      : "en";
  // Only zh-Hans and en snapshots exist; zh-Hant is closer to Hans than
  // to English, everything else rides the en snapshot until mount.
  var want = loc === "zh-Hans" || loc === "zh-Hant" ? "zh-Hans" : "en";
  var app = document.currentScript.parentNode;
  var kids = app.children;
  for (var i = kids.length - 1; i >= 0; i--) {
    var kid = kids[i];
    if (!kid.hasAttribute("data-prerender-locale")) continue;
    if (kid.getAttribute("data-prerender-locale") === want) kid.removeAttribute("hidden");
    else kid.remove();
  }
  document.documentElement.lang = loc;
})();
</script>`;

// Reveal content starts at opacity:0 and only appears when its
// IntersectionObserver fires — there is no JS in the static page, so
// bake the settled state into every reveal class. The live app owns the
// DOM again at mount (in-viewport reveals flip instantly via the
// observer fallback, so the swap is invisible).
function markRevealsVisible(html: string): string {
  return html.replace(/class="([^"]*)"/g, (whole, value: string) =>
    /(^|\s)reveal(\s|$)/.test(value) && !/(^|\s)is-visible(\s|$)/.test(value)
      ? `class="${value.replace(/(^|\s)reveal(\s|$)/, "$1reveal is-visible$2")}"`
      : whole,
  );
}

// Route CSS chunk discovery: Vite names a view's CSS after its source
// module (HomeView-<hash>.css). The entry stylesheet is already linked
// by Vite; this links the route's own chunk so the prerendered markup
// is styled before the lazy JS that would otherwise load it.
function routeCssLink(base: string, view: string): string {
  const assetsDir = resolve(outDir, "assets");
  let names: string[];
  try {
    names = readdirSync(assetsDir);
  } catch {
    names = [];
  }
  const match = names.find((n) => n.startsWith(`${view}-`) && n.endsWith(".css"));
  if (!match) {
    console.warn(`prerender: no CSS chunk found for ${view} (unstyled pre-JS paint)`);
    return "";
  }
  return `<link rel="stylesheet" crossorigin href="${base}assets/${match}">`;
}

const server = await createServer({
  root: pkgDir,
  server: { middlewareMode: true },
  logLevel: "error",
  resolve: {
    alias: {
      // hikari's barrel re-exports the terminal component; its CJS
      // package cannot be named-imported under the SSR runner's
      // interop, and no terminal is ever rendered while prerendering.
      // Inline aliases merge after the config file's — no competition
      // for this specifier, and bare-dep resolution for the ssr runner
      // goes through the native resolver, which user plugin resolveId
      // hooks never see.
      "@xterm/xterm": xtermStub,
    },
  },
  plugins: [
    {
      name: "prerender-style-stub",
      enforce: "pre",
      resolveId(source, importer, options) {
        const ssr = options?.ssr ?? this.environment?.name === "ssr";
        // Prerendering needs class NAMES, never CSS text — vite:css's
        // sass invocation crashes in the ssr environment (dependency
        // stylesheets the browser pipeline tree-shakes away never
        // compiled there either), so stylesheets resolve to one shared
        // empty module and vite:css never engages.
        if (ssr && importer && /\.(scss|sass|css)(\?.*)?$/.test(source)) {
          return "\0prerender-style-stub";
        }
        return null;
      },
      load(id, options) {
        const ssr = options?.ssr ?? this.environment?.name === "ssr";
        if (!ssr) return null;
        if (id === "\0prerender-style-stub") return "export default {}";
        // highlight.js's es/core.js shim re-exports ../lib/core.js,
        // whose raw CJS cannot be evaluated as ESM by the runner
        // (dev/build wrap it; the runner does not) — hand the import
        // the TS stub instead, through the normal pipeline.
        if (id.replace(/\\/g, "/").endsWith("highlight.js/lib/core.js")) {
          return `export { default } from ${JSON.stringify(hljsStubUrl)}`;
        }
        return null;
      },
    },
  ],
});

try {
  const { prerender } = await server.ssrLoadModule("/src/prerender/entry.ts");
  const base = server.config.base.endsWith("/") ? server.config.base : `${server.config.base}/`;
  const shell = readFileSync(resolve(outDir, "index.html"), "utf8");
  if (!shell.includes('<div id="app"></div>')) {
    throw new Error("prerender: built index.html has no empty #app mount point");
  }

  for (const route of ROUTES) {
    const snapshots: string[] = [];
    for (const locale of LOCALES) {
      snapshots.push(await prerender(route.path, locale).then(markRevealsVisible));
    }
    const appBlock = [
      `<div data-prerender-locale="${LOCALES[0]}">${snapshots[0]}</div>`,
      ...LOCALES.slice(1).map(
        (locale, i) => `<div data-prerender-locale="${locale}" hidden>${snapshots[i + 1]}</div>`,
      ),
      PICKER,
    ].join("\n      ");

    const page = shell
      .replace('<div id="app"></div>', `<div id="app">\n      ${appBlock}\n    </div>`)
      .replace("</head>", `    ${routeCssLink(base, route.view)}\n  </head>`);

    const outFile = resolve(outDir, route.out);
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, page);
    // The SPA mirror the build wrote is the empty shell; keep it in
    // lockstep with the prerendered home (unknown paths render via the
    // client router from it either way).
    if (route.out === "index.html") {
      writeFileSync(resolve(outDir, "404.html"), page);
    }
    console.log(
      `prerendered ${route.path} -> ${route.out} ` +
        `(${snapshots.map((s, i) => `${LOCALES[i]} ${s.length}B`).join(", ")})`,
    );
  }
} finally {
  await server.close();
}
