/** The overflow-gated hint path (see globalTooltip's data-hint-overflow):
 *  the gate must be evaluated per hover, and — the regression this pins —
 *  retargeting between two gated anchors mid-cycle must carry EACH
 *  anchor's own text into its popup (hideNow sits between the new
 *  anchorFor and the new fire, so the text channel must survive it).
 *  happy-dom has no layout engine, so clipping and anchor rects are
 *  stubbed on the elements. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { installGlobalTooltip } from "./globalTooltip";

/** The hook installs ONE popup on document.body for the module's life —
 *  test anchors live in a per-test host so the popup itself survives. */
let host: HTMLElement;

function clipped(el: HTMLElement, scroll: number, client: number): void {
  Object.defineProperty(el, "scrollWidth", { value: scroll });
  Object.defineProperty(el, "clientWidth", { value: client });
}

/** Zero rects would trip fire()'s vanished-anchor guard — give the
 *  anchor a real-shaped box for the placement math to chew on. */
function withRect(el: HTMLElement): void {
  el.getBoundingClientRect = () =>
    ({
      width: 120, height: 24, left: 10, top: 10, right: 130, bottom: 34,
      x: 10, y: 10, toJSON: () => ({}),
    }) as DOMRect;
}

function railItem(label: string, text: string): HTMLElement {
  const btn = document.createElement("button");
  btn.setAttribute("data-hint-overflow", text);
  btn.setAttribute("data-hint-pos", "right");
  const span = document.createElement("span");
  span.textContent = label;
  btn.appendChild(span);
  host.appendChild(btn);
  withRect(btn);
  return btn;
}

function popup(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".hk-tooltip-popup");
}

function shown(): boolean {
  return popup()?.classList.contains("hk-tooltip-visible") ?? false;
}

describe("globalTooltip overflow hints", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installGlobalTooltip();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.useRealTimers();
  });

  it("shows a clipped rail label's full text", () => {
    const btn = railItem("In-game over…", "In-game overlay calibration");
    clipped(btn.firstElementChild as HTMLElement, 200, 80);
    btn.dispatchEvent(new Event("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(shown()).toBe(true);
    expect(popup()?.textContent).toBe("In-game overlay calibration");
  });

  it("stays hidden while every label fits", () => {
    const btn = railItem("Short", "Short");
    clipped(btn.firstElementChild as HTMLElement, 80, 80);
    btn.dispatchEvent(new Event("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(shown()).toBe(false);
  });

  it("carries each anchor's own text through an unshown retarget", () => {
    const first = railItem("First label", "First full label text");
    clipped(first.firstElementChild as HTMLElement, 200, 80);
    const second = railItem("Second label", "Second full label text");
    clipped(second.firstElementChild as HTMLElement, 200, 80);

    first.dispatchEvent(new Event("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(popup()?.textContent).toBe("First full label text");

    // Sweep straight onto the neighbor: hideNow runs between the new
    // anchorFor and the new fire — the second hint must still pop with
    // the SECOND label's text, not collapse to nothing.
    second.dispatchEvent(new Event("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(popup()?.textContent).toBe("Second full label text");
  });

  it("re-gates on every hover — an unclipped neighbor hides the popup", () => {
    const first = railItem("First label", "First full label text");
    clipped(first.firstElementChild as HTMLElement, 200, 80);
    const fitting = railItem("Fits", "Fits");
    clipped(fitting.firstElementChild as HTMLElement, 80, 80);

    first.dispatchEvent(new Event("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(popup()?.textContent).toBe("First full label text");

    fitting.dispatchEvent(new Event("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(shown()).toBe(false);
  });

  it("keeps a pending overflow hint through a focus miss", () => {
    const btn = railItem("First label", "First full label text");
    clipped(btn.firstElementChild as HTMLElement, 200, 80);

    btn.dispatchEvent(new Event("pointerover", { bubbles: true }));
    // Keyboard focus landing on a non-anchor mid-delay is a miss — it
    // must not wipe the pending hint's text before fire() reads it.
    host.dispatchEvent(new Event("focusin", { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(shown()).toBe(true);
    expect(popup()?.textContent).toBe("First full label text");
  });
});
