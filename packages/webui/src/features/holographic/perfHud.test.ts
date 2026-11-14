/**
 * perfHud — the replay map's performance diagnostics overlay. Pins the
 * things that bit the real-build measurement sessions: the stable DOM
 * hooks (.holo-perf-hud + data-holo-perf per section) and the report
 * text that scripts and screenshots rely on. The presentation is
 * hikari's HkDebugFloat window (teleported to <body>) in its headerless
 * chrome: no title bar, the body drags, and the close button plus the
 * section toggle chips live in the hover-revealed overlay. The hover
 * pins target the float's own data-hovered state machine and its inline
 * custom properties. (Activation moved to stores/perfHud — the
 * session-only toggle; the URL parameters and the stored flag are gone.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { nextTick } from "vue";

import { fakeAs } from "@/test-utils/fakes";

import { createPerfHud, PERF_HUD_HOVER_OPACITY } from "./perfHud";

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

afterEach(() => {
  vi.restoreAllMocks();
  // The float persists open/drag/hidden-section state under its
  // persistKey — clear this suite's record so tests stay hermetic.
  localStorage.removeItem("hk-debug-float:holo-perf");
  document.querySelectorAll(".holo-perf-hud, .hk-debug-float").forEach((el) => el.remove());
});

describe("createPerfHud", () => {
  it("stays dark when not requested", () => {
    expect(createPerfHud(false)).toBeNull();
    expect(document.querySelector(".holo-perf-hud")).toBeNull();
  });

  it("mounts the stable hooks and reports draws/tris/buffer/ratio", () => {
    const hud = createPerfHud(true);
    expect(hud).not.toBeNull();
    const draws = document.querySelector(
      ".holo-perf-hud[data-holo-perf='draws']",
    ) as HTMLElement | null;
    expect(draws).not.toBeNull();
    // Two rendered frames > REPORT_MS apart make the report text land.
    hud!.tickRendered(fakeRenderer(), 1000);
    hud!.tickRendered(fakeRenderer(), 2000);
    const text = draws!.textContent ?? "";
    expect(text).toContain("draws 12");
    expect(text).toContain("tris 0.34M");
    expect(text).toContain("buffer 100x50");
    expect(text).toContain("@ 2.00x");
    hud!.dispose();
    expect(document.querySelector(".holo-perf-hud")).toBeNull();
  });

  it("keeps the three sections apart: timing / draws / gpu", () => {
    const hud = createPerfHud(true);
    hud!.tickRendered(fakeRenderer(), 1000);
    hud!.tickRendered(fakeRenderer(), 2000);
    const keys = [...document.querySelectorAll(".holo-perf-hud")].map(
      (el) => (el as HTMLElement).dataset.holoPerf,
    );
    expect(keys).toEqual(["timing", "draws", "gpu"]);
    // Each line is its own pre-formatted node — no fused 3-line blob.
    const timing = document.querySelector<HTMLElement>(".holo-perf-hud[data-holo-perf='timing']")!;
    expect(timing.textContent).toContain("idle-ticks");
    expect(timing.textContent).not.toContain("draws");
    expect(timing.style.whiteSpace).toBe("pre");
    hud!.dispose();
  });

  it("counts idle ticks within one report window", () => {
    // The spy sits after createPerfHud on purpose: mounting the float's
    // Vue app runs Vue's dev-mode component perf instrumentation
    // (startMeasure → devtoolsPerfStart feeding perf.now()) on every
    // mounted component, and those calls would drain the Once queue.
    // Only the tickIdle calls below see the mock.
    const hud = createPerfHud(true);
    // Report windows: t=600 (fires), t=700 (suppressed), t=1200 (fires
    // with the two ticks accumulated since the last report).
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(600)
      .mockReturnValueOnce(700)
      .mockReturnValueOnce(1200);
    hud!.tickIdle();
    hud!.tickIdle();
    hud!.tickIdle();
    const el = document.querySelector<HTMLElement>(".holo-perf-hud[data-holo-perf='timing']")!;
    expect(el.textContent).toContain("idle-ticks 2");
  });

  it("dispose is safe twice and post-dispose ticks are no-ops", () => {
    const hud = createPerfHud(true);
    hud!.dispose();
    expect(() => hud!.dispose()).not.toThrow();
    expect(() => hud!.tickIdle()).not.toThrow();
    expect(() => hud!.tickRendered(fakeRenderer(), 5000)).not.toThrow();
    expect(document.querySelector(".holo-perf-hud")).toBeNull();
  });
});

describe("hover yield (HkDebugFloat)", () => {
  /** The teleported window root — HkDebugFloat renders INTO document.body,
   *  never into any panel or mount-container DOM. */
  function floatRoot(): HTMLElement {
    return document.querySelector<HTMLElement>(".hk-debug-float")!;
  }

  it("mounts the headerless PERF seat: top-left corner, offset 48, no title bar", () => {
    const hud = createPerfHud(true);
    const win = floatRoot();
    expect(win.getAttribute("data-corner")).toBe("top-left");
    expect(win.style.getPropertyValue("--hk-debug-float-offset")).toBe("48px");
    // Headerless chrome: no "PERF ×" strip — the title survives only as
    // the accessible name, and the body itself is the drag handle.
    expect(win.getAttribute("data-chrome")).toBe("none");
    expect(win.getAttribute("aria-label")).toBe("PERF");
    expect(win.querySelector("[data-el='header']")).toBeNull();
    expect(win.querySelector("[data-el='title']")).toBeNull();
    // The close button and the section chips live in the hover overlay.
    expect(win.querySelector("[data-el='overlay'] .hk-debug-float-close")).toBeTruthy();
    expect(win.querySelectorAll(".hk-debug-float-section").length).toBe(3);
    hud!.dispose();
  });

  it("sizes the seat to the content instead of clipping the mono lines", () => {
    const hud = createPerfHud(true);
    const win = floatRoot();
    // width="auto": the seat follows its longest line (the GPU adapter
    // string) instead of a fixed px width that clipped the text.
    expect(win.getAttribute("data-auto-width")).toBe("");
    expect(win.style.width).toBe("");
    // Each section renders through its own wrapper inside the body.
    const stats = document.querySelector<HTMLElement>(".holo-perf-hud[data-holo-perf='draws']")!;
    expect(stats.parentElement!.getAttribute("data-el")).toBe("section");
    expect(stats.parentElement!.getAttribute("data-key")).toBe("draws");
    hud!.dispose();
  });

  it("flows the hover dim through as the inline custom property", () => {
    const hud = createPerfHud(true);
    expect(
      floatRoot().style.getPropertyValue("--hk-debug-float-hover-opacity"),
    ).toBe(String(PERF_HUD_HOVER_OPACITY));
    hud!.dispose();
  });

  it("flips the hovered state on pointerenter and restores on pointerleave", async () => {
    const hud = createPerfHud(true);
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
    hud!.dispose();
  });

  it("dispose removes the teleported window from the document", () => {
    const hud = createPerfHud(true);
    expect(floatRoot()).not.toBeNull();
    hud!.dispose();
    expect(document.querySelector(".hk-debug-float")).toBeNull();
  });
});

describe("section toggles (HkDebugFloat chips)", () => {
  it("toggling a chip hides that section and persists the thinned set", async () => {
    const hud = createPerfHud(true);
    const chip = document.querySelector<HTMLButtonElement>(
      ".hk-debug-float-section[data-key='gpu']",
    )!;
    expect(chip).toBeTruthy();
    chip.click();
    await nextTick();
    expect(document.querySelector(".holo-perf-hud[data-holo-perf='gpu']")).toBeNull();
    expect(document.querySelector(".holo-perf-hud[data-holo-perf='timing']")).not.toBeNull();
    const record = JSON.parse(localStorage.getItem("hk-debug-float:holo-perf")!);
    expect(record.hidden).toEqual(["gpu"]);
    hud!.dispose();
  });

  it("a fresh mount restores the thinned set (and the HUD still opens)", async () => {
    const first = createPerfHud(true)!;
    document.querySelector<HTMLButtonElement>(".hk-debug-float-section[data-key='gpu']")!.click();
    await nextTick();
    first.dispose();
    // The open half of the persisted record is deliberately ignored
    // (session-only open), but the hidden-section half IS honored.
    const second = createPerfHud(true)!;
    expect(document.querySelector(".hk-debug-float")).not.toBeNull();
    expect(document.querySelector(".holo-perf-hud[data-holo-perf='gpu']")).toBeNull();
    expect(document.querySelector(".holo-perf-hud[data-holo-perf='draws']")).not.toBeNull();
    second.dispose();
  });

  it("toggling back re-shows the section with its current text", async () => {
    const hud = createPerfHud(true)!;
    hud.tickRendered(fakeRenderer(), 1000);
    hud.tickRendered(fakeRenderer(), 2000);
    const chip = document.querySelector<HTMLButtonElement>(".hk-debug-float-section[data-key='gpu']")!;
    chip.click();
    await nextTick();
    (document.querySelector<HTMLButtonElement>(".hk-debug-float-section[data-key='gpu']")!).click();
    await nextTick();
    const gpu = document.querySelector<HTMLElement>(".holo-perf-hud[data-holo-perf='gpu']")!;
    expect(gpu.textContent).not.toBe("");
    hud.dispose();
  });
});

describe("session lifecycle (HkDebugFloat)", () => {
  it("a closed float stays hidden for the session but a fresh mount always reopens", async () => {
    const hud = createPerfHud(true);
    const close = document.querySelector<HTMLElement>(
      ".hk-debug-float .hk-debug-float-close",
    )!;
    close.click();
    await nextTick();
    expect(document.querySelector(".hk-debug-float")).toBeNull();
    hud!.dispose();
    // The persisted record must never pin the HUD shut: open state is
    // session-only (controlled open binding), so the next mount opens
    // even though the close wrote { open: false } under the persistKey
    // (the v0.6.9 wowsp.perf stuck-flag lesson).
    const reopened = createPerfHud(true);
    expect(document.querySelector(".hk-debug-float")).not.toBeNull();
    reopened!.dispose();
  });
});
