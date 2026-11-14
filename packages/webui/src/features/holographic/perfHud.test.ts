/**
 * perfHud — the replay map's performance diagnostics overlay. Pins the
 * things that bit the real-build measurement sessions: the stable DOM
 * hook (.holo-perf-hud class) and the report text that scripts and
 * screenshots rely on. The presentation is hikari's HkDebugFloat window
 * (teleported to <body>): the hover pins target the float's own
 * data-hovered state machine and its inline custom properties.
 * (Activation moved to stores/perfHud — the session-only toggle; the URL
 * parameters and the stored flag are gone.)
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
  // The float persists open/drag state under its persistKey — clear this
  // suite's record so tests stay hermetic.
  localStorage.removeItem("hk-debug-float:holo-perf");
  document.querySelectorAll(".holo-perf-hud, .hk-debug-float").forEach((el) => el.remove());
});

describe("createPerfHud", () => {
  it("stays dark when not requested", () => {
    expect(createPerfHud(false)).toBeNull();
    expect(document.querySelector(".holo-perf-hud")).toBeNull();
  });

  it("mounts with the stable class and reports draws/tris/buffer/ratio", () => {
    const hud = createPerfHud(true);
    expect(hud).not.toBeNull();
    const el = document.querySelector(".holo-perf-hud") as HTMLElement | null;
    expect(el).not.toBeNull();
    // Two rendered frames > REPORT_MS apart make the report text land.
    hud!.tickRendered(fakeRenderer(), 1000);
    hud!.tickRendered(fakeRenderer(), 2000);
    const text = el!.textContent ?? "";
    expect(text).toContain("draws 12");
    expect(text).toContain("tris 0.34M");
    expect(text).toContain("buffer 100x50");
    expect(text).toContain("@ 2.00x");
    hud!.dispose();
    expect(document.querySelector(".holo-perf-hud")).toBeNull();
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
    const el = document.querySelector(".holo-perf-hud") as HTMLElement;
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

  it("mounts the float with the PERF seat: top-left corner, offset 48, PERF title", () => {
    const hud = createPerfHud(true);
    const win = floatRoot();
    expect(win.getAttribute("data-corner")).toBe("top-left");
    expect(win.style.getPropertyValue("--hk-debug-float-offset")).toBe("48px");
    expect(win.querySelector("[data-el='title']")!.textContent).toBe("PERF");
    // The stats hook lives inside the float's body and keeps the 3-line
    // mono format via white-space: pre.
    const stats = win.querySelector(".holo-perf-hud") as HTMLElement;
    expect(stats.parentElement!.getAttribute("data-el")).toBe("body");
    expect(stats.style.whiteSpace).toBe("pre");
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
