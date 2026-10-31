/**
 * Tests for the sidebar's plugin-update hint card: the PINNED state
 * (running client + stale probe opens the card on its own and keeps it
 * up, with the stale-stats warning line), the hover rhythm when not
 * pinned, the anchor geometry (right of the game-status card, vertically
 * centered on it), the clickable rows deep-linking each stale plugin's
 * mod-hub page, the busy action's spinner + updating label, and the
 * one-click action driving the all-installs pass, and the minimize
 * button parking the card (the settled-hover reopen debounce, and the
 * park winning over the pin's auto-open until the hover unparks it).
 *
 * The api module is mocked; the pinia stores are real (their refs are
 * set directly). happy-dom measures every box as 0×0, so the anchor
 * element's getBoundingClientRect is stubbed per mount.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";

import { useToast } from "@celestia-island/hikari";

const mocks = vi.hoisted(() => ({
  modCatalogRefresh: vi.fn(),
  modHubRecords: vi.fn(),
  ingamePluginStatus: vi.fn(),
  ingamePluginInstall: vi.fn(),
  ingamePluginUninstall: vi.fn(),
  modCatalogInstall: vi.fn(),
  modCatalogUninstall: vi.fn(),
  modHubSafeMode: vi.fn(),
  listenDownloadProgress: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("@/api", () => ({ api: mocks }));
// The hint's rows navigate via router.push; the test harness has no
// router — the spy is the navigation assertion surface.
vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.routerPush }) }));

import { initLocaleMessages, t } from "@/i18n";
import type { GameInstall } from "@/api";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { usePluginUpdatesStore } from "@/stores/pluginUpdates";
import { installLabel } from "@/utils/installLabel";
import PluginUpdateHint, { REOPEN_DELAY_MS, SETTLED_LINGER_MS } from "./PluginUpdateHint";

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
  mocks.routerPush.mockResolvedValue(undefined);
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
  mocks.modHubSafeMode.mockResolvedValue(false);
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

  it("settles into a done line instead of vanishing when the pass empties the card", async () => {
    // The pinned card IS the watching user. The probe updating flips
    // probeOutdated (and with it the pin) — the card must close with the
    // done line, not snap away the moment its last row leaves the list
    // (user report 2026-10-31: that vanish read as "the probe is gone").
    const { wrapper, updates } = await mountHint(
      { probeOutdated: true, running: true },
      anchorCard(),
    );
    expect(pop()?.textContent).toContain(t("resources.pluginUpdateCount", { count: 1 }));
    // The pointer is ON the trigger: the settle is attended, so no
    // self-close timer arms and the ordinary leave grace owns the close.
    await wrapper.find(".plugin-update-hint").trigger("mouseenter");

    updates.perInstall[GAME].probeOutdated = false;
    await flushPromises();

    const settled = pop();
    expect(settled).not.toBeNull();
    expect(settled?.textContent).toContain(t("resources.pluginUpdateDone"));
    expect(settled?.querySelector(".plugin-update-hint__warn")).toBeNull();
    expect(settled?.querySelector(".plugin-update-hint__go")).toBeNull();

    // The settled line is a close, not a new standing state: leaving the
    // trigger dismisses it through the ordinary grace, and a later hover
    // with nothing pending does not resurrect it.
    await wrapper.find(".plugin-update-hint").trigger("mouseleave");
    vi.advanceTimersByTime(180);
    await flushPromises();
    expect(pop()).toBeNull();

    await wrapper.find(".plugin-update-hint").trigger("mouseenter");
    vi.advanceTimersByTime(250);
    await flushPromises();
    expect(pop()).toBeNull();
  });

  it("closes an unattended settled card after its linger window", async () => {
    // The realistic unattended shape: the game exited (pin gone) and the
    // probe update landed right after — nobody's pointer is anywhere near
    // the card. The done line still shows, but only for its read time.
    const { updates, gameStatus } = await mountHint(
      { probeOutdated: true, running: true },
      anchorCard(),
    );
    expect(pop()).not.toBeNull();

    gameStatus.process = {
      running: false,
      pid: null,
      kind: null,
      realm: null,
      exePath: null,
      matchedInstall: null,
    };
    updates.perInstall[GAME].probeOutdated = false;
    await flushPromises();

    expect(pop()?.textContent).toContain(t("resources.pluginUpdateDone"));
    vi.advanceTimersByTime(SETTLED_LINGER_MS - 500);
    await flushPromises();
    expect(pop()).not.toBeNull();

    vi.advanceTimersByTime(500);
    await flushPromises();
    expect(pop()).toBeNull();
  });

  it("a refill inside the linger window retires the done line, not the card", async () => {
    // Finding 1 regression: a fresh stale episode refills the list while
    // the unattended settle's self-close timer is still pending. The
    // refill must clear the settled state (the done line gives way to the
    // pending list again) AND the stale timer must not fire into the
    // refilled card.
    const { updates, gameStatus } = await mountHint(
      { probeOutdated: true, running: true },
      anchorCard(),
    );
    gameStatus.process = {
      running: false,
      pid: null,
      kind: null,
      realm: null,
      exePath: null,
      matchedInstall: null,
    };
    updates.perInstall[GAME].probeOutdated = false;
    await flushPromises();
    expect(pop()?.textContent).toContain(t("resources.pluginUpdateDone"));

    updates.perInstall[GAME].probeOutdated = true;
    await flushPromises();
    expect(pop()?.textContent).toContain(t("resources.pluginUpdateCount", { count: 1 }));

    vi.advanceTimersByTime(SETTLED_LINGER_MS + 200);
    await flushPromises();
    expect(pop()).not.toBeNull();
    expect(pop()?.textContent).toContain(t("resources.pluginUpdateCount", { count: 1 }));
  });

  it("survives the Sidebar mount shape: plain tooltip, card, done line, plain tooltip", async () => {
    // Round-2 finding regression: Sidebar used to swap PluginUpdateHint
    // out for a plain HkTooltip the moment totalCount hit 0 — the same
    // flush that arms the settle, so the done line never painted in
    // production. This mounts the component the way Sidebar now does
    // (always mounted, plainTooltip set) and drives one full episode.
    const pinia = createPinia();
    setActivePinia(pinia);
    const config = useConfigStore();
    const install: GameInstall = { kind: "steam", path: GAME, realm: "asia" };
    config.activeInstall = install;
    config.installs = [install];
    const updates = usePluginUpdatesStore();
    updates.perInstall = { [GAME]: { mods: [], probeOutdated: false } };
    const gameStatus = useGameStatusStore();
    const setRunning = (running: boolean) => {
      gameStatus.process = {
        running,
        pid: running ? 42 : null,
        kind: running ? "steam" : null,
        realm: running ? "asia" : null,
        exePath: running ? `${GAME}\\WorldOfWarships.exe` : null,
        matchedInstall: running ? install : null,
      };
    };
    setRunning(false);

    const anchor = ref<HTMLElement | null>(anchorCard());
    const Host = defineComponent({
      setup: () => () => (
        <PluginUpdateHint anchor={anchor} plainTooltip={GAME}>
          <button type="button">trigger</button>
        </PluginUpdateHint>
      ),
    });
    // VTU mounts the host DETACHED from the document (only the Teleported
    // popup reaches document.body), so the span assertions ride the mount
    // wrapper — document.querySelector would be vacuous here.
    const host = mount(Host, { global: { plugins: [pinia] } });
    await flushPromises();
    const spanUp = () => host.find(".plugin-update-hint").exists();

    // Empty at rest: the plain tooltip owns the row — no interactive span.
    expect(spanUp()).toBe(false);
    expect(pop()).toBeNull();

    // A stale episode arms the card (pinned: game running + stale probe).
    setRunning(true);
    updates.perInstall[GAME].probeOutdated = true;
    await flushPromises();
    expect(spanUp()).toBe(true);
    expect(pop()?.textContent).toContain(t("resources.pluginUpdateCount", { count: 1 }));

    // The watched update empties it: the SAME mount must show the done
    // line — exactly the flip the old Sidebar ternary unmounted through.
    setRunning(false);
    updates.perInstall[GAME].probeOutdated = false;
    await flushPromises();
    expect(pop()?.textContent).toContain(t("resources.pluginUpdateDone"));

    // Unattended close returns the row to the plain tooltip.
    vi.advanceTimersByTime(SETTLED_LINGER_MS);
    await flushPromises();
    expect(pop()).toBeNull();
    expect(spanUp()).toBe(false);
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

  it("disables the action and says why while every pending client runs", async () => {
    // The pinned card is exactly the all-running state (user report
    // 2026-10-17): the pass would skip 100% of the work, so the CTA
    // must not look actionable — disabled, relabeled, and unable to
    // reach even the skipping branch.
    await mountHint({ probeOutdated: true, running: true }, anchorCard());

    const btn = pop()?.querySelector<HTMLButtonElement>(".plugin-update-hint__go");
    expect(btn).toBeTruthy();
    expect(btn?.disabled).toBe(true);
    expect(btn?.textContent).toContain(t("resources.pluginUpdateBlockedRunning"));
    btn?.click();
    await flushPromises();
    expect(mocks.ingamePluginInstall).not.toHaveBeenCalled();
  });

  it("keeps the action live when another install can still update", async () => {
    // The running client is skipped, but a second pending install keeps
    // the pass meaningful: normal label, clickable CTA.
    await mountHint(
      { probeOutdated: true, running: true, other: { probeOutdated: true } },
      anchorCard(),
    );

    const btn = pop()?.querySelector<HTMLButtonElement>(".plugin-update-hint__go");
    expect(btn?.disabled).toBe(false);
    expect(btn?.textContent).toContain(t("resources.pluginUpdateOne"));
  });

  it("explains itself when every pending item is busy elsewhere", async () => {
    // The fully silent no-op shape: nothing skipped-by-running-game, yet
    // no task either — every pending item mid-op on another surface.
    const { updates } = await mountHint({ probeOutdated: true, running: false }, anchorCard());
    updates.itemBusy.set("probe:builtin", "install");
    await updates.updateAll();
    await flushPromises();

    expect(mocks.ingamePluginInstall).not.toHaveBeenCalled();
    const slot = useToast().toasts.find((x) => x.type === "info");
    expect(slot?.messages.at(-1)?.text).toBe(t("resources.pluginUpdateBusyElsewhere"));
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
    // The probe + one mod on the active client, the probe on the other —
    // each group's rows are the menu grammar's buttons.
    expect(
      groups.map((g) => g.querySelectorAll(".hk-menu-action-item").length),
    ).toEqual([2, 1]);
    expect(el?.querySelector(".plugin-update-hint__title")?.textContent).toBe(
      t("resources.pluginUpdateCountMulti", { count: 3, clients: 2 }),
    );
    expect(wrapper.find(".plugin-update-hint__badge").text()).toBe("3");
  });

  it("renders every stale item as a clickable row deep-linking the mod hub", async () => {
    // Nine stale items — past the old "+N" fold: the card scrolls, so
    // every row must exist. The probe leads (the batch pass runs it
    // first) and deep-links the plugin's own mod-hub page.
    const { wrapper } = await mountHint(
      {
        probeOutdated: true,
        running: false,
        mods: [
          { id: "a", name: "mod-a" },
          { id: "b", name: "mod-b" },
          { id: "c", name: "mod-c" },
          { id: "d", name: "mod-d" },
          { id: "e", name: "mod-e" },
          { id: "f", name: "mod-f" },
          { id: "g", name: "mod-g" },
          { id: "h", name: "mod-h" },
        ],
      },
      anchorCard(),
    );
    await wrapper.find(".plugin-update-hint").trigger("mouseenter");
    vi.advanceTimersByTime(250);
    await flushPromises();

    const rows = Array.from(
      pop()?.querySelectorAll<HTMLButtonElement>(".hk-menu-action-item") ?? [],
    );
    expect(rows.length).toBe(9);
    expect(rows[0]?.textContent).toContain(t("resources.pluginProbeName"));

    rows[0]?.click();
    await flushPromises();
    expect(mocks.routerPush).toHaveBeenCalledWith({
      path: "/resources",
      query: { mod: "battle.ingame.stats" },
    });
    // Acting on a row ends the reminder — the card closes.
    expect(pop()).toBeNull();
  });

  it("deep-links a stale mod row to its catalog page", async () => {
    const { wrapper } = await mountHint(
      { probeOutdated: false, running: false, mods: [{ id: "mod-x", name: "X mod" }] },
      anchorCard(),
    );
    await wrapper.find(".plugin-update-hint").trigger("mouseenter");
    vi.advanceTimersByTime(250);
    await flushPromises();

    const row = pop()?.querySelector<HTMLButtonElement>(".hk-menu-action-item");
    expect(row?.textContent).toContain("X mod");
    row?.click();
    await flushPromises();

    expect(mocks.routerPush).toHaveBeenCalledWith({
      path: "/resources",
      query: { mod: "mod-x" },
    });
    expect(pop()).toBeNull();
  });

  it("swaps the action to a spinner and the updating label while the pass runs", async () => {
    const { wrapper, updates } = await mountHint(
      { probeOutdated: true, running: false },
      anchorCard(),
    );
    await wrapper.find(".plugin-update-hint").trigger("mouseenter");
    vi.advanceTimersByTime(250);
    await flushPromises();
    expect(pop()?.querySelector(".plugin-update-hint__go .hk-spinner")).toBeNull();

    updates.running = true;
    await flushPromises();

    const btn = pop()?.querySelector<HTMLButtonElement>(".plugin-update-hint__go");
    expect(btn?.disabled).toBe(true);
    expect(btn?.querySelector(".hk-spinner")).not.toBeNull();
    expect(btn?.textContent).toContain(t("resources.pluginUpdateRunning"));
  });

  describe("minimize (parked card)", () => {
    const RUNNING_PROC = {
      running: true,
      pid: 42,
      kind: "steam" as const,
      realm: "asia" as const,
      exePath: `${GAME}\\WorldOfWarships.exe`,
      matchedInstall: { kind: "steam" as const, path: GAME, realm: "asia" },
    };
    const OFFLINE_PROC = {
      running: false,
      pid: null,
      kind: null,
      realm: null,
      exePath: null,
      matchedInstall: null,
    };

    it("the minimize button parks the card until a settled trigger hover", async () => {
      // Pinned card (running client, stale probe): the dismissal must
      // win over the pin, too.
      const { wrapper } = await mountHint({ probeOutdated: true, running: true }, anchorCard());
      expect(pop()).not.toBeNull();

      const min = pop()?.querySelector<HTMLButtonElement>(".plugin-update-hint__min");
      expect(min).toBeTruthy();
      expect(min?.getAttribute("aria-label")).toBe(t("resources.pluginUpdateMinimize"));
      min?.click();
      await flushPromises();
      expect(pop()).toBeNull();

      // A drive-by pass (hover shorter than the reopen debounce) must
      // not bring the card straight back up.
      await wrapper.find(".plugin-update-hint").trigger("mouseenter");
      vi.advanceTimersByTime(REOPEN_DELAY_MS - 1);
      await flushPromises();
      expect(pop()).toBeNull();

      // A settled hover does.
      vi.advanceTimersByTime(1);
      await flushPromises();
      expect(pop()).not.toBeNull();
    });

    it("leaving the trigger before the reopen debounce cancels it", async () => {
      const { wrapper } = await mountHint({ probeOutdated: true, running: false }, anchorCard());
      await wrapper.find(".plugin-update-hint").trigger("mouseenter");
      vi.advanceTimersByTime(250);
      await flushPromises();
      pop()?.querySelector<HTMLButtonElement>(".plugin-update-hint__min")?.click();
      await flushPromises();
      expect(pop()).toBeNull();

      await wrapper.find(".plugin-update-hint").trigger("mouseenter");
      vi.advanceTimersByTime(100);
      await wrapper.find(".plugin-update-hint").trigger("mouseleave");
      vi.advanceTimersByTime(REOPEN_DELAY_MS + 500);
      await flushPromises();
      expect(pop()).toBeNull();

      // The card stays parked — the next settled hover still unparks it.
      await wrapper.find(".plugin-update-hint").trigger("mouseenter");
      vi.advanceTimersByTime(REOPEN_DELAY_MS);
      await flushPromises();
      expect(pop()).not.toBeNull();
    });

    it("a parked card stays down even when the pin re-arms", async () => {
      const { wrapper, gameStatus } = await mountHint(
        { probeOutdated: true, running: true },
        anchorCard(),
      );
      pop()?.querySelector<HTMLButtonElement>(".plugin-update-hint__min")?.click();
      await flushPromises();
      expect(pop()).toBeNull();

      // Pin lifts (game closes) and re-arms (client running, probe
      // stale again) — neither flip may auto-open the parked card.
      gameStatus.process = OFFLINE_PROC;
      await flushPromises();
      gameStatus.process = RUNNING_PROC;
      await flushPromises();
      expect(pop()).toBeNull();

      // The settled hover is still the way back.
      await wrapper.find(".plugin-update-hint").trigger("mouseenter");
      vi.advanceTimersByTime(REOPEN_DELAY_MS);
      await flushPromises();
      expect(pop()).not.toBeNull();
    });

    it("a stale episode starting from an emptied card never inherits the park", async () => {
      const { wrapper, updates } = await mountHint(
        { probeOutdated: false, running: false, mods: [{ id: "a", name: "mod-a" }] },
        anchorCard(),
      );
      await wrapper.find(".plugin-update-hint").trigger("mouseenter");
      vi.advanceTimersByTime(250);
      await flushPromises();
      pop()?.querySelector<HTMLButtonElement>(".plugin-update-hint__min")?.click();
      await flushPromises();

      // Everything updates elsewhere → the badge empties; a NEW stale
      // episode then begins. The park must not pre-dismiss it.
      updates.perInstall = {};
      await flushPromises();
      updates.perInstall = {
        [GAME]: { mods: [{ id: "b", name: "mod-b" }], probeOutdated: true },
      };
      await flushPromises();

      await wrapper.find(".plugin-update-hint").trigger("mouseenter");
      vi.advanceTimersByTime(250); // the NORMAL tooltip rhythm — not the reopen debounce
      await flushPromises();
      expect(pop()).not.toBeNull();
    });
  });
});
