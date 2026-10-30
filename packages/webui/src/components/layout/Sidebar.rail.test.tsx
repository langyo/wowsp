/**
 * Tests for the desktop Sidebar's hikari rail composition: the bespoke
 * host of the sidebar-rail kit (useSidebarRail + HkSidebarRailToggle +
 * the hk-sidebar-rail-* geometry from the granular stylesheet).
 *
 * What is pinned here, per the kit's contracts:
 *   - the host/panel/toggle DOM shape the hikari stylesheet keys on
 *     (aside.hk-sidebar-rail-host > .hk-sidebar-rail-panel, the nav+footer
 *     body inside the .hk-sidebar-rail-clip content clip, the toggle a
 *     DIRECT child of the panel with aria-expanded so its straddling half
 *     is never clipped);
 *   - the collapse toggle: click flips [data-rail], both inline widths and
 *     the root --app-sidebar-live-w notch (the wallpaper-band channel);
 *   - the peek machine on fake timers: 400ms dwell opens the overlay,
 *     the LAYOUT width stays at rail width the whole time (the content
 *     area can never shift), 150ms grace closes after leave, re-entry
 *     inside the grace cancels the close, Escape closes (and is consumed),
 *     the toggle during a peek PINS expanded;
 *   - the delegated onNavigate contract: a click inside the panel (nav
 *     link or footer row) dismisses an open peek;
 *   - hover suppression (the "no twitch" contract): a pointer parked on
 *     the toggle arms no peek — evaluated on ENTER and on MOVE, purely
 *     geometrically — and moving off the circle re-arms the normal dwell;
 *   - the leave hardening: a pointerleave whose relatedTarget is still
 *     inside the host is DOM churn, not a leave;
 *   - the pin window: a rail -> expanded flip wears data-pinning (the panel
 *     snaps, only the host's width animates) and the host's OWN width
 *     transitionend clears it — a child transition, a foreign property or a
 *     collapse never does;
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

/** A pointerenter/pointermove carrying viewport coordinates: happy-dom does
 *  not populate clientX/clientY from the init dict, and the suppression
 *  wiring is purely GEOMETRIC (the toggle is opacity:0 / pointer-events:none
 *  until the region is engaged, so event.target cannot report it). */
function pointerAt(type: "pointerenter" | "pointermove", x: number, y: number): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true });
  Object.defineProperty(e, "clientX", { value: x });
  Object.defineProperty(e, "clientY", { value: y });
  return e;
}

/** happy-dom has no TransitionEvent; the host handler filters on
 *  `propertyName` (and on target === currentTarget), so a decorated plain
 *  Event is enough. */
function widthTransitionEnd(bubbles = false): Event {
  const e = new Event("transitionend", { bubbles });
  Object.defineProperty(e, "propertyName", { value: "width" });
  return e;
}

/** The toggle's positioning wrapper — the box the geometric hit-test reads. */
function toggleWrapper(wrapper: VueWrapper): HTMLElement {
  const el = hostOf(wrapper).querySelector<HTMLElement>(".hk-sidebar-rail-toggle");
  expect(el, "rail toggle wrapper should exist").toBeTruthy();
  return el!;
}

/** happy-dom lays nothing out: pin the toggle's box at the coordinates a
 *  real 24px circle would occupy, so suppression can be exercised. */
function stubToggleRect(wrapper: VueWrapper, left: number, top: number, size = 24): void {
  toggleWrapper(wrapper).getBoundingClientRect = () =>
    ({
      left,
      top,
      right: left + size,
      bottom: top + size,
      width: size,
      height: size,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
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
    // No rail -> expanded window is open on a fresh mount.
    expect(host.hasAttribute("data-pinning")).toBe(false);
    // The host's inline width IS the layout footprint; the panel's inline
    // width is the slide lever — both full-width while expanded.
    expect(host.style.width).toBe(EXPANDED_WIDTH);
    expect(panelOf(wrapper).style.width).toBe(EXPANDED_WIDTH);
    // The panel's ONLY clipping box is the content clip: the nav+footer
    // body lives inside .hk-sidebar-rail-clip while the toggle is a DIRECT
    // child of the panel (outside the clip), so its straddling half — the
    // half hanging over the content — is never amputated.
    const panel = panelOf(wrapper);
    const clip = panel.children.item(0) as HTMLElement;
    expect(clip.classList.contains("hk-sidebar-rail-clip")).toBe(true);
    expect(clip.querySelector(".sidebar__nav")).toBeTruthy();
    expect(clip.querySelector(".sidebar__footer")).toBeTruthy();
    expect(clip.querySelector(".hk-sidebar-rail-toggle")).toBeNull();
    expect(toggleWrapper(wrapper).parentElement).toBe(panel);
    const toggle = toggleButton(wrapper);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // The toggle rides INSIDE the panel (the hikari stylesheet reveals it
    // via .hk-sidebar-rail-host:hover/:focus-within on that edge).
    expect(panel.contains(toggle)).toBe(true);
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
    // Pinning the peek expanded is a rail -> expanded flip, so the panel
    // must snap instead of replaying its slide.
    expect(host.hasAttribute("data-pinning"), "the peek pin is a rail -> expanded flip").toBe(true);
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

describe("Sidebar desktop rail pin window (expanding never replays the slide)", () => {
  it("marks a rail -> expanded flip and clears on the host's own width transition", async () => {
    vi.useFakeTimers();
    const { wrapper } = await mountSidebar();
    const host = hostOf(wrapper);
    await collapseViaToggle(wrapper);
    // Collapsing is the opposite window: there is nothing to mask.
    expect(host.hasAttribute("data-pinning"), "collapsing never pins").toBe(false);
    await collapseViaToggle(wrapper);
    expect(host.hasAttribute("data-pinning"), "the expand window is pinned").toBe(true);
    // The panel is ALREADY at its final width: nothing slides.
    expect(panelOf(wrapper).style.width).toBe(EXPANDED_WIDTH);
    expect(host.style.width).toBe(EXPANDED_WIDTH);
    host.dispatchEvent(widthTransitionEnd());
    await flushPromises();
    expect(host.hasAttribute("data-pinning")).toBe(false);
  });

  it("ends only on the host's OWN width transition (a child's bubbles through)", async () => {
    vi.useFakeTimers();
    const { wrapper } = await mountSidebar();
    const host = hostOf(wrapper);
    await collapseViaToggle(wrapper);
    await collapseViaToggle(wrapper);
    expect(host.hasAttribute("data-pinning")).toBe(true);
    // The panel's own width transition bubbles up here too; it must not
    // end the host's window.
    panelOf(wrapper).dispatchEvent(widthTransitionEnd(true));
    await flushPromises();
    expect(host.hasAttribute("data-pinning")).toBe(true);
    // Nor does a non-width property on the host itself (the toggle's fade).
    const opacityEnd = new Event("transitionend");
    Object.defineProperty(opacityEnd, "propertyName", { value: "opacity" });
    host.dispatchEvent(opacityEnd);
    await flushPromises();
    expect(host.hasAttribute("data-pinning")).toBe(true);
  });

  it("falls back when no transition ever fires, and a collapse clears it", async () => {
    vi.useFakeTimers();
    const { wrapper } = await mountSidebar();
    const host = hostOf(wrapper);
    await collapseViaToggle(wrapper);
    await collapseViaToggle(wrapper);
    expect(host.hasAttribute("data-pinning")).toBe(true);
    await dwell(400);
    expect(host.hasAttribute("data-pinning"), "the fallback backstops a silent host").toBe(false);
    // A collapse mid-window ends it immediately (no open pin can survive).
    await collapseViaToggle(wrapper);
    await collapseViaToggle(wrapper);
    expect(host.hasAttribute("data-pinning")).toBe(true);
    await collapseViaToggle(wrapper);
    expect(host.hasAttribute("data-pinning")).toBe(false);
  });
});

describe("Sidebar desktop rail hover suppression (a pointer parked on the toggle never peeks)", () => {
  it("arms nothing while the pointer rests on the toggle and re-arms when it moves off", async () => {
    vi.useFakeTimers();
    const { wrapper } = await mountSidebar();
    const host = hostOf(wrapper);
    await collapseViaToggle(wrapper);
    stubToggleRect(wrapper, 100, 200);
    // Enter the rail OFF the circle (the dwell arms), then move ONTO it: the
    // suppression release path must kill the armed dwell before it opens the
    // drawer under the resting cursor. (An enter that lands on the circle is
    // covered by the ENTER case below.)
    host.dispatchEvent(pointerAt("pointerenter", 400, 500));
    host.dispatchEvent(pointerAt("pointermove", 110, 210));
    await dwell(400 * 4);
    expect(host.hasAttribute("data-peeking"), "parked on the toggle: no peek").toBe(false);
    expect(host.hasAttribute("data-rail")).toBe(true);
    // Moving off the circle (still on the rail) re-arms the FULL dwell.
    host.dispatchEvent(pointerAt("pointermove", 400, 500));
    await dwell(399);
    expect(host.hasAttribute("data-peeking"), "one tick before the fresh dwell").toBe(false);
    await dwell(1);
    expect(host.hasAttribute("data-peeking"), "off the toggle the peek arms normally").toBe(true);
  });

  it("evaluates suppression on ENTER: crossing the boundary onto the circle arms nothing", async () => {
    vi.useFakeTimers();
    const { wrapper } = await mountSidebar();
    const host = hostOf(wrapper);
    await collapseViaToggle(wrapper);
    stubToggleRect(wrapper, 100, 200);
    // The pointer lands ON the circle with the enter event itself — there
    // may never be a pointermove to correct a dwell armed by the enter.
    host.dispatchEvent(pointerAt("pointerenter", 110, 210));
    await dwell(400 * 4);
    expect(host.hasAttribute("data-peeking"), "enter on the toggle arms nothing").toBe(false);
    expect(host.hasAttribute("data-rail")).toBe(true);
  });

  it("still arms the dwell on an enter elsewhere on the rail", async () => {
    vi.useFakeTimers();
    const { wrapper } = await mountSidebar();
    const host = hostOf(wrapper);
    await collapseViaToggle(wrapper);
    stubToggleRect(wrapper, 100, 200);
    host.dispatchEvent(pointerAt("pointerenter", 400, 500));
    await dwell(399);
    expect(host.hasAttribute("data-peeking"), "one tick before the dwell").toBe(false);
    await dwell(1);
    expect(host.hasAttribute("data-peeking"), "off the toggle the enter arms the dwell").toBe(true);
  });

  it("ignores a pointerleave whose relatedTarget is still inside the host", async () => {
    vi.useFakeTimers();
    const { wrapper } = await mountSidebar();
    const host = hostOf(wrapper);
    await collapseViaToggle(wrapper);
    fire(host, "pointerenter");
    await dwell(400);
    expect(host.hasAttribute("data-peeking")).toBe(true);
    // The peek/width transitions rebuild the toggle subtree; the
    // synthesized leave must not start the grace close.
    const churn = new Event("pointerleave");
    Object.defineProperty(churn, "relatedTarget", { value: panelOf(wrapper) });
    host.dispatchEvent(churn);
    await dwell(150 * 4);
    expect(host.hasAttribute("data-peeking"), "DOM churn is not a leave").toBe(true);
    // A REAL leave still closes on the grace.
    fire(host, "pointerleave");
    await dwell(150);
    expect(host.hasAttribute("data-peeking")).toBe(false);
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
    expect(host.querySelector(".hk-sidebar-rail-clip")).toBeNull();
    expect(host.hasAttribute("data-pinning")).toBe(false);
    // No inline footprint width, no density attrs, no hints on tiles.
    expect(host.style.width).toBe("");
    expect(host.hasAttribute("data-rail")).toBe(false);
    expect(host.hasAttribute("data-peeking")).toBe(false);
    expect(host.querySelector(".sidebar__link")?.hasAttribute("data-hint")).toBe(false);
    expect(liveWidth()).toBe("");
  });
});