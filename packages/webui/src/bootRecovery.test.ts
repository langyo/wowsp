// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { Plugin } from "vite";

import { bootRecoveryScript } from "@celestia-island/hikari/plugins/boot-recovery";

import { wowspBootRecovery } from "./bootRecovery";

/**
 * WoWSP's boot-recovery WIRING suite.
 *
 * The implementation moved upstream (hikari #955, published as
 * `@celestia-island/hikari/plugins/boot-recovery` in 0.55.249); this host keeps
 * only a thin config wrapper (`src/bootRecovery.ts`). So these tests pin the
 * THREE things that can still drift on this side:
 *
 *   a. `vite.config.ts` actually registers the wrapper (a tested factory that
 *      nobody imports ships nothing);
 *   b. the wrapper really bakes the PUBLISHED script — same bytes as calling
 *      `bootRecoveryScript` from the installed package with the host options,
 *      index.html only, with WoWSP's copy;
 *   c. the close handshake moved to hikari's runtime hook too: `AppShell`
 *      imports `useCloseRequest`, and no legacy close-event listener / ack
 *      call or RPC row remains in the webui sources (the needles below are
 *      assembled from fragments so this file itself stays grep-clean).
 *
 * Node environment on purpose: the suite reads files and generates the script;
 * it never needs a DOM.
 */

/** packages/webui */
const WEBUI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** packages/webui/src */
const SRC_DIR = join(WEBUI_DIR, "src");

/** The exact copy the wrapper hands the published plugin. */
const WOWSP_COPY = {
  message:
    "WoWSP did not finish loading. The app window may have recovered from a crash; reloading usually fixes it.",
  retry: "Reload",
};

/**
 * The retired handshake strings, assembled from fragments so THIS file — the
 * one allowed place that names them — stays clean under the migration's own
 * grep gate (the retired ack-command / event-name literals may not remain in
 * packages/webui/src).
 */
const RETIRED_EVENT = "close" + "-requested";
const RETIRED_ACK = "close_" + "requested_ack";

/** The script the published plugin produces for the host's options. */
function publishedScript(): string {
  return bootRecoveryScript({
    htmlFiles: ["index.html"],
    copy: WOWSP_COPY,
  });
}

interface HtmlTag {
  tag: string;
  attrs?: Record<string, unknown>;
  children?: string;
  injectTo?: string;
}

/** Invoke the plugin's transformIndexHtml hook with a fake file context. */
function transform(plugin: Plugin, filename: string): HtmlTag[] {
  const hook = plugin.transformIndexHtml as unknown as (
    ...args: unknown[]
  ) => HtmlTag[] | undefined;
  const tags = hook.call(
    { warn: () => {} },
    '<!doctype html><html><body><div id="app"></div></body></html>',
    { filename },
  );
  return tags ?? [];
}

function tagsFor(page: string): HtmlTag[] {
  return transform(wowspBootRecovery(), join(WEBUI_DIR, page));
}

/** Source of one webui file, read as UTF-8. */
function source(relative: string): string {
  return readFileSync(join(WEBUI_DIR, relative), "utf8");
}

// ── (a) vite.config.ts registration ────────────────────────────────────────

describe("boot recovery wiring — vite.config.ts", () => {
  it("imports the wrapper and registers it inside the plugins array", () => {
    const config = source("vite.config.ts");
    expect(config, "the config imports the wrapper").toContain(
      'import { wowspBootRecovery } from "./src/bootRecovery";',
    );
    // Find the defineConfig plugins array, then the registration inside it.
    const pluginsStart = config.indexOf("plugins: [");
    expect(pluginsStart).toBeGreaterThanOrEqual(0);
    const pluginsEnd = config.indexOf("],", pluginsStart);
    expect(pluginsEnd).toBeGreaterThan(pluginsStart);
    const plugins = config.slice(pluginsStart, pluginsEnd);
    expect(plugins, "the wrapper call sits INSIDE the plugins array").toContain(
      "wowspBootRecovery()",
    );
  });
});

// ── (b) the wrapper delegates to the PUBLISHED plugin ──────────────────────

describe("boot recovery wiring — published delegation", () => {
  it("injects exactly one tag into index.html and nothing else", () => {
    const pages = readdirSync(WEBUI_DIR)
      .filter((name) => name.endsWith(".html"))
      .sort();
    expect(pages).toEqual([
      "aimcard.html",
      "chat.html",
      "index.html",
      "overlay.html",
      "tray.html",
    ]);
    expect(tagsFor("index.html"), "the SPA shell is the only page").toHaveLength(1);
    for (const page of ["overlay.html", "aimcard.html", "chat.html", "tray.html"]) {
      expect(tagsFor(page), page + " is shell-managed — no recovery").toHaveLength(0);
    }
    // The published plugin treats an absent filename as the main entry.
    expect(transform(wowspBootRecovery(), "")).toHaveLength(1);
  });

  it("bakes ONE inline classic <head> script with the package marker", () => {
    const [tag] = tagsFor("index.html");
    expect(tag.tag).toBe("script");
    // Classic, not type=module: it must run during parsing, before the
    // deferred module graph (the heal needs no bundle).
    expect(tag.attrs?.type).toBeUndefined();
    // Inline, not src=: the mangled origin would also break a second request.
    expect(tag.attrs?.src).toBeUndefined();
    // End of <head>: after <meta charset>, keeping the 1024-byte prescan valid.
    expect(tag.injectTo).toBe("head");
    // The marker comes from the PUBLISHED plugin (hikari's data-hk-* namespace).
    expect(tag.attrs).toMatchObject({ "data-hk-boot-recovery": "" });
  });

  it("emits the exact bytes the installed package generates for the host options", () => {
    const [tag] = tagsFor("index.html");
    expect(tag.children).toBe(publishedScript());
  });

  it("keeps WoWSP's heal, watchdog and copy in the generated script", () => {
    const script = tagsFor("index.html")[0].children ?? "";
    // Heal half: canonical origin + replace-on-mangled-origin.
    expect(script).toContain("http://tauri.localhost");
    expect(script).toContain('CANONICAL_ORIGIN + "/"');
    // Watchdog half: the component defaults are WoWSP's own contract
    // (#loading-screen + the "hidden" dismissal class added by __loaderDismiss).
    expect(script).toContain('"#loading-screen"');
    expect(script).toContain('"hidden"');
    expect(script).toContain("setTimeout(");
    // Host copy.
    expect(script).toContain(JSON.stringify(WOWSP_COPY.message));
    expect(script).toContain(JSON.stringify(WOWSP_COPY.retry));
  });

  it("stays deterministic, ASCII-only and safe to inline", () => {
    const first = tagsFor("index.html")[0].children ?? "";
    const second = tagsFor("index.html")[0].children ?? "";
    expect(first).toBe(second);
    expect(first.startsWith("(function () {")).toBe(true);
    expect(first.endsWith("})();")).toBe(true);
    // ASCII: the script runs before <meta charset> resolves and is byte-hashed
    // into the Tauri CSP at compile time.
    const foreign = [...first].filter((char) => {
      const code = char.charCodeAt(0);
      return code !== 9 && code !== 10 && (code < 32 || code > 126);
    });
    expect(foreign).toEqual([]);
    // No literal tag terminator / template hole can end the inline element.
    expect(first.toLowerCase()).not.toContain("</script");
    expect(first).not.toContain(String.fromCharCode(36) + "{");
  });

  it("is a THIN wrapper: the local implementation is gone", () => {
    const wrapper = source("src/bootRecovery.ts");
    expect(wrapper).toContain(
      'import { bootRecoveryPlugin } from "@celestia-island/hikari/plugins/boot-recovery";',
    );
    // The deleted local implementation's fingerprints must not come back.
    expect(wrapper).not.toContain("function bootRecoveryScript");
    expect(wrapper).not.toContain("function isCorruptedAppOrigin");
    expect(wrapper).not.toContain("FAILURE_PANEL_CSS");
    expect(wrapper).not.toContain("location.replace");
    // Thin: the wrapper is config + doc, not a reimplementation.
    expect(wrapper.length).toBeLessThan(6000);
  });
});

// ── (c) the close handshake moved to hikari's runtime hook ────────────────

/** Every .ts/.tsx file under src (recursive), except a caller-given file. */
function sourceFiles(dir = SRC_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(path, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && statSync(path).isFile()) {
      out.push(path);
    }
  }
  return out;
}

describe("boot recovery wiring — close handshake (hikari runtime hook)", () => {
  it("AppShell subscribes through useCloseRequest", () => {
    const shell = source("src/components/layout/AppShell.tsx");
    expect(shell).toContain(
      'import { useCloseRequest } from "@celestia-island/hikari/runtime";',
    );
    expect(shell).toContain("unlistenClose = useCloseRequest(() => {");
    // The legacy hand-written listener/ack is gone; the runtime hook owns both.
    expect(shell).not.toContain('listen("' + RETIRED_EVENT + '"');
    expect(shell).not.toContain('invoke("' + RETIRED_ACK + '")');
    // The quit decision itself stays host code.
    expect(shell).toContain("handleCloseChoice");
  });

  it("no legacy close handshake remains anywhere in packages/webui/src", () => {
    // This suite is the ONE allowed place the retired strings appear (as the
    // needles themselves); every production/source file must be clean.
    const needles = [
      'listen("' + RETIRED_EVENT + '"',
      'invoke("' + RETIRED_ACK + '")',
      RETIRED_ACK + ': "' + RETIRED_ACK + '"',
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === resolve(dirname(fileURLToPath(import.meta.url)), "bootRecovery.test.ts")) {
        continue;
      }
      const text = readFileSync(file, "utf8");
      for (const needle of needles) {
        if (text.includes(needle)) {
          offenders.push(resolve(file) + " -> " + needle);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("rpc.ts no longer lists the deleted Rust command", () => {
    const rpc = source("src/rpc.ts");
    expect(rpc).not.toContain(RETIRED_ACK);
    // quit_app is still the dialog's exit path.
    expect(rpc).toContain('quit_app: "quit_app"');
  });
});
