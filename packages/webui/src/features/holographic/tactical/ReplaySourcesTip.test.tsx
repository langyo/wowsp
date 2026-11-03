/**
 * Tests for the tactical board's replay-sources hover panel, now hosted by
 * hikari HkPopover: the chip's hover opens the panel (placement, viewport
 * flip and the root DPI zoom's local space are HkPopover's business —
 * covered by hikari's own anchored/rootzoom suites), the panel's content
 * renders the count heading and the replay rows, the anchor↔panel hover
 * grace holds it open across the gap (and closes GRACE_MS after the panel
 * is left), and a tip with no replays never opens at all.
 *
 * The popover teleports to document.body, so panel queries scope to body
 * and open/close transitions are polled to let the popover machine's
 * timer-driven enter/leave settle.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { initLocaleMessages } from "@/i18n";
import type { LearnedReplaySource } from "@/api";
import ReplaySourcesTip, { GRACE_MS } from "./ReplaySourcesTip";

enableAutoUnmount(afterEach);

const REPLAYS: LearnedReplaySource[] = [
  { name: "20260101_101010.wowsreplay", time: "12:34" },
  { name: "20260102_111111.wowsreplay", time: "09:00" },
];

beforeAll(async () => {
  await initLocaleMessages();
});

afterEach(() => {
  document.body.innerHTML = "";
});

function mountTip(replays: LearnedReplaySource[] = REPLAYS) {
  return mount(ReplaySourcesTip, {
    props: { label: "Sources (2)", replays },
  });
}

/** Poll until the teleported popover panel is (not) present. */
async function waitPanel(open: boolean) {
  await flushPromises();
  const here = () => document.body.querySelector<HTMLElement>(".rs-tip__head") !== null;
  for (let i = 0; i < 100; i += 1) {
    if (here() === open) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(here()).toBe(open);
}

describe("ReplaySourcesTip hover panel", () => {
  it("opens on chip hover and renders the count heading and replay rows", async () => {
    const wrapper = mountTip();
    await flushPromises();

    await wrapper.find(".rs-tip").trigger("pointerenter");
    await waitPanel(true);

    const head = document.body.querySelector<HTMLElement>(".rs-tip__head")!;
    expect(head.textContent).toContain("2");
    const items = document.body.querySelectorAll<HTMLElement>(".rs-tip__item");
    expect(items.length).toBe(REPLAYS.length);
    expect(items[0].textContent).toContain(REPLAYS[0].name);
    expect(items[0].textContent).toContain(REPLAYS[0].time);

    // The chip's label slot still carries the caller's text.
    expect(wrapper.find(".rs-tip__chip").text()).toBe("Sources (2)");
    wrapper.unmount();
    await waitPanel(false);
  });

  it("holds the panel open across the anchor↔panel gap and closes after the grace", async () => {
    const wrapper = mountTip();
    await flushPromises();

    await wrapper.find(".rs-tip").trigger("pointerenter");
    await waitPanel(true);

    // Leaving the chip starts the grace timer — the pointer is assumed to
    // be traveling toward the panel.
    await wrapper.find(".rs-tip").trigger("pointerleave");
    await flushPromises();

    // Arriving on the panel within the grace cancels the close, and the
    // panel is still up well past the grace window.
    document.body.querySelector<HTMLElement>(".hk-popover-panel")!
      .dispatchEvent(new MouseEvent("mouseenter"));
    await new Promise((r) => setTimeout(r, GRACE_MS + 120));
    await waitPanel(true);

    // Leaving the panel lets the grace run out and the panel retires.
    document.body.querySelector<HTMLElement>(".hk-popover-panel")!
      .dispatchEvent(new MouseEvent("mouseleave"));
    await waitPanel(false);
    wrapper.unmount();
  });

  it("never opens for a tip without replays", async () => {
    const wrapper = mountTip([]);
    await flushPromises();

    await wrapper.find(".rs-tip").trigger("pointerenter");
    await new Promise((r) => setTimeout(r, GRACE_MS + 120));
    expect(document.body.querySelector<HTMLElement>(".rs-tip__head")).toBeNull();
    wrapper.unmount();
  });
});
