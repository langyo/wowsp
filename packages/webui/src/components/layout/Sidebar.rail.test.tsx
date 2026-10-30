/**
 * Tests for the desktop Sidebar's hikari rail composition: the bespoke
 * host of the sidebar-rail kit (useSidebarRail + HkSidebarRailToggle +
 * the hk-sidebar-rail-* geometry from the granular stylesheet).
 *
 * What is pinned here, per the kit's contracts:
 *   - the host/panel/toggle DOM shape the hikari stylesheet keys on
 *     (aside.hk-sidebar-rail-host > .hk-sidebar-rail-panel, the toggle
 *     riding the panel with aria-expanded);
 *   - the collapse toggle: click flips [data-rail], both inline widths and
 *     the root --app-sidebar-live-w notch (the wallpaper-band channel);
 *   - the peek machine on fake timers: 400ms dwell opens the overlay,
 *     the LAYOUT width stays at rail width the whole time (the content
 *     area can never shift), 150ms grace closes after leave, re-entry
 *     inside the grace cancels the close, Escape closes (and is consumed),
 *     the toggle during a peek PINS expanded;
 *   - the delegated onNavigate contract: a click inside the panel (nav
 *     link or footer row) dismisses an open peek;
 *   - rail-density dress: icon-only nav tiles carry their label as the
 *     data-hint + accessible name, the status dot and the account row
 *     gain their hints — and nothing of this exists while expanded;
 *   - the phone-layout drawer variant mounts NONE of the rail chrome;
 *   - session-only state: collapsing writes nothing to localStorage and
 *     unmount clears the live-width notch.
 *
 * The api module is mocked (a per-method async stub; the gateway config
 * call answers a disabled config); the pinia stores are real; the router
 * is a memory router carrying the sidebar's seven routes.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

const mocks = vi.hoisted(() => ({
  /** One stable async stub per api method name (default: resolves null). */
  api: new Proxy(
    {
      gatewayGetConfig: vi.fn(async () => ({ root: "https://wowsp.langyo.xyz/gateway/", enabled: false })),
    } as Record<string, ReturnType<typeof vi.fn>>,
    {
      get: (target, name: string) =>
        (target[name] ??= vi.fn(async () => null)),
    },
  ),
}));

vi.mock("@/api", () => ({
  api: mocks.api,
  GATEWAY_OFFICIAL_ROOT: "https://wowsp.langyo.xyz/gateway/",
  GATEWAY_ROUTE_RE: /^r:[a-z]{2,5}:[0-9]+$/,
}));

import { initLocaleMessages, t } from "@/i18n";
import Sidebar from "./Sidebar";

enableAutoUnmount(afterEach);

const EXPANDED_WIDTH = "var(--app-sidebar-w, 240px)";
const RAIL_WIDTH = "56px";

/** The sidebar's seven destinations — the memory router only needs the
 *  paths for RouterLink to resolve and navigate. */
const ROUTES = ["/", "/lookup", "/ships", "/live", "/replay", "/tactics", "/resources"].map(
  (path) => ({ path, component: { render: () => null } }),
);

async function mountSidebar(variant?: "sidebar" | "drawer"): Promise<{
  wrapper: VueWrapper;
  router: Router;
}> {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: ROUTES });
  router.push("/");
  await router.isReady();
  const wrapper = mount(Sidebar, {
    props: variant ? { variant } : {},
    global: { plugins: [pinia, router] },
    // Attached to the document (not a detached fragment) so bubbled events
    // genuinely reach document-level listeners — the Escape tests assert
    // consumption via stopPropagation, which only proves itself when the
    // propagation chain is real.
    attachTo: document.body,
  });
  await flushPromises();
  return { wrapper, router };
}

function hostOf(wrapper: VueWrapper): HTMLElement {
  const el = wrapper.find("aside.sidebar").element as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

function panelOf(wrapper: VueWrapper): HTMLElement {
  const el = hostOf(wrapper).querySelector<HTMLElement>(".sidebar__panel.hk-sidebar-rail-panel");
  expect(el, "rail panel should exist inside the host").toBeTruthy();
  return el!;
}

function toggleButton(wrapper: VueWrapper): HTMLButtonElement {
  const el = hostOf(wrapper).querySelector<HTMLButtonElement>(
    ".hk-sidebar-rail-toggle button[aria-expanded]",
  );
  expect(el, "rail toggle button should exist").toBeTruthy();
  return el!;
}

async function collapseViaToggle(wrapper: VueWrapper): Promise<void> {
  toggleButton(wrapper).click();
  await flushPromises();
}

function fire(host: HTMLElement, type: string): void {
  host.dispatchEvent(new Event(type));
}

/** Advance fake timers PAST a threshold and let Vue render the state the
 *  expiry flipped (refs move synchronously; the DOM paints on a tick). */
async function dwell(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await flushPromises();
}

function liveWidth(): string {
  return document.documentElement.style.getPropertyValue("--app-sidebar-live-w");
}

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  document.documentElement.style.removeProperty("--app-sidebar-live-w");
});

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty("--app-sidebar-live-w");
  vi.useRealTimers();
});

describe("Sidebar desktop rail composition", () => {
  it("mounts the hikari host/panel/toggle shape expanded, with no rail density", async () => {
    const { wrapper } = await mountSidebar();
    const host = hostOf(wrapper);
    expect(host.classList.contains("hk-sidebar-rail-host")).toBe(true);
    expect(host.hasAttribute("data-rail")).toBe(false);
    expect(host.hasAttribute("data-peeking")).toBe(false);
    // The host's inline width IS the layout footprint; the panel's inline
    // width is the slide lever — both full-width while expanded.
    expect(host.style.width).toBe(EXPANDED_WIDTH);
    expect(panelOf(wrapper).style.width).toBe(EXPANDED_WIDTH);
    const toggle = toggleButton(wrapper);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // The toggle rides INSIDE the panel (the hikari stylesheet reveals it
    // via .hk-sidebar-rail-host:hover/:focus-within on that edge).
    expect(panelOf(wrapper).contains(toggle)).toBe(true);
    expect(toggle.getAttribute("aria-label")).toBe("Collapse sidebar");
    // Expanded tiles are plain links: no icon-only dress, no hints.
    const firstLink = host.querySelector<HTMLAnchorElement>(".sidebar__link");
    expect(firstLink?.hasAttribute("data-hint")).toBe(false);
    expect(firstLink?.hasAttribute("aria-label")).toBe(false);
    expect(liveWidth()).toBe("");
  });

  it("collapses to the icon rail via the toggle and pins the width contract", async () => {
    const { wrapper } = await mountSidebar();
    await collapseViaToggle(wrapper);
    const host = hostOf(wrapper);
    expect(host.hasAttribute("data-rail")).toBe(true);
    expect(host.style.width).toBe(RAIL_WIDTH);
    expect(panelOf(wrapper).style.width).toBe(RAIL_WIDTH);
    expect(toggleButton(wrapper).getAttribute("aria-expanded")).toBe("false");
    expect(toggleButton(wrapper).getAttribute("aria-label")).toBe("Expand sidebar");
    // The wallpaper-band channel follows the rail footprint.
    expect(liveWidth()).toBe(RAIL_WIDTH);
    // Icon-only dress: the label moves to the hint + accessible name.
    const firstLink = host.querySelector<HTMLAnchorElement>(".sidebar__link");
    expect(firstLink?.getAttribute("data-hint")).toBe(t("nav.dashboard"));
    expect(firstLink?.getAttribute("data-hint-pos")).toBe("right");
    expect(firstLink?.getAttribute("aria-label")).toBe(t("nav.dashboard"));
    // The account row degrades to its avatar; the name rides the row.
    const accountBtn = host.querySelector<HTMLButtonElement>(
      ".sidebar__footer-btn[data-hint-pos='right']",
    );
    expect(accountBtn?.getAttribute("data-hint")).toBe(t("account.notBound"));
    // Expanding again restores everything.
    await collapseViaToggle(wrapper);
    expect(host.hasAttribute("data-rail")).toBe(false);
    expect(host.style.width).toBe(EXPANDED_WIDTH);
    expect(liveWidth()).toBe("");
  });

  it("opens the peek overlay after the 400ms dwell while the layout width never moves", async () => {
    vi.useFakeTimers();
    const { wrapper } = await mountSidebar();
    await collapseViaToggle(wrapper);
    const host = hostOf(wrapper);
    fire(host, "pointerenter");
    // Before the dwell expires: nothing changes (a transit does not peek).
    await dwell(399);
    expect(host.hasAttribute("data-peeking")).toBe(false);
    expect(panelOf(wrapper).style.width).toBe(RAIL_WIDTH);
    await dwell(1);
    // Peek open: the OVERLAY panel widens, the LAYOUT footprint does not.
    expect(host.hasAttribute("data-peeking")).toBe(true);
    expect(panelOf(wrapper).style.width).toBe(EXPANDED_WIDTH);
    expect(host.style.width).toBe(RAIL_WIDTH);
    // Rail density lifts during the peek (the full sidebar renders).
    expect(host.hasAttribute("data-rail")).toBe(false);
    // Leaving starts the grace; the peek survives until it expires.
    fire(host, "pointerleave");
    await dwell(149);
    expect(host.hasAttribute("data-peeking")).toBe(true);
    await dwell(1);
    expect(host.hasAttribute("data-peeking")).toBe(false);
    expect(panelOf(wrapper).style.width).toBe(RAIL_WIDTH);
    expect(host.style.width).toBe(RAIL_WIDTH);
    // ...and the density dress returns with the rail.
    expect(host.hasAttribute("data-rail")).toBe(true);
  });

  it("re-entering inside the grace window cancels the pending close", async () => {
    vi.useFakeTimers();
    const { wrapper } = await mountSidebar();
    await collapseViaToggle(wrapper);
    const host = hostOf(wrapper);
    fire(host, "pointerenter");
    await dwell(400);
    expect(host.hasAttribute("data-peeking")).toBe(true);
    fire(host, "pointerleave");
    await dwell(100);
    fire(host, "pointerenter");
    await dwell(1000);
    expect(host.hasAttribute("data-peeking")).toBe(true);
  });

  it("closes the peek on Escape and consumes the key", async () => {
    vi.useFakeTimers();
    const { wrapper } = await mountSidebar();
    await collapseViaToggle(wrapper);
    const host = hostOf(wrapper);
    fire(host, "pointerenter");
    await dwell(400);
    expect(host.hasAttribute("data-peeking")).toBe(true);
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(host.hasAttribute("data-peeking")).toBe(false);
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outer);
    // While NOT peeking the same Escape is NOT consumed — outer layers
    // (the settings modal's own Escape handling) keep their key.
    const outer2 = vi.fn();
    document.addEventListener("keydown", outer2);
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(host.hasAttribute("data-peeking")).toBe(false);
    expect(outer2).toHaveBeenCalled();
    document.removeEventListener("keydown", outer2);
  });

  it("pins the sidebar expanded when the toggle is clicked during a peek", async () => {
    vi.useFakeTimers();
    const { wrapper } = await mountSidebar();
    await collapseViaToggle(wrapper);
    const host = hostOf(wrapper);
    fire(host, "pointerenter");
    await dwell(400);
    expect(host.hasAttribute("data-peeking")).toBe(true);
    toggleButton(wrapper).click();
    await flushPromises();
    expect(host.hasAttribute("data-peeking")).toBe(false);
    expect(host.hasAttribute("data-rail")).toBe(false);
    expect(host.style.width).toBe(EXPANDED_WIDTH);
    expect(liveWidth()).toBe("");
  });

  it("dismisses an open peek on a navigation click inside the panel", async () => {
    vi.useFakeTimers();
    const { wrapper, router } = await mountSidebar();
    await collapseViaToggle(wrapper);
    const host = hostOf(wrapper);
    fire(host, "pointerenter");
    await dwell(400);
    expect(host.hasAttribute("data-peeking")).toBe(true);
    // A nav-row click (the shell kit's onNavigate contract, delegated to
    // the whole panel) lands the route AND closes the peek.
    host.querySelector<HTMLAnchorElement>(".sidebar__link[href='/lookup']")!.click();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/lookup");
    expect(host.hasAttribute("data-peeking")).toBe(false);
    expect(host.hasAttribute("data-rail")).toBe(true);
  });

  it("keeps the state session-only: nothing is persisted, unmount clears the notch", async () => {
    const { wrapper } = await mountSidebar();
    const storedBefore = JSON.stringify({ ...localStorage });
    await collapseViaToggle(wrapper);
    expect(JSON.stringify({ ...localStorage })).toBe(storedBefore);
    expect(liveWidth()).toBe(RAIL_WIDTH);
    wrapper.unmount();
    expect(liveWidth()).toBe("");
  });

  it("carries the status dot's hint through the rail density", async () => {
    const { wrapper } = await mountSidebar();
    await collapseViaToggle(wrapper);
    const host = hostOf(wrapper);
    // Offline default store: the degraded card's dot names its state.
    const dot = host.querySelector<HTMLElement>(".sidebar__status-dot");
    expect(dot?.getAttribute("data-hint")).toBe(t("common.game.offline"));
  });
});

describe("Sidebar drawer variant (phone layout) stays rail-free", () => {
  it("mounts the classic self-contained root without any rail chrome", async () => {
    const { wrapper } = await mountSidebar("drawer");
    const host = hostOf(wrapper);
    expect(host.classList.contains("sidebar--drawer")).toBe(true);
    expect(host.classList.contains("hk-sidebar-rail-host")).toBe(false);
    expect(host.querySelector(".hk-sidebar-rail-panel")).toBeNull();
    expect(host.querySelector(".hk-sidebar-rail-toggle")).toBeNull();
    // No inline footprint width, no density attrs, no hints on tiles.
    expect(host.style.width).toBe("");
    expect(host.hasAttribute("data-rail")).toBe(false);
    expect(host.hasAttribute("data-peeking")).toBe(false);
    expect(host.querySelector(".sidebar__link")?.hasAttribute("data-hint")).toBe(false);
    expect(liveWidth()).toBe("");
  });
});