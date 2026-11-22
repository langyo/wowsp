/**
 * perfHud — the replay map's performance diagnostics overlay. Pins the
 * things that bit the real-build measurement sessions: the stable DOM
 * hooks (.holo-perf-hud + data-holo-perf per section) and the report
 * text that scripts and screenshots rely on. The presentation is
 * hikari's HkDebugFloat window (teleported to <body>) in its headerless
 * chrome: no title bar, the body drags, and NO in-window close — the HUD
 * owns its chrome (`closable: false`). The card's first row leads with the
 * pin: it freezes the window into a dimmed click-through state
 * (`interactive: false`, only the pin left addressable) and releases it
 * again. The section switch beside it is hikari's standard
 * HkPillToggleGroup (timing / draws / gpu), translated through the app
 * i18n, and the card keeps a fixed width whatever is toggled off — report
 * lines WRAP instead of clipping. Visibility persists in the float's own
 * record (hk-debug-float:holo-perf, its `hidden` field). (Activation moved
 * to stores/perfHud — the session-only toggle; the URL parameters and the
 * stored flag are gone.)
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { nextTick } from "vue";
import { useI18n as useHikariI18n } from "@celestia-island/hikari";

import { initLocaleMessages, t as i18nT } from "@/i18n";
import { fakeAs } from "@/test-utils/fakes";

import {
  createPerfHud,
  parseHiddenSections,
  PERF_HUD_HOVER_OPACITY,
  PERF_HUD_SECTIONS,
  PERF_HUD_WIDTH,
  toggleHiddenSection,
  type PerfHud,
} from "./perfHud";
import {
  resetResourceHealthSession,
  runResourceHealthChecks,
  setReplayResourceContext,
} from "./resourceHealth";

const STORAGE_KEY = "hk-debug-float:holo-perf";

beforeAll(async () => {
  await initLocaleMessages();
});

/** The HUDs a test mounted — disposed in afterEach so the document-level
 *  persistence listeners never outlive their app (a leaked listener would
 *  rewrite the NEXT test's record). */
const mounted: PerfHud[] = [];

function mountHud(): PerfHud {
  const hud = createPerfHud(true);
  expect(hud).not.toBeNull();
  mounted.push(hud!);
  return hud!;
}

function floatRoot(): HTMLElement {
  return document.querySelector<HTMLElement>(".hk-debug-float")!;
}

/** The standard pill switch's buttons, in PERF_HUD_SECTIONS order. */
function pills(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".holo-perf-hud-toggles .hk-pill-group-pill",
    ),
  ];
}

/** The pill for one section, located by its translated label (the pill
 *  group does not let the host stamp per-option data hooks). */
function pill(key: string): HTMLButtonElement {
  const label = i18nT(`replay.perf.${key}`);
  const found = pills().find((candidate) => candidate.textContent!.trim() === label);
  expect(found).toBeTruthy();
  return found!;
}

function isActive(key: string): boolean {
  return pill(key).hasAttribute("data-active");
}

async function clickToggle(key: string): Promise<void> {
  pill(key).click();
  await nextTick();
}

function metric(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.holo-perf-hud[data-holo-perf='${key}']`);
}

function persistedRecord(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY)!);
}

afterEach(() => {
  // dispose is idempotent — a test may have disposed early.
  for (const hud of mounted.splice(0)) hud.dispose();
  resetResourceHealthSession();
  vi.restoreAllMocks();
  // The float persists open/drag/hidden-section state under its
  // persistKey — clear this suite's record so tests stay hermetic.
  localStorage.removeItem(STORAGE_KEY);
  document
    .querySelectorAll(".holo-perf-hud, .holo-perf-hud-root, .hk-debug-float")
    .forEach((el) => el.remove());
});

function fakeRenderer(): THREE.WebGLRenderer {
  return fakeAs<THREE.WebGLRenderer>({
    info: fakeAs<THREE.WebGLInfo>({
      render: fakeAs<THREE.WebGLInfo["render"]>({
        calls: 12,
        triangles: 340_000,
        frame: 0,
        lines: 0,
        points: 0,
      }),
    }),
    domElement: fakeAs<HTMLCanvasElement>({ width: 100, height: 50 }),
    getPixelRatio: () => 2,
    getContext: () => fakeAs<WebGLRenderingContext>({ getExtension: () => null, getParameter: () => 0 }),
  });
}

describe("section state (pure)", () => {
  it("keeps the four sections in display order", () => {
    expect(PERF_HUD_SECTIONS.map((section) => section.key)).toEqual([
      "timing",
      "draws",
      "gpu",
      "resources",
    ]);
  });

  it("toggles one section and normalizes the stored order", () => {
    expect(toggleHiddenSection([], "gpu")).toEqual(["gpu"]);
    expect(toggleHiddenSection(["gpu"], "gpu")).toEqual([]);
    expect(toggleHiddenSection(["gpu"], "timing")).toEqual(["timing", "gpu"]);
    expect(toggleHiddenSection(["timing", "gpu"], "draws")).toEqual([
      "timing",
      "draws",
      "gpu",
    ]);
  });

  it("parses the persisted hidden list defensively", () => {
    expect(parseHiddenSections({ hidden: ["gpu"] })).toEqual(["gpu"]);
    // Unknown keys and non-strings are dropped; order is normalized.
    expect(parseHiddenSections({ hidden: ["ghost", "gpu", 7] })).toEqual(["gpu"]);
    expect(parseHiddenSections({ hidden: ["timing", "gpu"] })).toEqual(["timing", "gpu"]);
    expect(parseHiddenSections({ hidden: "gpu" })).toEqual([]);
    expect(parseHiddenSections({})).toEqual([]);
    expect(parseHiddenSections(null)).toEqual([]);
    expect(parseHiddenSections("nope")).toEqual([]);
    expect(parseHiddenSections([])).toEqual([]);
  });
});

describe("createPerfHud", () => {
  it("stays dark when not requested", () => {
    expect(createPerfHud(false)).toBeNull();
    expect(document.querySelector(".holo-perf-hud")).toBeNull();
  });

  it("mounts the stable hooks and reports draws/tris/buffer/ratio", () => {
    const hud = mountHud();
    const draws = metric("draws");
    expect(draws).not.toBeNull();
    // Two rendered frames > REPORT_MS apart make the report text land.
    hud.tickRendered(fakeRenderer(), 1000);
    hud.tickRendered(fakeRenderer(), 2000);
    const text = draws!.textContent ?? "";
    expect(text).toContain("draws 12");
    expect(text).toContain("tris 0.34M");
    expect(text).toContain("buffer 100x50");
    expect(text).toContain("@ 2.00x");
    hud.dispose();
    expect(document.querySelector(".holo-perf-hud")).toBeNull();
  });

  it("keeps the three sections apart: timing / draws / gpu", () => {
    const hud = mountHud();
    hud.tickRendered(fakeRenderer(), 1000);
    hud.tickRendered(fakeRenderer(), 2000);
    const keys = [...document.querySelectorAll(".holo-perf-hud")].map(
      (el) => (el as HTMLElement).dataset.holoPerf,
    );
    expect(keys).toEqual(["timing", "draws", "gpu", "resources"]);
    // Each line is its own pre-formatted node — no fused 3-line blob —
    // and it WRAPS instead of clipping: the pads keep the columns steady,
    // while an overlong GPU adapter string breaks onto the next line.
    const timing = metric("timing")!;
    expect(timing.textContent).toContain("idle-ticks");
    expect(timing.textContent).not.toContain("draws");
    expect(timing.style.whiteSpace).toBe("pre-wrap");
    expect(timing.style.overflowWrap).toBe("anywhere");
    hud.dispose();
  });

  it("counts idle ticks within one report window", () => {
    // The spy sits after createPerfHud on purpose: mounting the float's
    // Vue app runs Vue's dev-mode component perf instrumentation
    // (startMeasure → devtoolsPerfStart feeding perf.now()) on every
    // mounted component, and those calls would drain the Once queue.
    // Only the tickIdle calls below see the mock.
    mountHud();
    // Report windows: t=600 (fires), t=700 (suppressed), t=1200 (fires
    // with the two ticks accumulated since the last report).
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(600)
      .mockReturnValueOnce(700)
      .mockReturnValueOnce(1200);
    const hud = mounted[0];
    hud.tickIdle();
    hud.tickIdle();
    hud.tickIdle();
    expect(metric("timing")!.textContent).toContain("idle-ticks 2");
  });

  it("dispose is safe twice and post-dispose ticks are no-ops", () => {
    const hud = mountHud();
    hud.dispose();
    expect(() => hud.dispose()).not.toThrow();
    expect(() => hud.tickIdle()).not.toThrow();
    expect(() => hud.tickRendered(fakeRenderer(), 5000)).not.toThrow();
    expect(document.querySelector(".holo-perf-hud")).toBeNull();
  });
});

describe("the in-card section switch", () => {
  it("mounts the pin and the standard pill switch as the card's first row", () => {
    mountHud();
    const win = floatRoot();
    const body = win.querySelector("[data-el='body']")!;
    const root = body.firstElementChild as HTMLElement;
    expect(root.getAttribute("data-holo-perf-root")).toBe("");
    // Row 1 of the card, inside the body — not the hover overlay chips.
    const row = root.firstElementChild as HTMLElement;
    expect(row.getAttribute("data-holo-perf-toggles")).toBe("");
    // The pin leads (left-aligned, its own fixed slot) and carries the
    // hikari pointer marker; the pill group follows it.
    const pin = row.querySelector<HTMLElement>(".holo-perf-hud-pin")!;
    expect(row.firstElementChild).toBe(pin);
    expect(pin.getAttribute("data-hk-debug-float-pointer")).toBe("");
    expect(pills().map((button) => button.textContent!.trim())).toEqual(
      PERF_HUD_SECTIONS.map(({ key }) => i18nT(`replay.perf.${key}`)),
    );
    // The old section chips are gone AND the in-window close is gone:
    // the HUD owns its chrome (`closable: false`).
    expect(win.querySelectorAll(".hk-debug-float-section").length).toBe(0);
    expect(win.querySelector(".hk-debug-float-close")).toBeNull();
  });

  it("keeps the pin always semi-transparent, outside the dimmed switch", () => {
    mountHud();
    const pin = document.querySelector<HTMLButtonElement>(".holo-perf-hud-pin")!;
    expect(pin.style.opacity).toBe("0.6");
    const dimmed = document.querySelector<HTMLElement>(".holo-perf-hud-toggles")!;
    expect(dimmed.style.opacity).toBe("1");
  });

  it("freezes into a dimmed click-through lock from the pin, and releases", async () => {
    mountHud();
    const win = floatRoot();
    const pin = document.querySelector<HTMLButtonElement>(".holo-perf-hud-pin")!;
    const dimmed = document.querySelector<HTMLElement>(".holo-perf-hud-toggles")!;
    const stats = document.querySelector<HTMLElement>("[data-holo-perf-stats]")!;
    const root = document.querySelector<HTMLElement>("[data-holo-perf-root]")!;
    // Unlocked: the window takes pointers, the pin is unpressed.
    expect(win.hasAttribute("data-interactive")).toBe(false);
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    expect(dimmed.style.opacity).toBe("1");
    pin.click();
    await nextTick();
    // Frozen: hikari's window leaves the pointer layer (data-interactive
    // marks it) and everything but the pin dims.
    expect(win.getAttribute("data-interactive")).toBe("");
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    expect(root.hasAttribute("data-holo-perf-frozen")).toBe(true);
    expect(dimmed.style.opacity).toBe("0.4");
    expect(stats.style.opacity).toBe("0.4");
    // The pin still lives inside the locked window — it is the release.
    expect(pin.closest("[data-interactive]")).toBe(win);
    pin.click();
    await nextTick();
    expect(win.hasAttribute("data-interactive")).toBe(false);
    expect(dimmed.style.opacity).toBe("1");
    expect(root.hasAttribute("data-holo-perf-frozen")).toBe(false);
  });

  it("never renders a close affordance (the host owns the chrome)", () => {
    mountHud();
    expect(document.querySelector(".hk-debug-float-close")).toBeNull();
    // Hovering must not conjure one either: the headerless overlay is
    // omitted when it holds neither a close nor section chips.
    floatRoot().dispatchEvent(new PointerEvent("pointerenter"));
    expect(document.querySelector(".hk-debug-float-close")).toBeNull();
  });

  it("labels every pill through the app i18n and shows the active state", () => {
    mountHud();
    const buttons = pills();
    expect(buttons.length).toBe(4);
    PERF_HUD_SECTIONS.forEach(({ key }, index) => {
      const label = i18nT(`replay.perf.${key}`);
      const button = buttons[index]!;
      expect(button.textContent!.trim()).toBe(label);
      // Every section starts visible → the pill is active (aria + data).
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(button.hasAttribute("data-active")).toBe(true);
      expect(isActive(key)).toBe(true);
    });
    // The group itself carries an accessible name from the app i18n.
    const group = document.querySelector<HTMLElement>(
      ".holo-perf-hud-toggles [role='group']",
    )!;
    expect(group.getAttribute("aria-label")).toBe(i18nT("replay.perf.sections"));
  });

  it("keeps a fixed card width and never collapses with every section off", async () => {
    mountHud();
    const root = document.querySelector<HTMLElement>("[data-holo-perf-root]")!;
    expect(root.style.width).toBe(PERF_HUD_WIDTH);
    const stats = document.querySelector<HTMLElement>("[data-holo-perf-stats]")!;
    // A modest body area is reserved even before any line renders.
    expect(stats.style.minHeight).not.toBe("");

    for (const { key } of PERF_HUD_SECTIONS) await clickToggle(key);
    expect(document.querySelectorAll(".holo-perf-hud").length).toBe(0);
    // The row survives and the width is untouched — no reflow/collapse.
    expect(document.querySelector("[data-holo-perf-toggles]")).not.toBeNull();
    expect(document.querySelector("[data-holo-perf-stats]")).not.toBeNull();
    expect(root.style.width).toBe(PERF_HUD_WIDTH);
    for (const button of document.querySelectorAll(".hk-pill-group-pill")) {
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.hasAttribute("data-active")).toBe(false);
    }
  });

  it("toggling a button hides that line and persists the thinned set", async () => {
    mountHud();
    await clickToggle("gpu");
    expect(metric("gpu")).toBeNull();
    expect(metric("timing")).not.toBeNull();
    expect(isActive("gpu")).toBe(false);
    // The float's own record, its `hidden` field (open preserved by us).
    expect(persistedRecord()).toMatchObject({ open: true, hidden: ["gpu"] });
  });

  it("a fresh mount restores the thinned set (and the HUD still opens)", async () => {
    const first = mountHud();
    await clickToggle("gpu");
    first.dispose();
    // The open half of the persisted record is deliberately ignored
    // (session-only open), but the hidden-section half IS honored.
    mountHud();
    expect(document.querySelector(".hk-debug-float")).not.toBeNull();
    expect(metric("gpu")).toBeNull();
    expect(metric("draws")).not.toBeNull();
    expect(isActive("gpu")).toBe(false);
  });

  it("toggling back re-shows the line with its current text", async () => {
    const hud = mountHud();
    hud.tickRendered(fakeRenderer(), 1000);
    hud.tickRendered(fakeRenderer(), 2000);
    await clickToggle("gpu");
    await clickToggle("gpu");
    const gpu = metric("gpu")!;
    expect(gpu.textContent).toContain("n/a");
  });

  it("only touches the hidden half of the float's persisted record", async () => {
    // The float owns open/position — a thinned set written by us must not
    // clobber either half (the record is read-modify-write).
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: false, x: 5, y: 6 }));
    mountHud();
    await clickToggle("gpu");
    expect(persistedRecord()).toEqual({
      open: false,
      x: 5,
      y: 6,
      hidden: ["gpu"],
    });
  });

  it("re-merges the hidden set after the float's own position write (drag-drop)", async () => {
    mountHud();
    await clickToggle("gpu");
    // What HkDebugFloat persists on drop: open + position, no hidden
    // (it has no `sections` prop to derive one from).
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: true, x: 12, y: 34 }));
    floatRoot().dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(persistedRecord()).toEqual({
      open: true,
      x: 12,
      y: 34,
      hidden: ["gpu"],
    });
  });

  it("keeps the hidden set when the float rewrites its record (drag-drop)", async () => {
    mountHud();
    await clickToggle("gpu");
    // A position write from the float carries no hidden field; our
    // document listener re-merges it right after (same path the drag-drop
    // write takes now that the HUD has no close of its own).
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: true, x: 7, y: 8 }));
    floatRoot().dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(persistedRecord()).toMatchObject({ x: 7, y: 8, hidden: ["gpu"] });
  });
});

describe("hover yield (HkDebugFloat)", () => {
  it("mounts the headerless debug seat: top-left corner, offset 48, no title bar", () => {
    mountHud();
    const win = floatRoot();
    expect(win.getAttribute("data-corner")).toBe("top-left");
    expect(win.style.getPropertyValue("--hk-debug-float-offset")).toBe("48px");
    // Headerless chrome: no title strip — the label survives only as the
    // accessible name, and it is HIKARI's own localized debug label (the
    // window passes no title override), not a hardcoded English string.
    expect(win.getAttribute("data-chrome")).toBe("none");
    expect(win.getAttribute("aria-label")).toBe(
      useHikariI18n().t("hikari::debugFloat.title", "DEBUG"),
    );
    expect(win.querySelector("[data-el='header']")).toBeNull();
    expect(win.querySelector("[data-el='title']")).toBeNull();
  });

  it("keeps the window content-sized while the slot root pins the width", () => {
    mountHud();
    const win = floatRoot();
    // width="auto" still sizes the seat to its content, but the slot
    // root's fixed PERF_HUD_WIDTH is what that content is.
    expect(win.getAttribute("data-auto-width")).toBe("");
    expect(win.style.width).toBe("");
    expect(
      document.querySelector<HTMLElement>("[data-holo-perf-root]")!.style.width,
    ).toBe(PERF_HUD_WIDTH);
    // The lines hang off the reserved stats area, not a per-section
    // wrapper from the float.
    const stats = metric("draws")!;
    expect(stats.parentElement!.getAttribute("data-holo-perf-stats")).toBe("");
  });

  it("flows the hover dim through as the inline custom property", () => {
    mountHud();
    expect(
      floatRoot().style.getPropertyValue("--hk-debug-float-hover-opacity"),
    ).toBe(String(PERF_HUD_HOVER_OPACITY));
  });

  it("flips the hovered state on pointerenter and restores on pointerleave", async () => {
    mountHud();
    const win = floatRoot();
    expect(win.hasAttribute("data-hovered")).toBe(false);
    // HkDebugFloat watches the window's own pointerenter/pointerleave and
    // mirrors the hover on data-hovered (the :hover stand-in for runtime
    // tests and pen/touch engines); the sheet fades it to the custom
    // property above.
    win.dispatchEvent(new Event("pointerenter"));
    await nextTick();
    expect(win.hasAttribute("data-hovered")).toBe(true);
    win.dispatchEvent(new Event("pointerleave"));
    await nextTick();
    expect(win.hasAttribute("data-hovered")).toBe(false);
  });

  it("dispose removes the teleported window from the document", () => {
    const hud = mountHud();
    expect(floatRoot()).not.toBeNull();
    hud.dispose();
    expect(document.querySelector(".hk-debug-float")).toBeNull();
  });
});

describe("the 资源 tab", () => {
  it("renders one row per check, the fix hints, the missing list and a recheck button", async () => {
    setReplayResourceContext({
      mapId: "15_NE_north",
      replayPath: "hud-test",
      ships: [{ shipId: 1, name: "Alpha" }],
    });
    await runResourceHealthChecks({
      isTauri: false,
      cacheRoot: null,
      convertFileSrc: null,
      minimapJsonUrl: () => "/models/maps/minimaps.json",
      mapModelUrl: () => null,
      shipCandidates: () => ["/models/ships/alpha.glb"],
      fetch: async (url) => {
        if (url === "/models/maps/minimaps.json") {
          return new Response(JSON.stringify({ "15_NE_north": {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("gone", { status: 404 });
      },
    });

    mountHud();
    const tab = metric("resources");
    expect(tab).not.toBeNull();
    const rows = [
      ...tab!.querySelectorAll<HTMLElement>("[data-holo-resource]"),
    ];
    expect(rows.map((row) => row.dataset.holoResource)).toEqual([
      "cacheRoot",
      "assetProtocol",
      "pack",
      "replayMap",
      "shipModels",
      "sessionFailures",
    ]);
    // Labels go through the app i18n; details stay raw paths.
    const cacheRow = rows.find(
      (row) => row.dataset.holoResource === "cacheRoot",
    )!;
    expect(cacheRow.textContent).toContain(i18nT("replay.perf.check.cacheRoot"));
    expect(cacheRow.textContent).toContain("no Tauri shell");
    // A non-pass row carries the translated fix hint.
    expect(tab!.textContent).toContain(
      i18nT("replay.perf.checkHint.assetProtocol"),
    );
    // The environment state is reported explicitly.
    expect(
      tab!.querySelector("[data-holo-resource-env]")!.textContent,
    ).toContain(i18nT("replay.perf.env.browser"));
    // The per-ship missing list (check 5) carries the ship name.
    expect(tab!.textContent).toContain(
      `${i18nT("replay.perf.missingModels")}: alpha(Alpha)`,
    );
    // The manual re-run lives in the tab.
    expect(tab!.querySelector("[data-holo-resource-recheck]")).not.toBeNull();
  });

  it("says so when no report has been produced yet", () => {
    resetResourceHealthSession();
    mountHud();
    const tab = metric("resources")!;
    expect(tab.textContent).toContain(i18nT("replay.perf.idle"));
    expect(tab.querySelector("[data-holo-resource-recheck]")).not.toBeNull();
  });

  it("updates live when a run lands after the HUD is mounted", async () => {
    resetResourceHealthSession();
    mountHud();
    expect(
      metric("resources")!.querySelector("[data-holo-resource]"),
    ).toBeNull();

    setReplayResourceContext({
      mapId: "15_NE_north",
      replayPath: "live",
      ships: [],
    });
    await runResourceHealthChecks({
      isTauri: false,
      cacheRoot: null,
      convertFileSrc: null,
      minimapJsonUrl: () => "/models/maps/minimaps.json",
      mapModelUrl: () => null,
      shipCandidates: () => [],
      fetch: async () => new Response("gone", { status: 404 }),
    });
    await nextTick();
    expect(
      metric("resources")!.querySelector("[data-holo-resource='cacheRoot']"),
    ).not.toBeNull();
  });
});

describe("session lifecycle (HkDebugFloat)", () => {
  it("ignores a persisted close record and always reopens on mount", async () => {
    // The HUD has no close control of its own (`closable: false`), but the
    // float's record still carries an `open` half another writer could
    // flip. The controlled open binding must keep a fresh mount visible
    // regardless (the v0.6.9 wowsp.perf stuck-flag lesson).
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: false }));
    const hud = mountHud();
    await nextTick();
    expect(document.querySelector(".hk-debug-float")).not.toBeNull();
    hud.dispose();
    expect(document.querySelector(".hk-debug-float")).toBeNull();
  });
});
