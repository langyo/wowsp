/**
 * Probe for the settings rail's selection edge hint under hikari's own
 * `selectionHint` prop (adopted from the retired app-local twin once
 * 0.55.229 shipped the capability upstream): the installed container
 * mirrors the sensed state as `data-selection-beyond` on its ROOT — the
 * positioned non-scrolling box the library's painter draws on — so the
 * app only passes the prop. The structural pins keep the two things the
 * shell relies on: the mirror lands on the rail root (never on the
 * scrolling viewport the sensor reads through), and the pane container,
 * which passes no prop, stays silent.
 *
 * happy-dom performs no layout, so the mount pass's degenerate read is
 * "top": every box is zero and the selected row's zero rect sits at the
 * zero-height band's top edge (the library writes the mirror itself on
 * its first sensing pass — the twin's inert rendered "none" is gone with
 * the fallthrough binding). That value alone cannot distinguish "sensed
 * through the real viewport" from "mirrored by accident", so the probe
 * also drives a scroll on the real viewport with stubbed band geometry
 * and pins the state flip — end-to-end through the installed container's
 * exposed scroller and its scroll listener.
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

  it("mirrors the selection hint state on the rail container ROOT only", async () => {
    const wrapper = mountShell();
    // The rail HOST is the element carrying the shell BEM class AND the
    // container base class — the positioned non-scrolling box the
    // library paints on.
    const rail = wrapper.element.querySelector(".hk-settings__rail") as HTMLElement;
    expect(rail).toBeTruthy();
    expect(rail.classList.contains("hk-scroll-container")).toBe(true);
    expect(rail.tagName).toBe("NAV");
    // The library mirrors the sensed state onto that root itself (its
    // write-on-change contract); happy-dom's no-layout degenerate read
    // is "top" (see the header note).
    expect(rail.getAttribute("data-selection-beyond")).toBe("top");
    const viewport = rail.querySelector(".hk-scroll-container-viewport") as HTMLElement;
    expect(viewport).toBeTruthy();
    // The mirror binds on the container root only — never on the
    // scrolling viewport the sensor reads through.
    expect(viewport.hasAttribute("data-selection-beyond")).toBe(false);
    // ...and only the rail opts in: the pane container carries nothing.
    const pane = wrapper.element.querySelector(".hk-settings__pane") as HTMLElement;
    expect(pane.classList.contains("hk-scroll-container")).toBe(true);
    expect(pane.hasAttribute("data-selection-beyond")).toBe(false);

    // End-to-end: stub the band and the active row, scroll the REAL
    // viewport, and the mirrored state must flip on the root — the
    // upstream sensor senses through the exposed scroller and its own
    // scroll listener.
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
