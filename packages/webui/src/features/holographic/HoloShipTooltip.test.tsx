/**
 * Tests for the holographic map's live ship tooltip card, now hosted by
 * hikari HkPopover (issue #1736's hover-card family — the same recipe as
 * ReplaySourcesTip): placement, viewport flip, clamping and the root DPI
 * zoom's local space are HkPopover's own business (covered by hikari's
 * anchored/rootzoom suites), so these tests pin the CARD's contract — the
 * hovered player's content renders in the teleported panel, the
 * whole-panel hover events feed the parent's keep-alive bridge
 * (onCardHover), and content updates at the playhead keep the card
 * mounted (the parent owns mount/unmount).
 *
 * The encyclopedia/model DBs stay empty (the identity chain falls back to
 * the vehicle's own shipName).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { initLocaleMessages } from "@/i18n";
import type { VehicleEntry } from "@/api";
import HoloShipTooltip from "./HoloShipTooltip";

enableAutoUnmount(afterEach);

// A complete `VehicleEntry` — the literal already satisfied the interface, so
// the assertion was pure noise (it only hid a future field being renamed).
const VEHICLE: VehicleEntry = {
  id: 1,
  name: "alpha",
  relation: 1,
  shipId: 4286,
  shipName: "Izumo",
};

/** An enemy-side vehicle (relation ≥ 2): the card's team rail hooks off it. */
const ENEMY_VEHICLE: VehicleEntry = {
  id: 2,
  name: "bravo",
  relation: 2,
  shipId: 4286,
  shipName: "Izumo",
};

beforeAll(async () => {
  await initLocaleMessages();
});

afterEach(() => {
  document.body.innerHTML = "";
});

function mountTip(onCardHover: (inside: boolean) => void = () => {}) {
  setActivePinia(createPinia());
  return mount(HoloShipTooltip, {
    props: {
      vehicle: VEHICLE,
      anchorEl: document.createElement("div"),
      time: 100,
      state: null,
      stats: new Map(),
      encyclopedia: new Map(),
      onCardHover,
    },
  });
}

function card(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".holo-ship-tip");
}

/** Poll until the teleported popover panel is (not) present. */
async function waitCard(present: boolean) {
  await flushPromises();
  const here = () => card() !== null;
  for (let i = 0; i < 100; i += 1) {
    if (here() === present) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(here()).toBe(present);
}

describe("HoloShipTooltip card", () => {
  it("renders the hovered player's card content in the anchored panel", async () => {
    const wrapper = mountTip();
    await waitCard(true);

    const el = card();
    // The identity chain falls back to the vehicle's own name/shipName.
    expect(el?.textContent).toContain("alpha");
    expect(el?.textContent).toContain("Izumo");
    // The card rides HkPopover's panel (the shared hover-card recipe).
    expect(el?.classList.contains("hk-popover-panel")).toBe(true);
    wrapper.unmount();
    await waitCard(false);
  });

  it("tints the team rail for enemy ships", async () => {
    // The ally/enemy left rail is the card's at-a-glance team read (the
    // migration onto HkPopover once dropped the variant class and every
    // enemy card silently read ally-green — pinned here).
    setActivePinia(createPinia());
    const wrapper = mount(HoloShipTooltip, {
      props: {
        vehicle: ENEMY_VEHICLE,
        anchorEl: document.createElement("div"),
        time: 100,
        state: null,
        stats: new Map(),
        encyclopedia: new Map(),
        onCardHover: () => {},
      },
    });
    await waitCard(true);

    const el = card();
    expect(el?.classList.contains("holo-ship-tip--enemy")).toBe(true);
    expect(el?.textContent).toContain("bravo");
    wrapper.unmount();
    await waitCard(false);
  });

  it("bridges the panel's hover events to the parent's keep-alive contract", async () => {
    const hovers: boolean[] = [];
    const wrapper = mountTip((inside) => hovers.push(inside));
    await waitCard(true);

    // The PARENT mounts this card only while a slot (or the card) is
    // hovered; the popover's whole-panel mouseenter/mouseleave feed that
    // bridge (padding and chrome included).
    card()!.dispatchEvent(new MouseEvent("mouseenter"));
    card()!.dispatchEvent(new MouseEvent("mouseleave"));
    await flushPromises();
    expect(hovers).toEqual([true, false]);
    wrapper.unmount();
  });
});
