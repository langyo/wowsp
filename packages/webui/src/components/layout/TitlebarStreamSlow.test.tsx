/**
 * Tests for the title bar's degraded-loading chip: renders nothing while
 * every fetch source is healthy, rings with LOCALIZED text (never raw
 * i18n keys) while a source streams past the slow threshold, its hover
 * card explains the partial-data situation, and it stands down by itself
 * when the source settles (done) — no dismissal to test, the condition
 * is live.
 *
 * The api module is mocked; the pinia store is real (events are driven
 * through its exported applyProgress hook, the same function the
 * Rust→JS subscription calls).
 */
import { createPinia, getActivePinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  readShipStatsHistory: vi.fn(),
  lookupPlayerShipStats: vi.fn(),
  upstreamHealth: vi.fn(),
}));

vi.mock("@/api", () => ({
  api: {
    ...mocks,
    listenShipStatsProgress: undefined,
  },
}));

import { initLocaleMessages } from "@/i18n";
import { useShipStatsStore } from "@/stores/shipStats";
import TitlebarStreamSlow from "./TitlebarStreamSlow";

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

async function mountChip() {
  // The CURRENTLY ACTIVE pinia must back the component — the mutated
  // store lives on it (the beforeEach one); a fresh createPinia() here
  // would hand the chip an empty store.
  const wrapper = mount(TitlebarStreamSlow, { global: { plugins: [getActivePinia()!] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.readShipStatsHistory.mockReset().mockResolvedValue([]);
  mocks.lookupPlayerShipStats.mockReset();
  mocks.upstreamHealth.mockReset().mockResolvedValue([]);
});

describe("TitlebarStreamSlow", () => {
  it("renders nothing while no stream is slow", async () => {
    const wrapper = await mountChip();
    expect(wrapper.find(".titlebar-stream-slow").exists()).toBe(false);
  });

  it("rings on a slow source with localized text, never raw keys", async () => {
    const store = useShipStatsStore();
    store.applyProgress({
      realm: "asia",
      accountId: 1,
      phase: "slow",
      source: "vortex:pvp",
    });
    const wrapper = await mountChip();
    expect(wrapper.find(".titlebar-stream-slow").exists()).toBe(true);
    const text = wrapper.text();
    // The flat-key regression guard: every locale bundle resolves.
    expect(text).not.toContain("upstream.");
    expect(text).toContain("Partial data downloaded, still loading");
  });

  it("keeps one chip across several slow sources and stands down when all settle", async () => {
    const store = useShipStatsStore();
    store.applyProgress({ realm: "asia", accountId: 1, phase: "slow", source: "vortex:pvp" });
    store.applyProgress({ realm: "asia", accountId: 1, phase: "slow", source: "official" });
    const wrapper = await mountChip();
    expect(wrapper.findAll(".titlebar-stream-slow").length).toBe(1);
    store.applyProgress({ realm: "asia", accountId: 1, phase: "done", source: "vortex:pvp" });
    await flushPromises();
    expect(wrapper.find(".titlebar-stream-slow").exists()).toBe(true);
    store.applyProgress({ realm: "asia", accountId: 1, phase: "aborted", source: "official" });
    await flushPromises();
    expect(wrapper.find(".titlebar-stream-slow").exists()).toBe(false);
  });

  it("the hover card explains the degraded partial-data situation", async () => {
    const store = useShipStatsStore();
    store.applyProgress({ realm: "cn", accountId: 2, phase: "slow", source: "vortex:pvp" });
    const wrapper = await mountChip();
    const inner = wrapper.find("button.hk-persistent-toast");
    expect(inner.exists()).toBe(true);
    inner.element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    const card = document.querySelector<HTMLElement>(".titlebar-stream-slow__card");
    expect(card).not.toBeNull();
    const text = card!.textContent ?? "";
    expect(text).toContain("upstream service is degraded");
    expect(text).not.toContain("upstream.slow.");
  });
});
