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
 *    z-rise (the "overlay, never reflow" contract), and BOTH toggle
 *    reveals (:hover for pointer, :focus-within for keyboard). Neither
 *    the host nor the panel clips any more: the toggle straddles the
 *    panel's content-facing border, so the CONTENT clip moved into
 *    .hk-sidebar-rail-clip (inside the panel).
 * 2. The toggle's straddle geometry (negative inset-inline-end by half the
 *    circle) — its outer half deliberately paints outside the panel.
 * 3. The pin window ([data-pinning]): the panel and any nested sidebar
 *    snap their widths (only the host's footprint animates) and the panel
 *    keeps the peek shadow while the host grows into it.
 * 4. wowsp's own density dress exists and hides exactly the peek-only
 *    content: link text, status text + detail rows, footer key/text/tags —
 *    and wowsp's own rail rules never re-clip the host/panel.
 * 5. The visual surface moved onto the panel (the ui-opacity dial fill +
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
    // The host NEVER clips (the toggle straddles the panel's border, so its
    // outer half must paint) and keeps the width transition the pin window
    // deliberately leaves running.
    const hostGeom = ruleBody(".hk-sidebar-rail-host");
    expect(hostGeom, "the host rule exists").not.toBeNull();
    expect(hostGeom).toContain("overflow: visible");
    expect(hostGeom).toContain("transition: width");
    // The peek is an overlay only in Z now — there is no overflow flip.
    const peeking = ruleBody(".hk-sidebar-rail-host[data-peeking]");
    expect(peeking, "the peeking rule exists").not.toBeNull();
    expect(peeking).toContain("z-index: var(--hk-z-sidebar, 900)");
    // The slide lever lives on the panel's WIDTH, never the host's.
    const panelGeom = ruleBody(".hk-sidebar-rail-panel");
    expect(panelGeom, "the panel rule exists").not.toBeNull();
    expect(panelGeom).toContain("inset-inline-start: 0");
    expect(panelGeom).toContain("transition: width");
    // The panel cannot clip either, and out-specifies HkSidebar's own
    // clipping .hk-sidebar-panel base class regardless of import order.
    expect(panelGeom).toContain("overflow: visible");
    expect(css).toContain(".hk-sidebar-rail-host .hk-sidebar-rail-panel");
  });

  it("clips the panel's CONTENT and straddles the border with the toggle", () => {
    // The wrapper is what keeps full-width rows inside the 56px rail while
    // the panel's width animates (the panel/ host clip nothing).
    const clip = ruleBody(".hk-sidebar-rail-clip");
    expect(clip, "the content clip rule exists").not.toBeNull();
    expect(clip).toContain("overflow: hidden");
    expect(clip).toContain("flex: 1");
    expect(clip).toContain("min-height: 0");
    // The straddle: negative inset-inline-end by (half the circle + half
    // the panel's hairline), so the circle's CENTER rides the border LINE
    // and half of it hangs over the content.
    const toggle = ruleBody(".hk-sidebar-rail-toggle");
    expect(toggle, "the toggle rule exists").not.toBeNull();
    expect(toggle).toContain("inset-inline-end: calc(");
    expect(toggle).toMatch(/\/ -2/);
    expect(toggle).toContain("translate: 0 -50%");
  });

  it("the pin window snaps the panel while only the host animates", () => {
    const pinGroup = ruleBody(".hk-sidebar-rail-host[data-pinning] .hk-sidebar-rail-panel");
    expect(pinGroup, "the pin group exists").not.toBeNull();
    expect(pinGroup).toContain("transition: none");
    // A nested HkSidebar's own width would replay the slide too.
    expect(css).toContain(".hk-sidebar-rail-host[data-pinning] .hk-sidebar,");
    expect(css).toContain(".hk-sidebar-rail-host[data-pinning] .hk-sidebar-panel {");
    // The pinned panel still reads as the elevated drawer it was while the
    // host grows into it.
    const pinShadow = css.match(
      /\.hk-sidebar-rail-host\[data-pinning\] \.hk-sidebar-rail-panel \{[^}]*\}/,
    )?.[0];
    expect(pinShadow).toContain("box-shadow");
    // The HOST's own width transition is deliberately NOT in the kill list.
    expect(css).not.toContain(".hk-sidebar-rail-host[data-pinning] {");
  });

  it("the toggle reveals on BOTH host hover and focus-within (keyboard parity)", () => {
    expect(css).toContain(".hk-sidebar-rail-host:hover .hk-sidebar-rail-toggle");
    expect(css).toContain(".hk-sidebar-rail-host:focus-within .hk-sidebar-rail-toggle");
  });

  it("rail density hides the peek-only content (keyed off the SWAP GENERATION)", () => {
    // The density dress keys off the rail swap's generation, never the
    // host root: the root attribute flips with the state and would
    // restyle the FROZEN leaving generation mid-dissolve — the squeeze
    // the swap exists to fix. The generation's attribute freezes on the
    // leaving copy until it unmounts.
    for (const selector of [
      ".hk-sidebar-rail-generation[data-rail] .sidebar__link",
      ".hk-sidebar-rail-generation[data-rail] .sidebar__link .sidebar__link-text",
      ".hk-sidebar-rail-generation[data-rail] .sidebar__status-text",
      ".hk-sidebar-rail-generation[data-rail] .sidebar__game-detail",
      ".hk-sidebar-rail-generation[data-rail] .sidebar__footer-btn .sidebar__footer-btn-key",
      ".hk-sidebar-rail-generation[data-rail] .sidebar__footer-btn .sidebar__footer-btn-text",
      ".hk-sidebar-rail-generation[data-rail] .sidebar__footer-btn .sidebar__footer-btn-value .hk-tag",
    ]) {
      expect(css, selector).toContain(selector);
    }
    // Nothing keys density off the host root any more.
    expect(css).not.toContain(".sidebar[data-rail]");
    // The tiles center their icons.
    const tile = css.match(
      /\.hk-sidebar-rail-generation\[data-rail\] \.sidebar__link \{[^}]*\}/,
    )?.[0];
    expect(tile).toContain("justify-content: center");
  });

  it("the kit's crossfade swap geometry rides along from the granular entry", () => {
    // The content handoff (hikari 0.55.237): inside the clip, two
    // width-pinned generations exchanged through the tab-panel dissolve.
    // The swap never STRETCHES with the animating clip width; the
    // generations are the flex columns the body expects.
    const swap = ruleBody(".hk-sidebar-rail-clip > .hk-sidebar-rail-swap");
    expect(swap, "the swap sizing rule ships through the subpath").not.toBeNull();
    expect(swap).toContain("align-self: flex-start");
    const gen = ruleBody(".hk-sidebar-rail-swap .hk-sidebar-rail-generation");
    expect(gen, "the generation rule ships through the subpath").not.toBeNull();
    expect(gen).toContain("display: flex");
    expect(gen).toContain("flex-direction: column");
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
    // wowsp adds NO clipping of its own to either rail box: the base
    // .sidebar rule (the host in desktop mode), the desktop reset and the
    // panel must all stay overflow-free — the host lets the straddling
    // toggle paint, and hikari's sheet owns the panel's overflow (visible)
    // plus the clip wrapper's (hidden).
    const ownBase = css.match(/(?:^|\n)\.sidebar \{[^}]*\}/)?.[0];
    expect(ownBase, "the wowsp base .sidebar rule exists").toBeTruthy();
    expect(ownBase).not.toContain("overflow");
    expect(reset).not.toContain("overflow");
    expect(panel).not.toContain("overflow");
    // ...and the drawer variant itself keeps its classic chrome.
    const drawer = css.match(/\.sidebar--drawer \{[^}]*\}/)?.[0];
    expect(drawer).toContain("width: 100%");
  });
});
