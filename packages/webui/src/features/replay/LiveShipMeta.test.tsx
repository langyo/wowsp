/**
 * Tests for the live-battle roster strip's hover combat card, now hosted
 * by hikari HkPopover (issue #1736's hover-card family — the recipe the
 * holo scorebar's HoloShipTooltip shares): placement, viewport flip,
 * clamping and the root DPI zoom's local space are HkPopover's own
 * business (covered by hikari's anchored/rootzoom suites), so these tests
 * pin the HOST choreography (arm delay, strip↔card travel grace, Escape
 * close) and the card's content contract (the build grid widens the card,
 * a spec-only build keeps the narrow one).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { nextTick } from "vue";

import type { PlayerBuild } from "@/api";
import { initLocaleMessages, setLocale } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import LiveShipMeta from "./LiveShipMeta";
import { playerBuildView } from "./playerBuild";

const KITAKAZE: PlayerBuild = {
  entityId: 677453,
  shipParamsId: 4065212112,
  name: "Tester",
  modernization: [4280471472, 4262645680],
  exteriors: [4263342000, 4274876336],
  abilities: [4284653488],
  learnedSkills: [[], [], [], [12, 18, 20, 25, 34], [], []],
};

const buildView = () =>
  playerBuildView(KITAKAZE, {
    dataLanguage: "en-US",
    shipType: "Destroyer",
    source: "replay",
  });

beforeAll(async () => {
  await initLocaleMessages();
  await setLocale("en-US");
  useLanguage().uiLocale.value = "en-US";
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** Hover the strip, wait out the arm delay, and settle the popover's
 *  open machinery (the surface machine's phase clocks are setTimeout /
 *  rAF driven — advancing past their budgets settles deterministically). */
async function openCard(build: ReturnType<typeof buildView> | null) {
  const wrapper = mount(LiveShipMeta, {
    props: { shipId: 4065212112, ally: true, build },
    global: { plugins: [createPinia()] },
  });
  await wrapper.find(".live-ship-meta").trigger("mouseenter");
  await vi.advanceTimersByTimeAsync(230);
  await nextTick();
  await nextTick();
  return wrapper;
}

function cardPanel(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".live-ship-card");
}

describe("LiveShipMeta build card", () => {
  it("renders the loadout grid in the hover card and widens it", async () => {
    const wrapper = await openCard(buildView());
    const card = cardPanel();
    expect(card).not.toBeNull();
    // The card rides HkPopover's panel; the pinned width rides the inner
    // content column (the four build grids need the wider box).
    const inner = card!.querySelector<HTMLElement>(".live-ship-card__inner");
    expect(inner?.style.width).toBe("460px");
    expect(document.body.querySelector(".player-build")).not.toBeNull();
    wrapper.unmount();
  });

  it("keeps the spec-only card (360 px, no grid) without a build", async () => {
    const wrapper = await openCard(null);
    const card = cardPanel();
    expect(card).not.toBeNull();
    const inner = card!.querySelector<HTMLElement>(".live-ship-card__inner");
    expect(inner?.style.width).toBe("360px");
    expect(document.body.querySelector(".player-build")).toBeNull();
    wrapper.unmount();
  });

  it("holds the card across the strip↔card gap and closes after the grace", async () => {
    const wrapper = await openCard(null);
    expect(cardPanel()).not.toBeNull();

    // Leaving the strip starts the grace timer — the pointer is assumed to
    // be traveling toward the card.
    await wrapper.find(".live-ship-meta").trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(100);

    // Arriving on the card within the grace cancels the close; the card
    // stays up well past the grace window.
    cardPanel()!.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    expect(cardPanel()).not.toBeNull();

    // Leaving the card lets the grace run out and the card retires.
    cardPanel()!.dispatchEvent(new MouseEvent("mouseleave"));
    await vi.advanceTimersByTimeAsync(200);
    await nextTick();
    await nextTick();
    expect(cardPanel()).toBeNull();
    wrapper.unmount();
  });

  it("closes on Escape through the host's document channel", async () => {
    const wrapper = await openCard(null);
    expect(cardPanel()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await vi.advanceTimersByTimeAsync(30);
    await nextTick();
    await nextTick();
    expect(cardPanel()).toBeNull();
    wrapper.unmount();
  });
});
