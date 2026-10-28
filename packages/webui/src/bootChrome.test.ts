// @vitest-environment node
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BOOT_CHROME_HTML_FILES, wowspBootChrome } from "./bootChrome";

/**
 * The pre-boot window bar is a MULTI-WINDOW contract in this repository.
 *
 * `rollupOptions.input` builds five pages. Only `index.html` is an app window;
 * `overlay.html` / `aimcard.html` / `chat.html` / `tray.html` are transparent,
 * click-through windows the Rust side positions over the game. hikari's
 * `bootChromePlugin` therefore has to be told exactly which entries are app
 * windows — a caption bar injected into one of the four overlays is a 32 px
 * strip floating over the game.
 *
 * These tests exercise the REAL installed hikari plugin through the same
 * factory `vite.config.ts` uses, so a wrong entry list (or a new page added
 * without a decision) fails here instead of in a manual build-diff review.
 */

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every page `rollupOptions.input` builds (see vite.config.ts). */
const HTML_ENTRIES = [
  "aimcard.html",
  "chat.html",
  "index.html",
  "overlay.html",
  "tray.html",
];

interface HtmlTag {
  tag: string;
  attrs?: Record<string, unknown>;
  injectTo?: string;
}

function transform(
  plugin: ReturnType<typeof wowspBootChrome>,
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

describe("wowsp boot chrome wiring", () => {
  it("still builds exactly the five pages this contract covers", () => {
    // A sixth page (or a renamed one) must be a conscious decision: either it
    // is an app window and joins htmlFiles, or it is an overlay and must stay
    // out. Failing here is the reminder.
    const pages = readdirSync(PKG_DIR)
      .filter((name) => name.endsWith(".html"))
      .sort();
    expect(pages).toEqual([...HTML_ENTRIES].sort());
  });

  it("injects the bar into the app shell and nowhere else", () => {
    const plugin = wowspBootChrome();
    for (const page of HTML_ENTRIES) {
      const tags = transform(plugin, join(PKG_DIR, page));
      if (page === "index.html") {
        expect(tags, `${page} is the app window`).toHaveLength(1);
      } else {
        expect(tags, `${page} is a transparent window — no caption bar`).toHaveLength(0);
      }
    }
  });

  it("injects a classic body-prepend script titled WoWSP", () => {
    const tags = transform(wowspBootChrome(), join(PKG_DIR, "index.html"));

    expect(tags).toHaveLength(1);
    expect(tags[0].tag).toBe("script");
    // Classic (no type=module): the bar must not wait for the module graph,
    // and body-prepend puts it ahead of the loading screen in the document.
    expect(tags[0].attrs?.type).toBeUndefined();
    expect(tags[0].injectTo).toBe("body-prepend");
    expect(tags[0].attrs?.src).toBe("/hk-boot-chrome.js");
    expect(tags[0].attrs?.["data-hk-title"]).toBe("WoWSP");
  });

  it("lists only entries that really are pages of this package", () => {
    for (const entry of BOOT_CHROME_HTML_FILES) {
      expect(HTML_ENTRIES, `${entry} must exist`).toContain(entry);
    }
  });

  it("reports each skipped entry once (expected multi-window output)", () => {
    // The build log is where a missing entry list becomes visible; WoWSP gets
    // four of these on every build BY DESIGN, so it must not repeat per page.
    const plugin = wowspBootChrome();
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
