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
// Node-only (no browser); CI's web job and site.yml run it via
// `pnpm --filter @wowsp/website build`.

import { createServer } from "vite";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(pkgDir, "../../dist/website");

const ROUTES = [
  { path: "/", view: "HomeView", out: "index.html" },
  { path: "/mods", view: "ModsView", out: "mods/index.html" },
  { path: "/download", view: "DownloadView", out: "download/index.html" },
];

// Primary locale first: it is the visible default when JS is disabled.
const LOCALES = ["zh-Hans", "en"];

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
function markRevealsVisible(html) {
  return html.replace(/class="([^"]*)"/g, (whole, value) =>
    /(^|\s)reveal(\s|$)/.test(value) && !/(^|\s)is-visible(\s|$)/.test(value)
      ? `class="${value.replace(/(^|\s)reveal(\s|$)/, "$1reveal is-visible$2")}"`
      : whole,
  );
}

// Route CSS chunk discovery: Vite names a view's CSS after its source
// module (HomeView-<hash>.css). The entry stylesheet is already linked
// by Vite; this links the route's own chunk so the prerendered markup
// is styled before the lazy JS that would otherwise load it.
function routeCssLink(base, view) {
  const assetsDir = resolve(outDir, "assets");
  let names;
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
  // @xterm/xterm: hikari's barrel re-exports the terminal component,
  // whose CJS package cannot be named-imported under the SSR runner's
  // interop — and no terminal is ever rendered during prerendering. The
  // in-project stub keeps the import clean (highlight.js is handled by
  // the load stub inside the plugin below).
  resolve: {
    alias: {
      "@xterm/xterm": fileURLToPath(new URL("./stubs/xterm.mjs", import.meta.url)),
    },
  },
  plugins: [
    // Prerendering needs class NAMES, never CSS text — and vite:css's
    // sass invocation crashes in the ssr environment (dependency
    // stylesheets the browser pipeline tree-shakes away never compiled
    // there either). Redirect every stylesheet import in the SSR
    // pipeline to one shared empty module so vite:css never engages;
    // the client environment is untouched (this server never serves
    // the browser anyway).
    //
    // The load hook below covers the one CJS file the SSR module runner
    // pulls in THROUGH the pipeline: highlight.js's es/core.js shim
    // re-exports ../lib/core.js, whose raw `module.exports` cannot be
    // evaluated as ESM (dev/build wrap it; the runner does not). Swap
    // in the same-shaped ESM stub the resolveId alias above points at.
    {
      name: "prerender-stubs",
      enforce: "pre",
      resolveId(source, importer, options) {
        const ssr = options?.ssr ?? this.environment?.name === "ssr";
        if (ssr && importer && /\.(scss|sass|css)(\?.*)?$/.test(source)) {
          return "\0prerender-style-stub";
        }
        return null;
      },
      load(id, options) {
        const ssr = options?.ssr ?? this.environment?.name === "ssr";
        if (!ssr) return null;
        if (id === "\0prerender-style-stub") return "export default {}";
        if (id.replace(/\\/g, "/").endsWith("highlight.js/lib/core.js")) {
          return readFileSync(fileURLToPath(new URL("./stubs/hljs/core.mjs", import.meta.url)), "utf8");
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
    const snapshots = [];
    for (const locale of LOCALES) {
      snapshots.push(
        await prerender(route.path, locale).then(markRevealsVisible),
      );
    }
    const appBlock = [
      `<div data-prerender-locale="${LOCALES[0]}">${snapshots[0]}</div>`,
      ...LOCALES.slice(1).map(
        (locale, i) => `<div data-prerender-locale="${locale}" hidden>${snapshots[i + 1]}</div>`,
      ),
      PICKER,
    ].join("\n      ");

    const page = shell
      .replace(
        '<div id="app"></div>',
        `<div id="app">\n      ${appBlock}\n    </div>`,
      )
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
