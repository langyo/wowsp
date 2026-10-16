/**
 * Tests for the sidebar's plugin-update hint card: the PINNED state
 * (running client + stale probe opens the card on its own and keeps it
 * up, with the stale-stats warning line), the hover rhythm when not
 * pinned, the anchor geometry (right of the game-status card, vertically
 * centered on it), and the one-click action driving the all-installs
 * pass.
 *
 * The api module is mocked; the pinia stores are real (their refs are
 * set directly). happy-dom measures every box as 0×0, so the anchor
 * element's getBoundingClientRect is stubbed per mount.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";

import { useToast } from "@celestia-island/hikari";

const mocks = vi.hoisted(() => ({
  modCatalogRefresh: vi.fn(),
  modHubRecords: vi.fn(),
  ingamePluginStatus: vi.fn(),
  ingamePluginInstall: vi.fn(),
  ingamePluginUninstall: vi.fn(),
  modCatalogInstall: vi.fn(),
  modCatalogUninstall: vi.fn(),
  listenDownloadProgress: vi.fn(),
}));

vi.mock("@/api", () => ({ api: mocks }));

import { initLocaleMessages, t } from "@/i18n";
import type { GameInstall } from "@/api";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { usePluginUpdatesStore } from "@/stores/pluginUpdates";
import { installLabel } from "@/utils/installLabel";
import PluginUpdateHint from "./PluginUpdateHint";

enableAutoUnmount(afterEach);

const GAME = "D:\\Games\\World of Warships";
const OTHER = "E:\\OtherClient";

beforeAll(async () => {
  await initLocaleMessages();
});

function stubRect(
  el: HTMLElement,
  rect: { right: number; top: number; height: number },
): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, bottom: 0, width: 0, x: 0, y: 0, ...rect, toJSON: () => ({}) }) as DOMRect;
}

/** A stand-in for the sidebar's game-status card with a plausible rect. */
function anchorCard(right = 240, top = 700, height = 40): HTMLElement {
  const el = document.createElement("div");
  stubRect(el, { right, top, height });
  return el;
}

interface HintSeed {
  probeOutdated: boolean;
  running: boolean;
  mods?: { id: string; name: string }[];
  /** A second pending install (Wargaming/EU) to exercise grouping. */
  other?: { probeOutdated: boolean };
}

/** Mount the hint around a stubbed anchor with seeded stores. */
async function mountHint(seed: HintSeed, card: HTMLElement | null = null) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const config = useConfigStore();
  const installs: GameInstall[] = [{ kind: "steam", path: GAME, realm: "asia" }];
  const perInstall: Record<string, { mods: { id: string; name: string }[]; probeOutdated: boolean }> = {
    [GAME]: { mods: seed.mods ?? [], probeOutdated: seed.probeOutdated },
  };
  if (seed.other) {
    installs.push({ kind: "wargaming", path: OTHER, realm: "eu" });
    perInstall[OTHER] = { mods: [], probeOutdated: seed.other.probeOutdated };
  }
  config.activeInstall = installs[0];
  config.installs = installs;
  const updates = usePluginUpdatesStore();
  updates.perInstall = perInstall;
  const gameStatus = useGameStatusStore();
  gameStatus.process = {
    running: seed.running,
    pid: seed.running ? 42 : null,
    kind: seed.running ? "steam" : null,
    realm: seed.running ? "asia" : null,
    exePath: seed.running ? `${GAME}\\WorldOfWarships.exe` : null,
    matchedInstall: seed.running ? { kind: "steam", path: GAME, realm: "asia" } : null,
  };
  const anchor = ref<HTMLElement | null>(card);
  const wrapper = mount(PluginUpdateHint, {
    props: { anchor },
    global: { plugins: [pinia] },
    slots: { default: () => "trigger" },
  });
  await flushPromises();
  return { wrapper, updates, gameStatus };
}

function pop(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".plugin-update-hint__pop");
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.listenDownloadProgress.mockReturnValue(() => undefined);
  mocks.modCatalogRefresh.mockResolvedValue({
    mods: [],
    fetchedAt: "",
    sourceVersion: "",
    gameVersion: "",
  });
  mocks.modHubRecords.mockResolvedValue([]);
  mocks.ingamePluginStatus.mockResolvedValue({
    installed: true,
    outdated: false,
    resMods: "",
    discussion: 0,
  });
  mocks.ingamePluginInstall.mockResolvedValue("ok");
});

afterEach(() => {
  vi.useRealTimers();
  const toasts = useToast().toasts;
  for (const slot of [...toasts]) useToast().remove(slot.id);
});

describe("PluginUpdateHint", () => {
  it("pins open without hover while the running client's probe is stale", async () => {
    await mountHint({ probeOutdated: true, running: true }, anchorCard());

    const el = pop();
    expect(el).not.toBeNull();
    // Anchored right of the card, vertically centered on it.
    expect(el?.style.left).toBe("250px");
    expect(el?.style.top).toBe("720px");
    expect(el?.style.transform).toBe("translateY(-50%)");
    // The pinned card is a standing status with the stale-stats warning.
    expect(el?.getAttribute("role")).toBe("status");
    expect(el?.querySelector(".plugin-update-hint__warn")).not.toBeNull();
  });

  it("stays open past the close grace while pinned", async () => {
    const { wrapper } = await mountHint({ probeOutdated: true, running: true }, anchorCard());

    await wrapper.find(".plugin-update-hint").trigger("mouseleave");
    vi.advanceTimersByTime(180);
    await flushPromises(); // the grace timer still needs a render flip

    expect(pop()).not.toBeNull();
  });

  it("opens on hover and closes on leave when nothing is running", async () => {
    const { wrapper } = await mountHint(
      { probeOutdated: false, running: false, mods: [{ id: "a", name: "mod-a" }] },
      anchorCard(),
    );
    expect(pop()).toBeNull(); // no pin without a running client

    await wrapper.find(".plugin-update-hint").trigger("mouseenter");
    vi.advanceTimersByTime(250);
    await flushPromises();
    const el = pop();
    expect(el).not.toBeNull();
    expect(el?.getAttribute("role")).toBe("tooltip");
    expect(el?.querySelector(".plugin-update-hint__warn")).toBeNull();

    await wrapper.find(".plugin-update-hint").trigger("mouseleave");
    vi.advanceTimersByTime(180);
    await flushPromises(); // the grace timer's close still needs a render
    expect(pop()).toBeNull();
  });

  it("keeps the card under a reading pointer when the pin lifts", async () => {
    // The warning's own follow-up is "close the game, then update" —
    // the card must not vanish the moment the game closes under the
    // pointer; the hover handlers take over from there.
    const { wrapper, gameStatus } = await mountHint(
      { probeOutdated: true, running: true },
      anchorCard(),
    );
    await wrapper.find(".plugin-update-hint").trigger("mouseenter");

    gameStatus.process = {
      running: false,
      pid: null,
      kind: null,
      realm: null,
      exePath: null,
      matchedInstall: null,
    };
    await flushPromises();

    expect(pop()).not.toBeNull();
    expect(pop()?.querySelector(".plugin-update-hint__warn")).toBeNull();

    // Leaving afterwards closes it through the ordinary grace.
    await wrapper.find(".plugin-update-hint").trigger("mouseleave");
    vi.advanceTimersByTime(180);
    await flushPromises();
    expect(pop()).toBeNull();
  });

  it("clamps the centered top against the viewport bottom once measured", async () => {
    await mountHint({ probeOutdated: true, running: true }, anchorCard(240, 700, 40));
    const el = pop();
    expect(el).not.toBeNull();
    expect(el?.style.top).toBe("720px"); // centered on the card pre-measure

    // The rendered card measures 400px tall (half 200): a center at 720
    // would push the bottom edge past the viewport → the re-anchor
    // (resize) clamps the top up instead.
    Object.defineProperty(el, "offsetHeight", { value: 400, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await flushPromises();

    expect(el?.style.top).toBe(`${window.innerHeight - 8 - 200}px`);
  });

  it("one-click update drives the all-installs pass", async () => {
    // Hovered open (game offline — the running client would be skipped
    // by design, which the store tests cover).
    const { wrapper } = await mountHint({ probeOutdated: true, running: false }, anchorCard());
    await wrapper.find(".plugin-update-hint").trigger("mouseenter");
    vi.advanceTimersByTime(250);
    await flushPromises();

    const btn = pop()?.querySelector<HTMLButtonElement>(".plugin-update-hint__go");
    expect(btn).toBeTruthy();
    btn?.click();
    await flushPromises();

    expect(mocks.ingamePluginInstall).toHaveBeenCalledWith(GAME);
  });

  it("renders just the slot when nothing is outdated", async () => {
    const { wrapper } = await mountHint({ probeOutdated: false, running: true }, anchorCard());

    expect(pop()).toBeNull();
    expect(wrapper.find(".plugin-update-hint__badge").exists()).toBe(false);
    expect(wrapper.text()).toContain("trigger");
  });

  it("groups the stale list per client when several installs are pending", async () => {
    const { wrapper } = await mountHint(
      {
        probeOutdated: true,
        running: true,
        mods: [{ id: "a", name: "mod-a" }],
        other: { probeOutdated: true },
      },
      anchorCard(),
    );

    const el = pop();
    const groups = Array.from(el?.querySelectorAll(".plugin-update-hint__group") ?? []);
    expect(groups.length).toBe(2);
    // Active install's group first; labels come from the shared
    // installLabel vocabulary ("Steam · ASIA" / "Wargaming · EU").
    expect(
      Array.from(el?.querySelectorAll(".plugin-update-hint__group-label") ?? []).map(
        (n) => n.textContent,
      ),
    ).toEqual([installLabel("steam", "asia"), installLabel("wargaming", "eu")]);
    // The probe + one mod on the active client, the probe on the other.
    expect(
      groups.map((g) => g.querySelectorAll(".plugin-update-hint__group-items li").length),
    ).toEqual([2, 1]);
    expect(el?.querySelector(".plugin-update-hint__title")?.textContent).toBe(
      t("resources.pluginUpdateCountMulti", { count: 3, clients: 2 }),
    );
    expect(wrapper.find(".plugin-update-hint__badge").text()).toBe("3");
  });
});
