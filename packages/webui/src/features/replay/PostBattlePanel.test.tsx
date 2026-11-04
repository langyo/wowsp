/**
 * Contract tests for the post-battle player-detail window (issue #1736 P2
 * wave item 4): the level-2 overlay is a first-class HkModal — the window
 * opens with the dialog role + the masked head cluster in the headerLead
 * slot, closes through the unified X / the backdrop / Escape, and its
 * footer action jumps into the lookup screen. The panel is mounted for
 * real (stores against a fresh pinia; the api seam mocked the way the
 * crash store tests do), driven by a minimal BattleResults payload whose
 * players carry no realm — that keeps every on-mount stats path (roster
 * batch + global lookup) off the wire, so the window wiring is the only
 * thing under test.
 */
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { initLocaleMessages, t } from "@/i18n";
import PostBattlePanel from "./PostBattlePanel";

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

// The api seam (same shape the CrashSection tests use): only the calls the
// mounted graph can reach are stubbed, and all resolve to empty results.
vi.mock("@/api", () => ({
  api: {
    markersList: vi.fn(async () => []),
    listenMarkersChanged: vi.fn(async () => () => undefined),
    upstreamHealth: vi.fn(async () => []),
    copyImageToClipboard: vi.fn(async () => true),
  },
}));

/** One CLIENT_PUBLIC_RESULTS row, the 15.2+ layout: >=500 entries so the
 *  late fields (exp 404 / killer 408 / damage 426) read unshifted. */
function ppiRow(opts: {
  name: string;
  team: 0 | 1;
  shipId: number;
  exp?: number;
  damage?: number;
}): unknown[] {
  const arr: unknown[] = new Array(538).fill(null);
  arr[1] = opts.name;
  arr[6] = opts.team;
  arr[7] = opts.shipId;
  arr[15] = 20000; // max hull HP
  arr[20] = 9000; // remained hull HP
  arr[21] = true; // survived
  arr[32] = 0; // frags
  arr[404] = opts.exp ?? 0; // base exp
  arr[408] = 0; // killer (0 = none)
  arr[426] = opts.damage ?? 0; // battle damage
  return arr;
}

/** Minimal BattleResults: the recorder + one enemy. No player carries a
 *  realm, so both stats paths (loadNameStats / loadGlobal) bail before any
 *  lookup; privateDataList[7] feeds the recorder's own settlement line. */
const RAW = JSON.stringify({
  accountDBID: 1001,
  commonList: [],
  playersPublicInfo: {
    "1001": ppiRow({ name: "AdmiralA", team: 0, shipId: 101, exp: 1200, damage: 56000 }),
    "2001": ppiRow({ name: "EnemyB", team: 1, shipId: 102, exp: 300, damage: 12000 }),
  },
  privateDataList: [[], [], [], [], [], [], [], [450000, 0, 0, 1200]],
});

function mountPanel() {
  return mount(PostBattlePanel, {
    props: { raw: RAW, head: null, operation: false },
  });
}

/** Open the player-detail window by clicking the first roster row. */
async function openDetail(wrapper: ReturnType<typeof mountPanel>) {
  await wrapper.find(".replay-view__postbattle-cell-btn").trigger("click");
  await vi.waitFor(() => {
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
  });
  return document.body.querySelector('[role="dialog"]') as HTMLElement;
}

function dialogGone() {
  return vi.waitFor(() => {
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
}

describe("PostBattlePanel player-detail window", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("opens as a hikari window: dialog role, content hook and the masked head cluster", async () => {
    const wrapper = mountPanel();
    // Closed until a row is clicked (the HkModal stays mounted but renders
    // nothing while modelValue is false).
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    const dialog = await openDetail(wrapper);
    // The shared content-class hook reaches the frame (all three detail
    // sites hang their content off it).
    expect(document.body.querySelector(".hk-modal-content.replay-view__postbattle-detail")).toBeTruthy();
    // surfaceTitle names the dialog (the masked nick).
    expect(dialog.getAttribute("aria-label")).toBe("AdmiralA");
    // The head cluster rides the headerLead slot: BattleIcon + masked name
    // + ship <em>, the shared detail classes the three sites use.
    const name = document.body.querySelector(".replay-view__postbattle-detail-name");
    expect(name?.textContent).toContain("AdmiralA");
    // The body keeps the detail content: the recorder's own settlement
    // line and the global-stats note (no realm → the suffix note).
    expect(document.body.querySelector(".replay-view__postbattle-settlement")?.textContent).toContain(
      t("replay.postbattle.xp"),
    );
    const note = document.body.querySelector(".replay-view__postbattle-global-note");
    expect(note?.textContent).toContain(t("replay.postbattle.globalUnavailable"));
    expect(note?.textContent).toContain(t("replay.postbattle.noRealm"));
  });

  it("closes through the unified window-close X", async () => {
    const wrapper = mountPanel();
    await openDetail(wrapper);
    (document.body.querySelector(".hk-modal-content .hk-modal-close") as HTMLElement).click();
    await dialogGone();
    expect(wrapper.emitted("close")).toBeUndefined();
  });

  it("closes through the backdrop", async () => {
    const wrapper = mountPanel();
    await openDetail(wrapper);
    (document.body.querySelector(".hk-modal-overlay") as HTMLElement).click();
    await dialogGone();
  });

  it("closes through Escape", async () => {
    const wrapper = mountPanel();
    const dialog = await openDetail(wrapper);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await dialogGone();
  });

  it("footer action jumps into the lookup screen and closes the window", async () => {
    const wrapper = mountPanel();
    await openDetail(wrapper);
    const footerButton = document.body.querySelector(
      ".hk-modal-footer button",
    ) as HTMLButtonElement;
    expect(footerButton).toBeTruthy();
    expect(footerButton.textContent).toContain(t("replay.postbattle.fullStats"));
    footerButton.click();
    await dialogGone();
    expect(mocks.push).toHaveBeenCalledWith({
      path: "/lookup",
      query: { name: "AdmiralA", realm: "asia" },
    });
    // jumpToLookup also tears down the replay view behind the window.
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
