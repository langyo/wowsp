// @vitest-environment node
/**
 * Stylesheet contract of the desktop Sidebar's hikari rail adoption —
 * same conventions as hikari's own HkSidebarRail.styles.test.ts:
 * assertions run on the COMPILED sheet (nesting cannot hide a declaration),
 * compiled through a Node-resolution importer so the granular subpath
 * @use ("@celestia-island/hikari/styles/sidebar-rail.scss") resolves
 * exactly the way the sanctioned style-subpath consumption surface defines
 * it. (dart-sass's own NodePackageImporter cannot read the package's
 * wildcard "./styles/*" export, so resolution rides require.resolve —
 * Node's exports-map support — instead. This file runs in the PLAIN NODE
 * environment: the sheet contract needs no DOM, and dart-sass validates
 * importer returns with an instanceof URL check that only holds when the
 * URL class comes from the same realm.)
 *
 * What is pinned:
 *
 * 1. The granular entry resolves and its geometry rides along in the
 *    compiled output — the host/panel class family, the [data-peeking]
 *    un-clip + z-rise (the "overlay, never reflow" contract), and BOTH
 *    toggle reveals (:hover for pointer, :focus-within for keyboard).
 * 2. wowsp's own density dress exists and hides exactly the peek-only
 *    content: link text, status text + detail rows, footer key/text/tags.
 * 3. The visual surface moved onto the panel (the ui-opacity dial fill +
 *    the border) while the desktop host resets its own paint — and that
 *    reset can never reach the drawer variant.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";

import { compile, type Importer } from "sass";
import { describe, expect, it } from "vitest";

const req = createRequire(import.meta.url);

/** Sass importer: package subpath URLs resolve through Node's exports-aware
 *  require.resolve (pnpm symlinks included); dart-sass hands this importer
 *  absolute file:// URLs for relative @use chains it pre-resolved itself,
 *  and those pass straight through. URL objects come from node:url — the
 *  happy-dom test environment replaces the global URL, and sass's bridge
 *  validates returns with instanceof against Node's. */
const nodeImporter: Importer = {
  canonicalize(url, { containingUrl }) {
    try {
      if (url.startsWith("file://")) return new NodeURL(url);
      if (isAbsolute(url)) return pathToFileURL(url);
      if (
        containingUrl?.protocol === "file:" &&
        (url.startsWith("./") || url.startsWith("../"))
      ) {
        return pathToFileURL(resolve(dirname(fileURLToPath(containingUrl)), url));
      }
      return pathToFileURL(req.resolve(url, { paths: [process.cwd()] }));
    } catch {
      return null;
    }
  },
  load(canonicalUrl) {
    return {
      contents: readFileSync(fileURLToPath(canonicalUrl), "utf8"),
      syntax: "scss",
    };
  },
};

const css = compile(resolve("src/components/layout/Sidebar.scss"), {
  importers: [nodeImporter],
  style: "expanded",
})
  .css.replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Body of the first rule whose selector text matches — the scoping helper
 *  hikari's own styles tests use, so a declaration is asserted INSIDE its
 *  rule instead of anywhere in the sheet. */
function ruleBody(selector: string): string | null {
  const at = css.indexOf(selector);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return close < 0 ? null : css.slice(open + 1, close);
}

describe("Sidebar rail stylesheet contract", () => {
  it("the granular hikari entry resolves and carries the rail geometry", () => {
    expect(css).toContain(".hk-sidebar-rail-host");
    expect(css).toContain(".hk-sidebar-rail-panel");
    expect(css).toContain(".hk-sidebar-rail-toggle");
    expect(css).toContain(".hk-sidebar-rail-host[data-peeking]");
    // The overlay contract: [data-peeking] un-clips the host and rises to
    // the sidebar z band — the peek never reflows the content column.
    const peeking = ruleBody(".hk-sidebar-rail-host[data-peeking]");
    expect(peeking, "the peeking rule exists").not.toBeNull();
    expect(peeking).toContain("overflow: visible");
    expect(peeking).toContain("z-index: var(--hk-z-sidebar, 900)");
    // The slide lever lives on the panel's WIDTH, never the host's.
    const panelGeom = ruleBody(".hk-sidebar-rail-panel");
    expect(panelGeom, "the panel rule exists").not.toBeNull();
    expect(panelGeom).toContain("inset-inline-start: 0");
    expect(panelGeom).toContain("transition: width");
  });

  it("the toggle reveals on BOTH host hover and focus-within (keyboard parity)", () => {
    expect(css).toContain(".hk-sidebar-rail-host:hover .hk-sidebar-rail-toggle");
    expect(css).toContain(".hk-sidebar-rail-host:focus-within .hk-sidebar-rail-toggle");
  });

  it("rail density hides the peek-only content", () => {
    for (const selector of [
      ".sidebar[data-rail] .sidebar__link",
      ".sidebar[data-rail] .sidebar__link .sidebar__link-text",
      ".sidebar[data-rail] .sidebar__status-text",
      ".sidebar[data-rail] .sidebar__game-detail",
      ".sidebar[data-rail] .sidebar__footer-btn .sidebar__footer-btn-key",
      ".sidebar[data-rail] .sidebar__footer-btn .sidebar__footer-btn-text",
      ".sidebar[data-rail] .sidebar__footer-btn .sidebar__footer-btn-value .hk-tag",
    ]) {
      expect(css, selector).toContain(selector);
    }
    // The tiles center their icons.
    const tile = css.match(/\.sidebar\[data-rail\] \.sidebar__link \{[^}]*\}/)?.[0];
    expect(tile).toContain("justify-content: center");
  });

  it("the visual surface moved onto the panel and off the desktop host only", () => {
    // The panel owns the paint (ui-opacity dial fill + edge border), so the
    // peek overlay can carry its full width over the content.
    const panel = css.match(/\.sidebar__panel \{[^}]*\}/)?.[0];
    expect(panel).toContain("var(--ui-opacity, 1)");
    expect(panel).toContain("border-right");
    // The host reset is scoped away from the drawer variant.
    const reset = css.match(/\.sidebar:not\(\.sidebar--drawer\) \{[^}]*\}/)?.[0];
    expect(reset).toContain("background: none");
    expect(reset).toContain("width: auto");
    // ...and the drawer variant itself keeps its classic chrome.
    const drawer = css.match(/\.sidebar--drawer \{[^}]*\}/)?.[0];
    expect(drawer).toContain("width: 100%");
  });
});
