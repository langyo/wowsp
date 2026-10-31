// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type {
  HtmlTagDescriptor,
  MinimalPluginContextWithoutEnvironment,
  Plugin,
} from "vite";

import { fakeAs } from "@/test-utils/fakes";

import {
  BOOT_CHROME_HTML_FILES,
  BOOT_CHROME_LOGO,
  BOOT_CHROME_SKIN_CSS,
  WEBUI_PAGES,
  bootChromePluginsFor,
} from "./bootChrome";

/**
 * The pre-boot window bar is a MULTI-WINDOW contract in this repository.
 *
 * `rollupOptions.input` builds five pages. Only `index.html` is an app window;
 * the other four are shell-managed windows — `overlay.html` / `aimcard.html` /
 * `chat.html` are transparent, click-through pages the Rust side positions over
 * the game, and `tray.html` is the fixed tray panel. hikari's
 * `bootChromePlugin` therefore has to be told exactly which entries are app
 * windows — a caption bar injected into one of those is a 32 px strip floating
 * over the game or a bar on a window the shell owns — and every Android bundle
 * (`WOWSP_MOBILE_BUNDLE=1` or Tauri's `TAURI_ENV_PLATFORM=android`) must get
 * NONE of them, because that shell owns its own window.
 *
 * These tests exercise the REAL installed hikari plugin through the same
 * factory `vite.config.ts` uses, and they read `vite.config.ts` to prove the
 * factory is actually wired in: deleting the registration line or dropping the
 * Android gate must fail here, not only in a manual build-diff review.
 */

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories whose `*.html` files are not build inputs of anything. */
const NOT_A_PAGE_DIR = new Set(["node_modules", "dist", "coverage", ".generated"]);

/**
 * Every HTML file this package ships, relative to the package root, scanned
 * RECURSIVELY (a page may live in a subdirectory) but pruning the heavy
 * non-source trees — walking `node_modules` would make this test the slowest
 * one in the suite for no coverage.
 */
function htmlFilesOnDisk(dir = PKG_DIR, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (NOT_A_PAGE_DIR.has(entry.name)) continue;
      found.push(...htmlFilesOnDisk(join(dir, entry.name), `${path}/`));
    } else if (entry.name.endsWith(".html")) {
      found.push(path);
    }
  }
  return found.sort();
}

interface HtmlTag {
  tag: string;
  attrs?: Record<string, unknown>;
  /** Inline content, for tags Vite serializes with a closing tag (<style>). */
  children?: string;
  injectTo?: string;
}

/** Tag descriptor → the narrow shape these tests read (plugins emit string
 *  inline content only; a nested-descriptor child would be a plugin bug). */
function toTag(d: HtmlTagDescriptor): HtmlTag {
  return {
    tag: d.tag,
    attrs: d.attrs,
    children: typeof d.children === "string" ? d.children : undefined,
    injectTo: d.injectTo,
  };
}

function transform(
  plugin: Plugin,
  filename: string,
  warnings: string[] = [],
): HtmlTag[] {
  // Vite types the hook as a function|object|array union; these boot plugins
  // expose the plain function form. Narrowing on `typeof` (instead of casting)
  // keeps the call checked, and the sync assertions below fail loudly if a
  // plugin ever becomes async — this helper is called from sync `it()` bodies.
  const hook = plugin.transformIndexHtml;
  if (typeof hook !== "function") {
    throw new Error("boot plugin must expose a transformIndexHtml function hook");
  }
  const out = hook.call(
    fakeAs<MinimalPluginContextWithoutEnvironment>({
      warn: (log: unknown) => void warnings.push(String(log)),
    }),
    '<!doctype html><html><body><div id="app"></div></body></html>',
    { path: filename, filename },
  );
  if (out instanceof Promise) {
    throw new Error("boot plugin transformIndexHtml hook must be synchronous");
  }
  if (typeof out === "string") {
    throw new Error("boot plugin must return tag descriptors, not html");
  }
  const descriptors = Array.isArray(out) ? out : (out?.tags ?? []);
  return descriptors.map(toTag);
}

/** The bar as registered on a desktop build (the only platform that has it). */
function desktopBar(): Plugin {
  const plugins = bootChromePluginsFor(false);
  expect(plugins).toHaveLength(2);
  return plugins[0];
}

/** The host-side skin riding beside the bar on a desktop build. */
function desktopSkin(): Plugin {
  const plugins = bootChromePluginsFor(false);
  return plugins[1];
}

/** The skin's inline CSS, taken from the tag actually injected into the shell. */
function skinCss(): string {
  const tags = transform(desktopSkin(), join(PKG_DIR, "index.html"));
  expect(tags).toHaveLength(1);
  return tags[0].children ?? "";
}

/**
 * The declaration block of the rule whose selector list starts with
 * `selectorStart` — the skin stylesheet is small, so a brace scan is enough
 * (and it avoids asserting against declarations of neighbouring rules).
 */
function ruleFor(css: string, selectorStart: string): string {
  const start = css.indexOf(selectorStart);
  expect(start, `${selectorStart} rule must exist`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/**
 * The skin's CSS with comments stripped — positive/negative assertions about
 * DECLARATIONS must run on this view, because the comments legitimately name
 * the patterns they explain (e.g. the display: none regression).
 */
function cssDeclarations(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the page table is the single source of truth", () => {
  it("builds exactly the pages on disk, including pages nested in subdirectories", () => {
    // A sixth page (in the package root OR a subdirectory) must be a conscious
    // decision: either it is an app window and joins WEBUI_PAGES, or it is an
    // overlay and stays out. Failing here is the reminder, and the failure
    // names the file.
    expect(
      WEBUI_PAGES.map((page) => page.html).sort(),
      "every *.html in the package must be classified in WEBUI_PAGES",
    ).toEqual(htmlFilesOnDisk());
  });

  it("keeps the entry keys and app-window flags this shell is wired to", () => {
    // The keys name the emitted chunks; the Rust shell loads the HTML by file
    // name. Renaming either, or flipping a window's bootChrome flag, is a
    // behaviour change — it must be a conscious edit of this expectation.
    expect(WEBUI_PAGES.map((page) => [page.entry, page.html, page.bootChrome])).toEqual([
      ["main", "index.html", true],
      ["report", "report.html", true],
      ["overlay", "overlay.html", false],
      ["aimcard", "aimcard.html", false],
      ["chat", "chat.html", false],
      ["tray", "tray.html", false],
    ]);
  });

  it("derives the bar's entry list from that table (no hand-maintained copy)", () => {
    expect(BOOT_CHROME_HTML_FILES).toEqual(
      WEBUI_PAGES.filter((page) => page.bootChrome).map((page) => page.html),
    );
    expect(BOOT_CHROME_HTML_FILES).toEqual(["index.html", "report.html"]);
  });
});

describe("platform gate (desktop vs Android bundle)", () => {
  it("registers hikari's bar and the WoWSP skin on a desktop build", () => {
    // The plugin identity is checked by NAME, not by instance: the bar's name
    // is hikari's public contract (the implementation can be swapped), and the
    // skin is the half WoWSP owns.
    expect(bootChromePluginsFor(false).map((plugin) => plugin.name)).toEqual([
      "hikari-boot-chrome",
      "wowsp-boot-chrome-skin",
    ]);
  });

  it("registers NOTHING on the Android bundle", () => {
    // Both Android routes collapse into the same gate: WOWSP_MOBILE_BUNDLE=1
    // (justfile) and TAURI_ENV_PLATFORM=android (tauri android). The shell owns
    // the window there (tao's Android minimize/maximize are no-ops and
    // AppTitleBar hides the caption buttons), so the desktop three-button bar
    // would be dead chrome over the app.
    expect(bootChromePluginsFor(true)).toEqual([]);
  });
});

describe("the registered bar", () => {
  it("injects the bar into the app shell and nowhere else", () => {
    for (const page of WEBUI_PAGES) {
      const tags = transform(desktopBar(), join(PKG_DIR, page.html));
      if (page.bootChrome) {
        expect(tags, `${page.html} is the app window`).toHaveLength(1);
      } else {
        expect(tags, `${page.html} is shell-managed — no caption bar`).toHaveLength(0);
      }
    }
  });

  it("injects a classic body-prepend script titled WoWSP", () => {
    const tags = transform(desktopBar(), join(PKG_DIR, "index.html"));

    expect(tags).toHaveLength(1);
    expect(tags[0].tag).toBe("script");
    // Classic (no type=module): the bar must not wait for the module graph,
    // and body-prepend puts it ahead of the loading screen in the document.
    expect(tags[0].attrs?.type).toBeUndefined();
    expect(tags[0].injectTo).toBe("body-prepend");
    expect(tags[0].attrs?.src).toBe("/hk-boot-chrome.js");
    expect(tags[0].attrs?.["data-hk-title"]).toBe("WoWSP");
  });

  it("reports each skipped entry once (expected multi-window output)", () => {
    // The build log is where a missing entry list becomes visible; WoWSP gets
    // four of these on every build BY DESIGN, so it must not repeat per page.
    const plugin = desktopBar();
    const warnings: string[] = [];
    transform(plugin, join(PKG_DIR, "overlay.html"), warnings);
    transform(plugin, join(PKG_DIR, "overlay.html"), warnings);
    transform(plugin, join(PKG_DIR, "tray.html"), warnings);

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("overlay.html");
    expect(warnings[0]).toContain("htmlFiles");
    expect(warnings[1]).toContain("tray.html");
  });
});

/**
 * The HOST-SIDE SKIN.
 *
 * hikari's bar plugin only knows title/height/hangMs/htmlFiles — no logo, no
 * way to keep the initial "loading…" status out of the bar — so the WoWSP look
 * is one inline stylesheet WoWSP injects itself. These tests pin what a silent
 * regression would take back: the logo (and the asset behind it), the
 * branding-only loading state, and the actionable failure copy.
 */
describe("the host-side skin", () => {
  it("injects a single inline style into the app shell and nowhere else", () => {
    for (const page of WEBUI_PAGES) {
      const tags = transform(desktopSkin(), join(PKG_DIR, page.html));
      if (page.bootChrome) {
        expect(tags, `${page.html} is the app window`).toHaveLength(1);
      } else {
        expect(tags, `${page.html} is shell-managed — no brand skin`).toHaveLength(0);
      }
    }
  });

  it("injects a head tag carrying the data-wowsp-boot-chrome-skin marker", () => {
    const tags = transform(desktopSkin(), join(PKG_DIR, "index.html"));

    expect(tags).toHaveLength(1);
    expect(tags[0].tag).toBe("style");
    // In the head, so the strip is branded before the body-prepended bar
    // script runs; and INLINE, so branding needs no second request to race.
    expect(tags[0].injectTo).toBe("head");
    expect(tags[0].attrs?.["data-wowsp-boot-chrome-skin"]).toBe("");
    expect(tags[0].attrs?.src).toBeUndefined();
    expect(tags[0].children).toBe(BOOT_CHROME_SKIN_CSS);
  });

  it("treats an absent filename as the app entry, matching hikari's plugin", () => {
    // hikari counts a missing filename as the main entry; the skin must agree,
    // or a non-standard caller would get an unbranded strip.
    expect(transform(desktopSkin(), "")).toHaveLength(1);
  });

  it("draws the same logo the real title bar uses", () => {
    expect(BOOT_CHROME_LOGO).toBe("/logo.webp");
    const css = skinCss();
    expect(css).toContain(`url("${BOOT_CHROME_LOGO}")`);
    // Root-absolute URL → the publicDir copy the build ships (src/res is
    // vite.config.ts' publicDir); the file must exist or the ::before box
    // paints nothing.
    const asset = resolve(PKG_DIR, "src/res", BOOT_CHROME_LOGO.replace(/^\/+/, ""));
    expect(existsSync(asset), `${asset} must exist`).toBe(true);
  });

  it("keeps the status visually hidden with the sr-only pattern, staying in the a11y tree", () => {
    const css = skinCss();
    // role="status" must stay exposed to assistive technology: display: none
    // would drop the live region (and its failure announcements) entirely —
    // that is the regression this pattern exists to prevent.
    expect(cssDeclarations(css)).not.toMatch(/display:\s*none/);
    const base = ruleFor(css, "#hk-boot-chrome-status");
    // The standard visually-hidden clip: out of layout and invisible, but
    // still present in the accessibility tree.
    expect(base).toMatch(/position:\s*absolute/);
    expect(base).toMatch(/width:\s*1px/);
    expect(base).toMatch(/height:\s*1px/);
    expect(base).toMatch(/margin:\s*-1px/);
    expect(base).toMatch(/padding:\s*0/);
    expect(base).toMatch(/overflow:\s*hidden/);
    expect(base).toMatch(/clip:\s*rect\(0 0 0 0\)/);
    expect(base).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(base).toMatch(/white-space:\s*nowrap/);
    expect(base).toMatch(/border:\s*0/);
    // ... and it must not smuggle display back in.
    expect(base).not.toMatch(/display\s*:/);
  });

  it("mirrors the titlebar metrics while loading", () => {
    const css = skinCss();
    // .hk-titlebar-title / .hk-titlebar-title-text geometry: 16 px icon box,
    // 8 px gap, 0.04em tracking (size and weight are inherited from the bar).
    expect(css).toMatch(/#hk-boot-chrome-app\s*\{[^}]*gap:\s*8px/);
    expect(css).toMatch(/#hk-boot-chrome-app\s*\{[^}]*letter-spacing:\s*0\.04em/);
    expect(css).toMatch(/#hk-boot-chrome-app::before\s*\{[^}]*width:\s*16px/);
    expect(css).toMatch(/#hk-boot-chrome-app::before\s*\{[^}]*height:\s*16px/);
  });

  it("gives the name and the status one shared 16 px line box", () => {
    // Both spans are centred by the flex row one at a time, and the CJK
    // fallback font's line box differs from the Latin one — the line-box
    // report behind the "vertically off-centre" screenshot.
    const css = skinCss();
    expect(css).toMatch(/#hk-boot-chrome-app\s*\{[^}]*line-height:\s*16px/);
    expect(css).toMatch(/#hk-boot-chrome-status\s*\{[^}]*line-height:\s*16px/);
  });

  it("restores the status to normal flow for both failure states", () => {
    const css = skinCss();
    // degraded: no usable shell API, or a window command was refused (usually
    // a missing ACL grant) — the copy says WHY the buttons are dead.
    const degraded = '#hk-boot-chrome[data-hk-degraded="1"] #hk-boot-chrome-status';
    // hung: the boot watchdog fired; the bar also grows its reload button.
    const hung = 'html[data-hk-boot-chrome="hung"] #hk-boot-chrome-status';
    expect(css).toContain(degraded);
    expect(css).toContain(hung);

    // Both states share one restore rule; every clip declaration must be
    // undone, and NO display override may reappear (the span returns to its
    // default inline box in the flex row).
    const restore = ruleFor(css, degraded);
    expect(restore).toMatch(/position:\s*static/);
    expect(restore).toMatch(/width:\s*auto/);
    expect(restore).toMatch(/height:\s*auto/);
    expect(restore).toMatch(/margin:\s*0/);
    expect(restore).toMatch(/overflow:\s*visible/);
    expect(restore).toMatch(/clip:\s*auto/);
    expect(restore).toMatch(/clip-path:\s*none/);
    expect(restore).not.toMatch(/display\s*:/);
  });
});

/**
 * SOURCE-LEVEL guard on `vite.config.ts`.
 *
 * Importing the config from here would be the nicer check, but it is a file of
 * the composite `tsconfig.node.json` project: pulling it into the app program
 * fails `tsc --noEmit` with TS6305 ("output file … has not been built from
 * source file"), and it would evaluate the whole Vite plugin pipeline inside
 * the test process. So the config is read as TEXT and the two consumption
 * points that matter are pinned.
 */
describe("vite.config.ts wiring (source-level guard)", () => {
  const source = readFileSync(resolve(PKG_DIR, "vite.config.ts"), "utf8");

  /** The code region of the `plugins: [ ... ]` array (bracket-balanced). */
  function pluginsRegion(): string {
    const open = source.indexOf("plugins: [");
    if (open < 0) throw new Error("vite.config.ts has no plugins array");
    const start = source.indexOf("[", open);
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === "[") depth += 1;
      if (source[i] === "]") {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error("unbalanced plugins array in vite.config.ts");
  }

  it("registers the bar through the Android-gated factory, exactly once", () => {
    const region = pluginsRegion();
    const registration = region
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("...bootChromePluginsFor("));

    // Deleting this spread, or dropping the `androidBundle` argument, fails
    // here — the false-green hole this test exists to close.
    expect(registration).toEqual(["...bootChromePluginsFor(androidBundle),"]);

    // Registering the bar directly (the old unconditional `wowspBootChrome()`
    // line) would bypass the Android gate; the factory is the only entry point.
    expect(region).not.toMatch(/\bwowspBootChrome\s*\(/);
  });

  it("imports the factory from the page-table module, without an extension", () => {
    // Extensionless ON PURPOSE: the `.ts` suffix needs
    // `allowImportingTsExtensions` (incompatible with the composite
    // `tsconfig.node.json` projection — TS5097/TS6307), so that spelling would
    // break the tsconfig projection to silence a forward-compat notice. The
    // notice is accepted instead; this assertion pins the decision (it fails
    // for the `.ts` spelling, which would not match the exact line).
    expect(source).toContain('from "./src/bootChrome";');
    expect(source).toContain("bootChromePluginsFor");
    expect(source).toContain("WEBUI_PAGES");
  });

  it("derives rollupOptions.input from the same table", () => {
    expect(source).toContain("input: Object.fromEntries(");
    expect(source).toContain("WEBUI_PAGES.map(");
    // No hand-copied entry list may come back: a literal HTML path resolved
    // inside the config is exactly the drift WEBUI_PAGES exists to prevent.
    expect(source).not.toMatch(
      /resolve\(pkgDir, ['"](?:index|overlay|aimcard|chat|tray)\.html['"]\)/,
    );
  });

  it("feeds the gate from BOTH Android build signals", () => {
    // The FULL APK flavor (justfile android-apk-full) ...
    expect(source).toMatch(
      /const mobileBundle = process\.env\.WOWSP_MOBILE_BUNDLE === ['"]1['"]/,
    );
    // ... and Tauri's own `tauri android` pipeline, which exports
    // TAURI_ENV_PLATFORM=android to the frontend build. The SLIM pin
    // (WOWSP_MOBILE_BUNDLE=0, the distributed flavor) overrides both —
    // its pack downloads on demand, so the dist must prune regardless.
    expect(source).toMatch(/const slimPin = process\.env\.WOWSP_MOBILE_BUNDLE === ['"]0['"]/);
    expect(source).toMatch(
      /!slimPin && \(mobileBundle \|\| process\.env\.TAURI_ENV_PLATFORM === ['"]android['"]\)/,
    );
  });
});
