import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h } from "vue";

// Repo convention: hikari runtime values come from the umbrella entry (its
// `components/*` subpaths are TypeScript sources that Node cannot load without
// `allowImportingTsExtensions`). This is the same component AppTitleBar wraps.
import { HkTitleBar } from "@celestia-island/hikari";

/**
 * The boot-chrome HANDOFF, end to end against the really installed hikari.
 *
 * WoWSP ships two halves of the same contract and this test joins them:
 *
 *   1. `@celestia-island/hikari/plugins/boot-chrome` emits
 *      `src/res/boot-chrome.js` into the Tauri build — that inlined script is
 *      what paints the caption bar before the Vue bundle exists (it only runs
 *      inside a Tauri webview, which is why `__TAURI_INTERNALS__` is stubbed;
 *      the stubbed shell API always refuses, the degraded path is fine here).
 *   2. `AppTitleBar` wraps hikari's `HkTitleBar` (see AppTitleBar.tsx), which
 *      dispatches `hk:chrome-claim` on mount. The script must then fade out and
 *      remove itself — no second caption bar on top of the app's own title bar.
 *
 * Both halves are read/imported from the INSTALLED package, so this test fails
 * if a future hikari stops shipping the boot script or drops the claim, not
 * just if our own wiring drifts.
 */

const require = createRequire(import.meta.url);

/** Resolve the installed hikari package root through an exported subpath. */
function hikariRoot(): string {
  // `./components/*` is a condition-free export (the package's "." export is
  // import-condition only, and `./package.json` is not exported at all).
  const component = require.resolve(
    "@celestia-island/hikari/components/HkTitleBar.tsx",
  );
  return resolve(dirname(component), "../..");
}

function bootChromeSource(): string {
  return readFileSync(join(hikariRoot(), "src/res/boot-chrome.js"), "utf8");
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition not reached in time");
    }
    await new Promise((done) => setTimeout(done, 20));
  }
}

const apps: Array<ReturnType<typeof createApp>> = [];

beforeEach(() => {
  // The bar renders only inside a Tauri webview. A shell that refuses every
  // call is enough: this test is about the handoff, not the buttons.
  vi.stubGlobal("__TAURI_INTERNALS__", {
    invoke: vi.fn(() => Promise.reject(new Error("test shell"))),
  });
});

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.getElementById("hk-boot-chrome")?.remove();
  document.getElementById("hk-boot-chrome-style")?.remove();
  document.documentElement.removeAttribute("data-hk-boot-chrome");
  document.documentElement.removeAttribute("data-hk-chrome");
  document.documentElement.removeAttribute("data-mode");
  document.documentElement.style.removeProperty("--hk-boot-chrome-h");
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).HkBootChrome;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pre-boot bar → AppTitleBar handoff", () => {
  it("paints the bar first, then disappears when HkTitleBar mounts", async () => {
    // 1. The generated page runs the emitted boot script (classic <script src>).
    new Function(bootChromeSource())();

    const bar = document.getElementById("hk-boot-chrome");
    expect(bar, "the installed boot script must render the bar").not.toBeNull();
    expect(bar!.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(
      [...bar!.querySelectorAll("button[data-act]")].map((b) =>
        b.getAttribute("data-act"),
      ),
    ).toEqual(["minimize", "maximize", "close"]);

    // 2. The app shell mounts its title bar (AppTitleBar → HkTitleBar).
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({
      render: () => h(HkTitleBar as never, { title: "WoWSP" }),
    });
    apps.push(app);
    app.mount(host);

    // 3. The claim lands, the bar fades (160 ms) and removes itself.
    await waitFor(() => document.getElementById("hk-boot-chrome") === null);
    expect(
      document.documentElement.getAttribute("data-hk-chrome"),
      "the app now owns the window chrome",
    ).toBe("app");
    expect(
      document.documentElement.style.getPropertyValue("--hk-boot-chrome-h"),
      "no dangling bar-height variable",
    ).toBe("");
    // The app's own caption buttons are the only ones left.
    expect(document.querySelectorAll("#hk-boot-chrome")).toHaveLength(0);
    expect(document.querySelectorAll(".hk-titlebar .hk-titlebar-btn").length).toBeGreaterThan(0);
  });
});
