/**
 * perfHud — the ?perf=1 diagnostics overlay. Pins the things that bit the
 * real-build measurement sessions:
 *   - activation (URL override beats the stored preference; the storage
 *     read is guarded),
 *   - the stable DOM hook (.holo-perf-hud class) and the report text that
 *     scripts and screenshots rely on,
 *   - the storage key itself (external support tooling writes it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPerfHud,
  PERF_HUD_HOVER_OPACITY,
  PERF_HUD_STORAGE_KEY,
  perfHudRequested,
} from "./perfHud";

function fakeRenderer() {
  return {
    info: { render: { calls: 12, triangles: 340_000 } },
    domElement: { width: 100, height: 50 },
    getPixelRatio: () => 2,
    getContext: () => ({ getExtension: () => null, getParameter: () => 0 }),
  } as unknown as import("three").WebGLRenderer;
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(PERF_HUD_STORAGE_KEY);
  document.querySelectorAll(".holo-perf-hud").forEach((el) => el.remove());
});

describe("perfHudRequested", () => {
  const none = () => null;

  it("uses the documented storage key (external tooling depends on it)", () => {
    expect(PERF_HUD_STORAGE_KEY).toBe("wowsp.perf");
  });

  it("?perf=1 forces it on", () => {
    expect(perfHudRequested("?perf=1", none)).toBe(true);
  });

  it("?perf=0 forces it off even with the stored preference", () => {
    expect(perfHudRequested("?perf=0", () => "1")).toBe(false);
  });

  it("falls back to the stored wowsp.perf preference", () => {
    expect(perfHudRequested("", () => "1")).toBe(true);
    expect(perfHudRequested("?foo=bar", () => "0")).toBe(false);
    expect(perfHudRequested("", none)).toBe(false);
  });

  it("a non-1/0 perf value falls through to the stored preference", () => {
    expect(perfHudRequested("?perf=true", none)).toBe(false);
    expect(perfHudRequested("?perf=true", () => "1")).toBe(true);
    expect(perfHudRequested("?perf=", () => "1")).toBe(true);
  });

  it("reads the real localStorage through the default probe", () => {
    localStorage.setItem(PERF_HUD_STORAGE_KEY, "1");
    expect(perfHudRequested("")).toBe(true);
    expect(perfHudRequested("?perf=0")).toBe(false);
  });

  it("guards a throwing localStorage (privacy modes)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(perfHudRequested("")).toBe(false);
  });
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
    // Report windows: t=600 (fires), t=700 (suppressed), t=1200 (fires
    // with the two ticks accumulated since the last report).
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(600)
      .mockReturnValueOnce(700)
      .mockReturnValueOnce(1200);
    const hud = createPerfHud(true);
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

describe("hover dim", () => {
  /** Pin the overlay box — happy-dom performs no layout, so the real
   *  getBoundingClientRect would report a zero-area rect at the origin. */
  function mockRect(
    el: HTMLElement,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
  }

  function move(x: number, y: number): void {
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
  }

  it("dims while the pointer rests on it and restores when it leaves", () => {
    const hud = createPerfHud(true);
    const el = document.querySelector(".holo-perf-hud") as HTMLElement;
    mockRect(el, 12, 48, 220, 64);
    move(100, 70); // inside
    expect(el.style.opacity).toBe(String(PERF_HUD_HOVER_OPACITY));
    move(400, 400); // outside
    expect(el.style.opacity).toBe("");
    hud!.dispose();
  });

  it("a zero-area box never dims (no layout yet)", () => {
    const hud = createPerfHud(true);
    const el = document.querySelector(".holo-perf-hud") as HTMLElement;
    mockRect(el, 12, 48, 0, 0);
    // Exactly the collapsed origin — the exclusive right/bottom edges must
    // keep this from counting as a hover hit.
    move(12, 48);
    expect(el.style.opacity).toBe("");
    hud!.dispose();
  });

  it("stops reacting after dispose", () => {
    const hud = createPerfHud(true);
    const el = document.querySelector(".holo-perf-hud") as HTMLElement;
    mockRect(el, 0, 0, 220, 64);
    move(50, 20); // inside — dimmed
    expect(el.style.opacity).toBe(String(PERF_HUD_HOVER_OPACITY));
    hud!.dispose();
    expect(() => move(400, 400)).not.toThrow(); // outside — listener must be gone
    // Frozen at the dim: the leave-move above must not have restored it.
    expect(el.style.opacity).toBe(String(PERF_HUD_HOVER_OPACITY));
    expect(document.querySelector(".holo-perf-hud")).toBeNull();
  });
});
