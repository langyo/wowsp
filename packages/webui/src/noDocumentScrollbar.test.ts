// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The document-level scrollbar containment contract.
 *
 * WoWSP is an app shell, not a document: the ONE page scroll region is the
 * hikari scroll container inside .app-shell (AppShell.scss), and every
 * floating layer is position: fixed. The <html>/<body> chain therefore must
 * never scroll — a native document scrollbar is always a defect, and the
 * place a user meets one is the very first screen: the pre-mount loading
 * screen (index.html's #loading-screen, a fixed, centered layer that cannot
 * itself overflow) sits on the document, so anything that makes the html
 * element taller than the viewport in a given webview build paints a native
 * scrollbar right beside the boot logo (field report 2026-10-31; it did NOT
 * reproduce in a plain Chromium at any window size, device scale or root
 * zoom, so the pin is unconditional rather than environment-guessed).
 *
 * The rule is pinned TWICE on purpose, and this suite holds both halves:
 *   1. index.html's inline boot <style> — active from the first frame,
 *      before any bundle CSS exists (the loading screen's whole lifetime);
 *   2. theme.scss's reset — the app-lifetime restatement every window that
 *      imports the theme keeps (the main shell and the report window).
 */
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The declaration block of the first rule matching `selector`, sans braces. */
function ruleBlockOf(source: string, selector: RegExp): string | undefined {
  return selector.exec(source)?.[1];
}

describe("document-level scrollbar containment", () => {
  it("index.html pins overflow:hidden on the root chain from the first frame", () => {
    const html = readFileSync(join(PKG_DIR, "index.html"), "utf8");
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    const rule = ruleBlockOf(style, /html,\s*body,\s*#app\s*\{([^}]*)\}/);
    expect(rule, "index.html must keep its html/body/#app boot rule").toBeDefined();
    // Sizing AND containment in the same rule: the chain keeps height:100%
    // (loader and app size against it) and pins the document non-scrolling.
    expect(rule).toContain("height: 100%");
    expect(rule).toContain("overflow: hidden");
  });

  it("theme.scss keeps the document non-scrolling for the app lifetime", () => {
    const scss = readFileSync(join(PKG_DIR, "src", "theme", "theme.scss"), "utf8");
    const rule = ruleBlockOf(scss, /html,\s*body\s*\{([^}]*)\}/);
    expect(rule, "theme.scss must keep its html/body reset rule").toBeDefined();
    expect(rule).toContain("height: 100%");
    expect(rule).toContain("overflow: hidden");
  });
});
