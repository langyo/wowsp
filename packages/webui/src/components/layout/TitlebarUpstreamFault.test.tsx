/**
 * Tests for the title bar's upstream-fault chip: renders nothing while
 * the health table is healthy, rings on a failing host with LOCALIZED
 * text (never raw i18n keys — the flat-key regression this guards), and
 * its hover card discloses the failing domain, its purpose and the last
 * error. Dismissal hides the chip.
 *
 * The api module is mocked; the pinia store is real (its refresh reads
 * the mocked api). happy-dom measures every box as 0×0 — irrelevant
 * here, the card's position math tolerates zero rects.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  upstreamHealth: vi.fn(),
}));

vi.mock("@/api", () => ({ api: mocks }));

import { initLocaleMessages } from "@/i18n";
import type { UpstreamHostReport } from "@/api";
import { useUpstreamHealthStore } from "@/stores/upstreamHealth";
import TitlebarUpstreamFault from "./TitlebarUpstreamFault";

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

function row(overrides: Partial<UpstreamHostReport> = {}): UpstreamHostReport {
  return {
    id: "vortex-cn",
    host: "vortex.wowsgame.cn",
    purpose: "statsVortex",
    realms: ["cn"],
    kind: "stats",
    recorded: true,
    consecutiveFailures: 0,
    lastSuccessTs: null,
    lastFailureTs: null,
    lastError: null,
    ...overrides,
  };
}

const NOW = Math.floor(Date.now() / 1000);

async function mountChip() {
  const wrapper = mount(TitlebarUpstreamFault, { global: { plugins: [createPinia()] } });
  await flushPromises();
  return wrapper;
}

/** real-timer settle: covers the chip's 150ms hover-open delay */
async function settle(ms = 250) {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.upstreamHealth.mockReset();
});

describe("TitlebarUpstreamFault", () => {
  it("renders nothing on a healthy table", async () => {
    mocks.upstreamHealth.mockResolvedValue([
      row({ consecutiveFailures: 0, lastSuccessTs: NOW - 5 }),
    ]);
    const wrapper = await mountChip();
    expect(wrapper.find(".titlebar-upstream-fault").exists()).toBe(false);
  });

  it("renders nothing for a single transient failure", async () => {
    mocks.upstreamHealth.mockResolvedValue([
      row({ consecutiveFailures: 1, lastFailureTs: NOW - 5 }),
    ]);
    const wrapper = await mountChip();
    expect(wrapper.find(".titlebar-upstream-fault").exists()).toBe(false);
  });

  it("rings on a failing host with localized text, never raw keys", async () => {
    mocks.upstreamHealth.mockResolvedValue([
      row({
        consecutiveFailures: 3,
        lastFailureTs: NOW - 5,
        lastError: "HTTP 503",
      }),
    ]);
    const wrapper = await mountChip();
    const chip = wrapper.find(".titlebar-upstream-fault");
    expect(chip.exists()).toBe(true);
    const text = wrapper.text();
    // The P0 regression guard: every locale bundle resolves — a raw
    // `upstream.*` key in the DOM means vue-i18n failed to resolve.
    expect(text).not.toContain("upstream.");
    expect(text).toContain("Upstream service fault");
  });

  it("the hover card discloses the failing domain, purpose and last error", async () => {
    mocks.upstreamHealth.mockResolvedValue([
      row({
        consecutiveFailures: 3,
        lastFailureTs: NOW - 120,
        lastError: "HTTP 503",
      }),
    ]);
    const wrapper = await mountChip();
    // The hover handlers live on the INNER chip button — the wrap span
    // carries only the passthrough class (mouseenter does not bubble).
    const inner = wrapper.find("button.hk-persistent-toast");
    expect(inner.exists()).toBe(true);
    inner.element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await settle();
    const card = document.querySelector<HTMLElement>(".titlebar-upstream-fault__card");
    expect(card).not.toBeNull();
    const text = card!.textContent ?? "";
    expect(text).toContain("vortex.wowsgame.cn");
    expect(text).toContain("Stats lookups");
    expect(text).toContain("HTTP 503");
    expect(text).not.toContain("upstream.purpose.");
    // Leaving the chip retracts the card.
    inner.element.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    await settle();
    expect(document.querySelector(".titlebar-upstream-fault__card")).toBeNull();
  });

  it("dismissal hides the chip", async () => {
    mocks.upstreamHealth.mockResolvedValue([
      row({ consecutiveFailures: 2, lastFailureTs: NOW - 5 }),
    ]);
    const wrapper = await mountChip();
    expect(wrapper.find(".titlebar-upstream-fault").exists()).toBe(true);
    wrapper.find(".hk-persistent-toast__dismiss").element.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flushPromises();
    expect(wrapper.find(".titlebar-upstream-fault").exists()).toBe(false);
    // The store keeps the dismissal for the episode.
    const store = useUpstreamHealthStore();
    expect(store.dismissedKey).toContain("vortex-cn");
  });
});
