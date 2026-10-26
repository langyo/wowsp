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
  // happy-dom returns a zero rect; the flyout skips placement on zero and
  // would never open its measured card.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 120,
    height: 20,
    top: 10,
    left: 10,
    right: 130,
    bottom: 30,
    x: 10,
    y: 10,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function openCard(build: ReturnType<typeof buildView> | null) {
  const wrapper = mount(LiveShipMeta, {
    props: { shipId: 4065212112, ally: true, build },
    global: { plugins: [createPinia()] },
  });
  await wrapper.find(".live-ship-meta").trigger("mouseenter");
  vi.advanceTimersByTime(260);
  await nextTick();
  await nextTick();
  return wrapper;
}

describe("LiveShipMeta build card", () => {
  it("renders the loadout grid in the hover card and widens it", async () => {
    const wrapper = await openCard(buildView());
    const card = document.body.querySelector(".live-ship-card") as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card?.style.width).toBe("460px");
    expect(document.body.querySelector(".player-build")).not.toBeNull();
    wrapper.unmount();
  });

  it("keeps the spec-only card (360 px, no grid) without a build", async () => {
    const wrapper = await openCard(null);
    const card = document.body.querySelector(".live-ship-card") as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card?.style.width).toBe("360px");
    expect(document.body.querySelector(".player-build")).toBeNull();
    wrapper.unmount();
  });
});
