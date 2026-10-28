// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { Plugin } from "vite";

import {
  BOOT_CHROME_HTML_FILES,
  WEBUI_PAGES,
  bootChromePluginsFor,
} from "./bootChrome";

/**
 * The pre-boot window bar is a MULTI-WINDOW contract in this repository.
 *
 * `rollupOptions.input` builds five pages. Only `index.html` is an app window;
 * `overlay.html` / `aimcard.html` / `chat.html` / `tray.html` are transparent,
 * click-through windows the Rust side positions over the game. hikari's
 * `bootChromePlugin` therefore has to be told exactly which entries are app
 * windows — a caption bar injected into one of the four overlays is a 32 px
 * strip floating over the game — and the Android bundle (`WOWSP_MOBILE_BUNDLE=1`)
 * must get NONE of them, because that shell owns its own window.
 *
 * These tests exercise the REAL installed hikari plugin through the same
 * factory `vite.config.ts` uses, and they read `vite.config.ts` to prove the
 * factory is actually wired in: deleting the registration line or dropping the
 * mobile gate must fail here, not only in a manual build-diff review.
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
  injectTo?: string;
}

function transform(
  plugin: Plugin,
  filename: string,
  warnings: string[] = [],
): HtmlTag[] {
  const hook = plugin.transformIndexHtml as unknown as (
    ...args: unknown[]
  ) => HtmlTag[] | undefined;
  const tags = hook.call(
    { warn: (message: string) => void warnings.push(message) },
    '<!doctype html><html><body><div id="app"></div></body></html>',
    { filename },
  );
  return tags ?? [];
}

/** The bar as registered on a desktop build (the only platform that has it). */
function desktopBar(): Plugin {
  const plugins = bootChromePluginsFor(false);
  expect(plugins).toHaveLength(1);
  return plugins[0];
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
    expect(BOOT_CHROME_HTML_FILES).toEqual(["index.html"]);
  });
});

describe("platform gate (desktop vs Android bundle)", () => {
  it("registers hikari's bar on a desktop build", () => {
    // The plugin identity is checked by NAME, not by instance: the name is
    // hikari's public contract (the implementation can be swapped).
    expect(bootChromePluginsFor(false).map((plugin) => plugin.name)).toEqual([
      "hikari-boot-chrome",
    ]);
  });

  it("registers NOTHING on the Android bundle", () => {
    // WOWSP_MOBILE_BUNDLE=1: the phone shell owns the window (tao's Android
    // minimize/maximize are no-ops and AppTitleBar hides the caption buttons),
    // so the desktop three-button bar would be dead chrome over the app.
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
        expect(tags, `${page.html} is a transparent window — no caption bar`).toHaveLength(0);
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

  it("registers the bar through the mobile-gated factory, exactly once", () => {
    const region = pluginsRegion();
    const registration = region
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("...bootChromePluginsFor("));

    // Deleting this spread, or dropping the `mobileBundle` argument, fails
    // here — the false-green hole this test exists to close.
    expect(registration).toEqual(["...bootChromePluginsFor(mobileBundle),"]);

    // Registering the bar directly (the old unconditional `wowspBootChrome()`
    // line) would bypass the Android gate; the factory is the only entry point.
    expect(region).not.toMatch(/\bwowspBootChrome\s*\(/);
  });

  it("imports the factory from the page-table module, extension included", () => {
    // `.ts` is explicit: Vite warns about extensionless local imports (its
    // future native config loader cannot resolve them).
    expect(source).toContain('from "./src/bootChrome.ts"');
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

  it("feeds the gate from the Android-bundle environment flag", () => {
    expect(source).toMatch(
      /const mobileBundle = process\.env\.WOWSP_MOBILE_BUNDLE === ['"]1['"]/,
    );
  });
});
