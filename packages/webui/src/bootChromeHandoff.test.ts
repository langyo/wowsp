import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";

// The REAL shell wrapper (AppTitleBar → hikari HkTitleBar) is what claims the
// window, so this test mounts it instead of a bare HkTitleBar: swapping the
// upstream component out of the wrapper must fail here.
import AppTitleBar from "@/components/layout/AppTitleBar";
import { initLocaleMessages } from "@/i18n";
import { asIndexable } from "@/utils/typing";

/**
 * The boot-chrome HANDOFF, end to end against the really installed hikari.
 *
 * WoWSP ships two halves of the same contract and this test joins them:
 *
 *   1. `@celestia-island/hikari/plugins/boot-chrome` emits
 *      `src/res/boot-chrome.js` into the Tauri build — that inlined script is
 *      what paints the caption bar before the Vue bundle exists (it only runs
 *      inside a Tauri webview, which is why `__TAURI_INTERNALS__` is stubbed;
 *      the stubbed shell API always refuses work, the degraded path is fine
 *      here).
 *   2. `AppTitleBar` wraps hikari's `HkTitleBar` (see AppTitleBar.tsx), which
 *      dispatches `hk:chrome-claim` on mount. The script must then fade out and
 *      remove itself — no second caption bar on top of the app's own title bar.
 *
 * Both halves are read/imported from the INSTALLED package, so this test fails
 * if a future hikari stops shipping the boot script or drops the claim, or if
 * our own wrapper stops rendering HkTitleBar.
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

// The shell window API is the wrapper's only shell dependency; a stub whose
// promises resolve keeps AppTitleBar's mounted hook deterministic.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
    startDragging: async () => {},
    close: async () => {},
  }),
}));

// The title-bar status chips (upstream fault / slow stream / loading / saved)
// are unrelated to the claim contract; stubbing them keeps this test about the
// handoff and keeps the api/store layer out of its module graph.
vi.mock("@/components/layout/TitlebarLoading", () => ({
  default: { name: "TitlebarLoading", render: () => null },
}));
vi.mock("@/components/layout/TitlebarUpstreamFault", () => ({
  default: { name: "TitlebarUpstreamFault", render: () => null },
}));
vi.mock("@/components/layout/TitlebarStreamSlow", () => ({
  default: { name: "TitlebarStreamSlow", render: () => null },
}));
vi.mock("@/components/layout/TitlebarSavedFlash", () => ({
  default: { name: "TitlebarSavedFlash", render: () => null },
}));

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition not reached in time");
    }
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** Mount the real shell wrapper the way AppShell does (pinia + router). */
async function mountAppTitleBar() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  await router.isReady();
  const wrapper = mount(AppTitleBar, {
    // attachTo: the handoff is observed on `document` (the bar's removal, the
    // <html> claim marker), so the bar must be part of the real document.
    attachTo: document.body,
    global: { plugins: [pinia, router] },
  });
  await flushPromises();
  return wrapper;
}

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  // The bar renders only inside a Tauri webview. A shell that refuses every
  // call is enough: this test is about the handoff, not the buttons.
  vi.stubGlobal("__TAURI_INTERNALS__", {
    invoke: vi.fn(() => Promise.reject(new Error("test shell"))),
  });
});

afterEach(() => {
  document.getElementById("hk-boot-chrome")?.remove();
  document.getElementById("hk-boot-chrome-style")?.remove();
  document.documentElement.removeAttribute("data-hk-boot-chrome");
  document.documentElement.removeAttribute("data-hk-chrome");
  document.documentElement.removeAttribute("data-mode");
  document.documentElement.style.removeProperty("--hk-boot-chrome-h");
  document.body.innerHTML = "";
  delete asIndexable(window).HkBootChrome;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pre-boot bar → AppTitleBar handoff", () => {
  it("paints the bar first, then hands the window to AppTitleBar's HkTitleBar", async () => {
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

    // 2. The app shell mounts its title bar — the REAL AppTitleBar wrapper.
    const wrapper = await mountAppTitleBar();

    // The wrapper must actually render hikari's HkTitleBar: that mount is what
    // claims the window (a wrapper that dropped it would strand the boot bar on
    // screen forever, and the previous test could not see that).
    expect(
      wrapper.find(".hk-titlebar").exists(),
      "AppTitleBar renders HkTitleBar",
    ).toBe(true);

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
    expect(
      document.querySelectorAll(".hk-titlebar .hk-titlebar-btn").length,
    ).toBeGreaterThan(0);
  });
});
