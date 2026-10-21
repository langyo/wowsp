/** The selection edge hint's sensing contract (see useSelectionEdgeHint):
 *  which vertical edges of the scroller's visible band hide the
 *  selection, re-sensed when the .is-active class hops between rows (a
 *  mutation, not a scroll), and silent for unrendered matches.
 *  happy-dom has no layout engine, so every band/row rect is stubbed on
 *  the element — getClientRects alongside getBoundingClientRect, because
 *  the rendered-check must be controllable independently of the band
 *  test (happy-dom reports one rect even for display:none elements, so
 *  the hidden-row case stubs an empty list explicitly). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, type Ref } from "vue";

import { useSelectionEdgeHint, type SelectionBeyond } from "./useSelectionEdgeHint";

const mounts: ReturnType<typeof createApp>[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  for (const app of mounts.splice(0)) app.unmount();
  for (const el of containers.splice(0)) el.remove();
});

/** Mount a probe that wires the composable onto `scroller` and captures
 *  the live state (the composable owns mount-scoped lifecycle, so the
 *  probe exists purely to host it). */
function captureState(scroller: HTMLElement, selector?: string): Ref<SelectionBeyond> {
  let state: Ref<SelectionBeyond> | null = null;
  const Probe = defineComponent({
    setup() {
      state = useSelectionEdgeHint(() => scroller, selector);
      return () => h("div");
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const app = createApp(Probe);
  mounts.push(app);
  app.mount(container);
  return state!;
}

/** Stub an element's drawn vertical band plus its rendered-ness
 *  (`rendered: false` reports the empty client-rect list a display:none
 *  element produces in a real engine). */
function stubBand(el: HTMLElement, top: number, bottom: number, rendered = true): void {
  const rect = {
    x: 0, y: top, top, bottom, left: 0, right: 100, width: 100, height: bottom - top,
  } as DOMRect;
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect);
  vi.spyOn(el, "getClientRects").mockReturnValue((rendered ? [rect] : []) as unknown as DOMRectList);
}

function flushSensing(): Promise<void> {
  // Mutation delivery is a microtask; the sensing pass is one rAF.
  return new Promise<void>((resolve) =>
    setTimeout(() => requestAnimationFrame(() => resolve()), 0),
  );
}

/** The scroller's visible band for these tests: drawn pixels 0..400. */
function stubScroller(scroller: HTMLElement): void {
  stubBand(scroller, 0, 400);
}

describe("useSelectionEdgeHint", () => {
  it("reports top when the only selection is fully above the band", () => {
    const scroller = document.createElement("div");
    const row = document.createElement("button");
    row.className = "is-active";
    scroller.appendChild(row);
    stubScroller(scroller);
    stubBand(row, -120, -60);
    expect(captureState(scroller).value).toBe("top");
  });

  it("reports bottom when the only selection is fully below the band", () => {
    const scroller = document.createElement("nav");
    const row = document.createElement("button");
    row.setAttribute("aria-current", "true");
    scroller.appendChild(row);
    stubScroller(scroller);
    stubBand(row, 500, 560);
    expect(captureState(scroller).value).toBe("bottom");
  });

  it("reports both when selections sit on both sides of the band", () => {
    const scroller = document.createElement("div");
    const above = document.createElement("div");
    above.className = "is-active";
    const below = document.createElement("div");
    below.className = "is-active";
    scroller.append(above, below);
    stubScroller(scroller);
    stubBand(above, -100, -40);
    stubBand(below, 480, 520);
    expect(captureState(scroller).value).toBe("both");
  });

  it("reports none while the selection intersects the band", () => {
    const scroller = document.createElement("div");
    const row = document.createElement("div");
    row.className = "is-active";
    scroller.appendChild(row);
    stubScroller(scroller);
    // Partially visible (straddling the bottom edge) still counts as
    // visible — the hint is only for a FULLY hidden selection.
    stubBand(row, 360, 440);
    expect(captureState(scroller).value).toBe("none");
  });

  it("reports none when nothing matches — and aria-current=\"false\" never counts", () => {
    const scroller = document.createElement("div");
    const row = document.createElement("button");
    row.setAttribute("aria-current", "false");
    scroller.appendChild(row);
    stubScroller(scroller);
    stubBand(row, 500, 560);
    expect(captureState(scroller).value).toBe("none");
  });

  it("skips a display:none selected row (unrendered matches cannot light the hint)", () => {
    const scroller = document.createElement("div");
    const row = document.createElement("div");
    row.className = "is-active";
    scroller.appendChild(row);
    stubScroller(scroller);
    // Drawn below the band BUT not rendered: the rendered-check wins.
    stubBand(row, 500, 560, false);
    expect(captureState(scroller).value).toBe("none");
  });

  it("re-senses when the .is-active class hops onto a below-band row (mutation, not scroll)", async () => {
    const scroller = document.createElement("div");
    const row = document.createElement("div");
    scroller.appendChild(row);
    stubScroller(scroller);
    stubBand(row, 500, 560);
    const state = captureState(scroller);
    expect(state.value).toBe("none");

    row.classList.add("is-active");
    await flushSensing();
    expect(state.value).toBe("bottom");
  });

  it("honors a custom selector", () => {
    const scroller = document.createElement("div");
    const inside = document.createElement("div");
    inside.className = "is-active";
    const picked = document.createElement("div");
    picked.className = "my-pick";
    scroller.append(inside, picked);
    stubScroller(scroller);
    stubBand(inside, 120, 160);
    stubBand(picked, 500, 560);
    // The custom grammar replaced the default: only .my-pick counted —
    // with the default selector this pass would read "none".
    expect(captureState(scroller, ".my-pick").value).toBe("bottom");
  });
});
