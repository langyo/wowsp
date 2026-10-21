/**
 * Probe for the selection edge hint's load-bearing wiring assumption: the
 * rail binds the composable's state as `data-selection-beyond` on the
 * HkScrollContainer COMPONENT, and Vue fallthrough attrs must land it on
 * the container's ROOT — the positioned non-scrolling box the gradient
 * paints on — even though the component `expose()`s a scroll handle
 * (expose does not disable attribute inheritance; only inheritAttrs:false
 * or a multi-root fragment would, and the installed hikari ships neither).
 * If a future hikari rebuild ever breaks that, the hint silently stops
 * painting (the attribute would land nowhere useful) — this turns it red.
 *
 * happy-dom performs no layout, so the pass's degenerate read is "none"
 * (its zero boxes report no rendered selection rows). That value alone
 * cannot distinguish "sensed through the real viewport" from "never wired",
 * so the probe also drives a scroll on the real viewport with stubbed band
 * geometry and pins the state flip — end-to-end through the installed
 * container's exposed scroller, its scroll listener, and the fallthrough
 * binding.
 */
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import type { Component } from "vue";

import SettingsShell from "./SettingsShell";

const GROUPS = [
  {
    key: "general",
    label: "General",
    sections: [
      { key: "language", label: "Language" },
      { key: "appearance", label: "Appearance" },
    ],
  },
  {
    key: "game",
    label: "Game",
    sections: [{ key: "network", label: "Network" }],
  },
];

const SLOTS = {
  language: () => <div data-test="pane-language" />,
  appearance: () => <div data-test="pane-appearance" />,
  network: () => <div data-test="pane-network" />,
};

function mountShell() {
  return mount(SettingsShell, {
    props: { groups: GROUPS, navLabel: "Settings" },
    slots: SLOTS as Record<string, () => Component>,
  });
}

describe("SettingsShell", () => {
  it("renders the grouped rail with cluster headings and the active entry", () => {
    const wrapper = mountShell();
    const headings = wrapper.findAll(".hk-settings__rail-heading");
    expect(headings.map((h) => h.text())).toEqual(["General", "Game"]);
    const items = wrapper.findAll(".hk-settings__rail-item");
    expect(items).toHaveLength(3);
    expect(items[0].classes()).toContain("is-active");
    expect(items[0].attributes("aria-current")).toBe("true");
    expect(wrapper.find('[data-test="pane-language"]').exists()).toBe(true);
  });

  it("lands the selection hint state on the rail container ROOT through fallthrough attrs", async () => {
    const wrapper = mountShell();
    // The rail HOST is the element carrying the shell BEM class AND the
    // container base class — the positioned non-scrolling box.
    const rail = wrapper.element.querySelector(".hk-settings__rail") as HTMLElement;
    expect(rail).toBeTruthy();
    expect(rail.classList.contains("hk-scroll-container")).toBe(true);
    expect(rail.tagName).toBe("NAV");
    // The fallthrough attribute landed on that root, not on the viewport
    // or nowhere (happy-dom's no-layout degenerate read is "none").
    expect(rail.getAttribute("data-selection-beyond")).toBe("none");
    const viewport = rail.querySelector(".hk-scroll-container-viewport") as HTMLElement;
    expect(viewport).toBeTruthy();
    expect(viewport.hasAttribute("data-selection-beyond")).toBe(false);
    const pane = wrapper.element.querySelector(".hk-settings__pane") as HTMLElement;
    expect(pane.classList.contains("hk-scroll-container")).toBe(true);
    expect(pane.hasAttribute("data-selection-beyond")).toBe(false);

    // End-to-end wiring: stub the band and the active row, scroll the REAL
    // viewport, and the state must flip on the root — proving the composable
    // sensed through the container's exposed scroller and its listeners are
    // bound to that element.
    const band = { x: 0, y: 0, top: 0, bottom: 400, left: 0, right: 100, width: 100, height: 400 } as DOMRect;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(band);
    const active = rail.querySelector(".hk-settings__rail-item.is-active") as HTMLElement;
    const below = { x: 0, y: 500, top: 500, bottom: 560, left: 0, right: 100, width: 100, height: 60 } as DOMRect;
    vi.spyOn(active, "getBoundingClientRect").mockReturnValue(below);
    vi.spyOn(active, "getClientRects").mockReturnValue([below] as unknown as DOMRectList);
    viewport.dispatchEvent(new Event("scroll"));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    expect(rail.getAttribute("data-selection-beyond")).toBe("bottom");
    wrapper.unmount();
  });

  it("switches sections on rail click and reports aria-current", async () => {
    const wrapper = mountShell();
    const items = wrapper.findAll(".hk-settings__rail-item");
    await items[2].trigger("click");
    expect(wrapper.find('[data-test="pane-network"]').exists()).toBe(true);
    expect(items[2].classes()).toContain("is-active");
    expect(items[2].attributes("aria-current")).toBe("true");
    expect(items[0].attributes("aria-current")).toBeUndefined();
  });
});
