// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { Plugin } from "vite";

import {
  BOOT_RECOVERY_CANONICAL_ORIGIN,
  BOOT_RECOVERY_DEADLINE_MS,
  bootRecoveryScript,
  isCorruptedAppOrigin,
  wowspBootRecovery,
} from "./bootRecovery";

/**
 * Boot recovery is the last line of defence for the MAIN WINDOW.
 *
 * The 0.6.8 incident: WebView2's renderer died, crash recovery reloaded the
 * window on `http://tauri.localhostundefined/`, the Vue bundle never loaded, the
 * static `#loading-screen` stayed up forever and the window could not be
 * closed. Two independent contract layers guard that failure now:
 *
 *   1. a pure predicate + generated inline script (`bootRecovery.ts`), which
 *      heals a corrupted origin and paints a manual reload panel when nothing
 *      mounts — this file pins the predicate matrix and EXECUTES the generated
 *      script against a minimal fake page, so the shipped IIFE is tested rather
 *      than just string-matched;
 *   2. the Vite plugin wiring, guarded at source level (importing
 *      `vite.config.ts` from here would pull the whole Node-project config into
 *      the app program — see bootChrome.test.ts), plus the AppShell ack that
 *      stands the Rust close watchdog down.
 *
 * Node environment on purpose: no DOM is needed — the script is an IIFE with no
 * imports whose only browser globals (location / document / setTimeout) are
 * parameters of the fake page harness below.
 */

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The four shell-managed windows — never the recovery's injection target. */
const SHELL_MANAGED_PAGES = ["overlay.html", "aimcard.html", "chat.html", "tray.html"];

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
    {},
    '<!doctype html><html><body><div id="app"></div></body></html>',
    { filename },
  );
  return tags ?? [];
}

// ── fake page harness ──────────────────────────────────────────────────────
// The generated script only reaches for three globals. Passing fakes as
// Function parameters shadows Node's (absent) globals, so the REAL shipped
// script text runs unmodified — no copied logic, no drift.

interface FakeNode {
  tag: string;
  className: string;
  textContent: string;
  type?: string;
  attributes: Record<string, string>;
  children: FakeNode[];
  listeners: Record<string, Array<() => void>>;
  classList: { contains: (name: string) => boolean };
  setAttribute: (name: string, value: string) => void;
  appendChild: (child: FakeNode) => void;
  addEventListener: (type: string, listener: () => void) => void;
}

function fakeNode(tag: string, hidden = false): FakeNode {
  const node: FakeNode = {
    tag,
    className: "",
    textContent: "",
    attributes: {},
    children: [],
    listeners: {},
    classList: { contains: (name) => hidden && name === "hidden" },
    setAttribute(name, value) {
      node.attributes[name] = value;
    },
    appendChild(child) {
      node.children.push(child);
    },
    addEventListener(type, listener) {
      (node.listeners[type] ??= []).push(listener);
    },
  };
  return node;
}

function mustFind(nodes: FakeNode[], tag: string): FakeNode {
  const found = nodes.find((node) => node.tag === tag);
  if (!found) throw new Error("the failure panel has no <" + tag + ">");
  return found;
}

interface FakeLocation {
  protocol: string;
  hostname: string;
  replace: (url: string) => void;
  reload: () => void;
}

interface FakeDocument {
  getElementById: (id: string) => FakeNode | null;
  createElement: (tag: string) => FakeNode;
}

type FakeSetTimeout = (callback: () => void, ms: number) => number;

interface RecoveryRun {
  replaced: string[];
  /** Live read: the counter is mutated by button clicks after the run. */
  readonly reloads: number;
  timers: Array<{ callback: () => void; ms: number }>;
  /** The fake #loading-screen (null = absent, i.e. the app mounted). */
  loading: FakeNode | null;
  location: FakeLocation;
}

/**
 * Run the generated script once against a synthetic page:
 * loader present / dismissed-but-fading / already removed.
 */
function runRecovery(options: {
  protocol: string;
  hostname: string;
  loader: "present" | "hidden" | "absent";
  /** Simulate a refused navigation: location.replace records the attempt, then throws. */
  replaceThrows?: boolean;
}): RecoveryRun {
  const replaced: string[] = [];
  let reloads = 0;
  const timers: Array<{ callback: () => void; ms: number }> = [];

  const loading =
    options.loader === "absent" ? null : fakeNode("div", options.loader === "hidden");
  if (loading) loading.textContent = "WoWSP loading…"; // the static placeholder

  const location: FakeLocation = {
    protocol: options.protocol,
    hostname: options.hostname,
    replace: (url) => {
      replaced.push(url);
      if (options.replaceThrows) throw new Error("navigation refused");
    },
    reload: () => {
      reloads += 1;
    },
  };

  const fakeDocument: FakeDocument = {
    getElementById: (id) => (id === "loading-screen" ? loading : null),
    createElement: (tag) => fakeNode(tag),
  };

  const fakeSetTimeout: FakeSetTimeout = (callback, ms) => {
    timers.push({ callback, ms });
    return timers.length;
  };

  const run = new Function(
    "location",
    "document",
    "setTimeout",
    bootRecoveryScript(),
  ) as (
    location: FakeLocation,
    document: FakeDocument,
    setTimeout: FakeSetTimeout,
  ) => void;
  run(location, fakeDocument, fakeSetTimeout);

  return {
    replaced,
    timers,
    loading,
    location,
    get reloads() {
      return reloads;
    },
  };
}

// ── the pure predicate ───────────────────────────────────────────────────────

describe("isCorruptedAppOrigin", () => {
  it("pins the canonical origin and deadline the rest of the system assumes", () => {
    expect(BOOT_RECOVERY_CANONICAL_ORIGIN).toBe("http://tauri.localhost");
    expect(BOOT_RECOVERY_DEADLINE_MS).toBe(15_000);
  });

  it("accepts the healthy http(s) app origin", () => {
    expect(isCorruptedAppOrigin("http:", "tauri.localhost")).toBe(false);
    expect(isCorruptedAppOrigin("https:", "tauri.localhost")).toBe(false);
  });

  it("catches the observed crash-recovery host and its suffix variants", () => {
    // The exact 0.6.8 incident value: an origin the embedded asset handler
    // still serves, but which breaks every relative asset URL and the IPC
    // channel. Any host starting with the app host but not equal to it is the
    // same class of recovery debris.
    expect(isCorruptedAppOrigin("http:", "tauri.localhostundefined")).toBe(true);
    expect(isCorruptedAppOrigin("https:", "tauri.localhostundefined")).toBe(true);
    expect(isCorruptedAppOrigin("http:", "tauri.localhost.")).toBe(true);
    expect(isCorruptedAppOrigin("http:", "tauri.localhostx")).toBe(true);
  });

  it("leaves every legitimate non-app origin alone", () => {
    const allowed: Array<[string, string]> = [
      // Vite dev server and plain browser tabs.
      ["http:", "127.0.0.1"],
      ["http:", "localhost"],
      ["http:", "example.com"],
      // The asset/media custom hosts the webview also talks to.
      ["http:", "asset.localhost"],
      ["http:", "media.localhost"],
      // A host that merely CONTAINS the app host is not recovery debris.
      ["http:", "not-tauri.localhost"],
    ];
    for (const [protocol, hostname] of allowed) {
      expect(isCorruptedAppOrigin(protocol, hostname), protocol + "//" + hostname).toBe(false);
    }
  });

  it("never redirects the tauri:// origins macOS/Linux use", () => {
    // Same hostname string, different URL space: an http redirect would throw
    // away the scheme the platform actually uses.
    expect(isCorruptedAppOrigin("tauri:", "localhost")).toBe(false);
    expect(isCorruptedAppOrigin("tauri:", "tauri.localhostundefined")).toBe(false);
    expect(isCorruptedAppOrigin("tauri:", "tauri.localhost")).toBe(false);
    // …and no other scheme is an app origin either.
    expect(isCorruptedAppOrigin("file:", "tauri.localhostundefined")).toBe(false);
    expect(isCorruptedAppOrigin("chrome-extension:", "tauri.localhostundefined")).toBe(false);
  });
});

// ── the inline script's content contract ─────────────────────────────────────

describe("the generated inline recovery script", () => {
  const script = bootRecoveryScript();

  it("embeds the canonical origin and the watchdog deadline from the constants", () => {
    expect(script).toContain(JSON.stringify(BOOT_RECOVERY_CANONICAL_ORIGIN));
    expect(script).toContain(String(BOOT_RECOVERY_DEADLINE_MS));
    // The heal target is the origin plus the app root path.
    expect(script).toContain('CANONICAL_ORIGIN + "/"');
  });

  it("is a single classic IIFE: no imports, no inline HTML, no injection surface", () => {
    expect(script.startsWith("(function () {")).toBe(true);
    expect(script.endsWith("})();")).toBe(true);
    // A classic inline script must survive HTML serialization: a literal
    // "</script" (case-insensitive) or "<!--" would end / comment out the tag.
    expect(script.toLowerCase()).not.toContain("</script");
    expect(script).not.toContain("<!--");
    expect(script).not.toContain("import ");
    // The failure panel is assembled with DOM APIs and textContent only —
    // nothing here can inject markup.
    expect(script).not.toContain("innerHTML");
    expect(script).not.toContain("outerHTML");
    // The constants are JSON-escaped into the template literal; no template
    // placeholder may leak into the generated text.
    expect(script).not.toContain(String.fromCharCode(36) + "{");
  });

  it("is ASCII-only (CSP-hashed as bytes, deterministic across builds)", () => {
    const foreign = [...script].filter((char) => {
      const code = char.charCodeAt(0);
      return code !== 9 && code !== 10 && (code < 32 || code > 126);
    });
    expect(foreign).toEqual([]);
  });

  it("reads no page input beyond the protocol and hostname", () => {
    // No path/query/hash/URL is ever consumed, so a crafted link cannot steer
    // the heal target or the panel copy.
    expect(script).not.toMatch(/location\.(?:pathname|search|hash|href|origin|port|username|password)/);
    expect(script).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    // The only URL literal in the whole script is the canonical origin.
    expect(script.match(/https?:\/\/[^\s"']+/g) ?? []).toEqual([BOOT_RECOVERY_CANONICAL_ORIGIN]);
  });

  it("never navigates automatically except for the one corrupted-origin heal", () => {
    // The reload belongs to the panel button; the watchdog itself never
    // reloads, so a build that never mounts cannot enter a reload loop.
    expect(script.match(/location\.reload\(/g) ?? []).toHaveLength(1);
    expect(script.match(/location\.replace\(/g) ?? []).toHaveLength(1);
    expect(script.match(/setTimeout\(/g) ?? []).toHaveLength(1);
  });

  it("is deterministic: no arguments, identical text on every call", () => {
    expect(bootRecoveryScript()).toBe(script);
  });
});

// ── the inline script's behaviour, executed ─────────────────────────────────

describe("the recovery script's runtime behaviour (executed against a fake page)", () => {
  it("heals the corrupted origin before anything else and does not arm the watchdog", () => {
    const run = runRecovery({
      protocol: "http:",
      hostname: "tauri.localhostundefined",
      loader: "present",
    });
    expect(run.replaced).toEqual([BOOT_RECOVERY_CANONICAL_ORIGIN + "/"]);
    expect(run.timers).toHaveLength(0); // navigating away: no watchdog needed
    expect(run.loading?.textContent).toBe("WoWSP loading…");
  });

  it("arms the watchdog when the origin heal is refused before it starts", () => {
    // location.replace normally never throws; if it does, the healed document
    // never loads. The script must not strand that window on the static loader:
    // it falls through to the 15 s watchdog and the panel button retries the
    // same heal.
    const run = runRecovery({
      protocol: "http:",
      hostname: "tauri.localhostundefined",
      loader: "present",
      replaceThrows: true,
    });
    // The heal was attempted once, then the watchdog was armed.
    expect(run.replaced).toEqual([BOOT_RECOVERY_CANONICAL_ORIGIN + "/"]);
    expect(run.timers).toHaveLength(1);
    expect(run.timers[0].ms).toBe(BOOT_RECOVERY_DEADLINE_MS);

    run.timers[0].callback();
    const panel = mustFind(run.loading?.children ?? [], "div");
    const button = mustFind(panel.children, "button");
    for (const click of button.listeners.click ?? []) click();
    // The retry re-attempts the canonical heal (and never reload-loops in place).
    expect(run.replaced).toEqual([
      BOOT_RECOVERY_CANONICAL_ORIGIN + "/",
      BOOT_RECOVERY_CANONICAL_ORIGIN + "/",
    ]);
    expect(run.reloads).toBe(0);
  });

  it("agrees with isCorruptedAppOrigin across the whole matrix", () => {
    const matrix: Array<[string, string]> = [
      ["http:", "tauri.localhost"],
      ["https:", "tauri.localhost"],
      ["http:", "tauri.localhostundefined"],
      ["https:", "tauri.localhostundefined"],
      ["http:", "127.0.0.1"],
      ["http:", "example.com"],
      ["tauri:", "localhost"],
      ["tauri:", "tauri.localhostundefined"],
      ["file:", "tauri.localhostundefined"],
    ];
    for (const [protocol, hostname] of matrix) {
      const run = runRecovery({ protocol, hostname, loader: "present" });
      expect(run.replaced.length > 0, protocol + "//" + hostname).toBe(
        isCorruptedAppOrigin(protocol, hostname),
      );
    }
  });

  it("arms exactly one watchdog for a healthy origin, at the advertised deadline", () => {
    const run = runRecovery({ protocol: "http:", hostname: "tauri.localhost", loader: "present" });
    expect(run.replaced).toEqual([]);
    expect(run.reloads).toBe(0);
    expect(run.timers).toHaveLength(1);
    expect(run.timers[0].ms).toBe(BOOT_RECOVERY_DEADLINE_MS);
  });

  it("paints the failure panel when the loader is still there at the deadline", () => {
    const run = runRecovery({ protocol: "http:", hostname: "tauri.localhost", loader: "present" });
    const loading = run.loading;
    expect(loading).not.toBeNull();
    run.timers[0].callback();

    // The static placeholder is REPLACED, not covered: contents cleared and
    // exactly the style + panel appended inside the existing container (which
    // still owns the full-page backdrop).
    expect(loading?.textContent).toBe("");
    expect(loading?.children.map((child) => child.tag)).toEqual(["style", "div"]);

    const style = mustFind(loading?.children ?? [], "style");
    // Same colour-scheme contract as index.html: the panel must not flip to
    // light colours on a dark desktop (or vice versa) when the theme never
    // loaded.
    expect(style.textContent).toContain("prefers-color-scheme:light");
    expect(style.textContent).toContain("#cfe3ff");
    expect(style.textContent).toContain("#1e2837");

    const panel = mustFind(loading?.children ?? [], "div");
    expect(panel.className).toBe("wowsp-boot-failure");
    expect(panel.attributes.role).toBe("alert");

    const message = mustFind(panel.children, "p");
    expect(message.textContent).toContain("did not finish loading");

    // Manual recovery only: reaching the deadline never navigates.
    expect(run.reloads).toBe(0);
    expect(run.replaced).toEqual([]);

    const button = mustFind(panel.children, "button");
    expect(button.type).toBe("button");
    expect(button.textContent).toBe("Reload WoWSP");
    const clicks = button.listeners.click ?? [];
    expect(clicks).toHaveLength(1);
    for (const click of clicks) click();
    expect(run.reloads).toBe(1); // the user chose to retry
  });

  it("does nothing once the app has mounted (loader removed, or fading out)", () => {
    // Mounted and dismissed a while ago: __loaderDismiss removed the element.
    const absent = runRecovery({
      protocol: "http:",
      hostname: "tauri.localhost",
      loader: "absent",
    });
    expect(absent.timers).toHaveLength(1);
    expect(() => absent.timers[0].callback()).not.toThrow();
    expect(absent.reloads).toBe(0);
    expect(absent.replaced).toEqual([]);

    // Mounted a moment ago: __loaderDismiss added "hidden" and the 400 ms
    // removal timer is in flight — painting a failure panel over a live app
    // would be the wrong call.
    const hidden = runRecovery({
      protocol: "http:",
      hostname: "tauri.localhost",
      loader: "hidden",
    });
    hidden.timers[0].callback();
    expect(hidden.loading?.textContent).toBe("WoWSP loading…");
    expect(hidden.loading?.children).toHaveLength(0);
    expect(hidden.reloads).toBe(0);
  });

  it("reloads a dev-server page in place instead of sending it to the app origin", () => {
    const run = runRecovery({ protocol: "http:", hostname: "127.0.0.1", loader: "present" });
    run.timers[0].callback();
    const button = mustFind(mustFind(run.loading?.children ?? [], "div").children, "button");
    for (const click of button.listeners.click ?? []) click();
    expect(run.reloads).toBe(1);
    expect(run.replaced).toEqual([]);
  });

  it("retries the origin heal if the page only turns out corrupted later", () => {
    // The panel is painted on a healthy first read; if recovery debris shows up
    // before the user clicks, the button must heal instead of reload-looping.
    const run = runRecovery({ protocol: "http:", hostname: "tauri.localhost", loader: "present" });
    run.timers[0].callback();
    run.location.hostname = "tauri.localhostundefined";
    const button = mustFind(mustFind(run.loading?.children ?? [], "div").children, "button");
    for (const click of button.listeners.click ?? []) click();
    expect(run.replaced).toEqual([BOOT_RECOVERY_CANONICAL_ORIGIN + "/"]);
    expect(run.reloads).toBe(0);
  });
});

// ── the Vite plugin ─────────────────────────────────────────────────────────

describe("wowspBootRecovery plugin", () => {
  it("is named wowsp-boot-recovery and runs in dev as well as build", () => {
    const plugin = wowspBootRecovery();
    expect(plugin.name).toBe("wowsp-boot-recovery");
    // No apply: 'build' — dev serves the same HTML through this hook.
    expect(plugin.apply).toBeUndefined();
  });

  it("injects exactly one inline classic <head> script into index.html only", () => {
    const plugin = wowspBootRecovery();
    for (const page of ["index.html", ...SHELL_MANAGED_PAGES]) {
      const tags = transform(plugin, join(PKG_DIR, page));
      if (page !== "index.html") {
        expect(tags, page + " is shell-managed — no boot recovery").toHaveLength(0);
        continue;
      }
      expect(tags).toHaveLength(1);
      expect(tags[0].tag).toBe("script");
      // Classic, not type=module: a classic inline script runs during parsing
      // while modules are deferred, so the heal still lands before the bundle.
      expect(tags[0].attrs?.type).toBeUndefined();
      // `head` (end of <head>), NOT `head-prepend`: the tag must stay after the
      // document's <meta charset> so the 1024-byte encoding prescan still finds
      // it (this script is ~3.6 KB; Tauri serves text/html without a charset).
      expect(tags[0].injectTo).toBe("head");
      // Inline, not src=: the corrupted origin is exactly where a second
      // request could fail.
      expect(tags[0].attrs?.src).toBeUndefined();
      expect(tags[0].attrs?.["data-wowsp-boot-recovery"]).toBe("");
      expect(tags[0].children).toBe(bootRecoveryScript());
    }
  });

  it("treats an absent filename as the main entry (programmatic callers)", () => {
    expect(transform(wowspBootRecovery(), "")).toHaveLength(1);
  });
});

// ── wiring guards (source-level, like bootChrome.test.ts) ───────────────────

/** The code region of the `plugins: [ ... ]` array (bracket-balanced). */
function pluginsRegion(source: string): string {
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

describe("vite.config.ts wiring (source-level guard)", () => {
  const source = readFileSync(resolve(PKG_DIR, "vite.config.ts"), "utf8");

  it("imports the plugin from ./src/bootRecovery without an extension", () => {
    // Extensionless for the same composite-project reason as bootChrome.ts;
    // the `.ts` spelling would need allowImportingTsExtensions (TS5097/6307).
    expect(source).toContain('from "./src/bootRecovery";');
    expect(source).toContain("wowspBootRecovery");
  });

  it("registers wowspBootRecovery() exactly once, next to the boot-chrome spread", () => {
    const region = pluginsRegion(source);
    const registration = region
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("wowspBootRecovery("));
    expect(registration).toEqual(["wowspBootRecovery(),"]);

    // It must sit with the boot-chrome plugins (the two pre-boot layers are
    // reviewed together), after the Android-gated factory spread.
    const chrome = region.indexOf("...bootChromePluginsFor(");
    const recovery = region.indexOf("wowspBootRecovery()");
    expect(chrome).toBeGreaterThanOrEqual(0);
    expect(recovery).toBeGreaterThan(chrome);
  });
});

describe("AppShell close-requested ack (source-level guard)", () => {
  const shell = readFileSync(
    resolve(PKG_DIR, "src/components/layout/AppShell.tsx"),
    "utf8",
  );
  const rpc = readFileSync(resolve(PKG_DIR, "src/rpc.ts"), "utf8");

  it("acks close_requested_ack as the listener's first action", () => {
    // Rust arms a 5 s force-close watchdog before emitting the event; the ack
    // must come before the dialog/action branches, or a wedged renderer could
    // be killed while the quit decision is still pending.
    const handlerStart = shell.indexOf('listen("close-requested"');
    const ack = shell.indexOf('invoke("close_requested_ack")');
    const dialog = shell.indexOf("const saved = closeBehavior.action;");
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(ack).toBeGreaterThan(handlerStart);
    expect(dialog).toBeGreaterThan(ack);
    // Fire-and-forget: an older shell without the command must not surface a
    // rejection into the quit flow.
    expect(shell).toContain('invoke("close_requested_ack").catch(() => undefined)');
  });

  it("keeps the command in the RPC table (check_rpc_parity.py gate)", () => {
    // The parity script requires every Rust #[tauri::command] here, even when
    // the call site uses a raw invoke literal.
    expect(rpc).toContain('close_requested_ack: "close_requested_ack",');
  });
});
