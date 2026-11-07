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
 *
 * Three later review pins ride here as well: the retired mode/map head row
 * (a passed `head` identity must not bring it back), the complete
 * identity-line seals (every seal the row owns presses inline, whole — the
 * old one-tag cap clipped or hid the rest) and the three-line row hover
 * hint (clan-tagged nick / every tag / ship tier + name) the mask eye must
 * not steal. The seal pin needs the opposite fixture setup (a realmful
 * roster + zh UI, the composition sweep's gates), so it mounts its own
 * payload while the window tests keep the realmless one.
 *
 * The sticky head block (toolbar + hoisted team column-header grid pinned at
 * the scroll window's top edge) gets its structural pins here: happy-dom has
 * no layout, so the tests pin the DOM contract the CSS sticky rule relies on
 * (block placement, header cells hoisted out of the matrix columns while the
 * matrix keeps two columns, each team's title staying inside its own stacked
 * column at the ≤960px matrix breakpoint, and the live resize swap) while the
 * real-browser geometry is covered by scripts/e2e/test_results_layout.py.
 */
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { initLocaleMessages, t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import PostBattlePanel, { type PostBattleHead } from "./PostBattlePanel";
import type { SelfStatsStream } from "./liveSelfStats";
import { NICK_MASK } from "./postBattleShare";

enableAutoUnmount(afterEach);

// happy-dom's innerWidth is a fixed getter — plain assignment is silently
// ignored, so shadow it with a controllable accessor (the same signal
// hikari's useBreakpoint reads while the panel sets up). The sticky-head pins
// run at the desktop default (>960px, two-column matrix); the stacked and
// resize pins flip it per case and restore it in a finally. (Same harness
// trick as AppTitleBar.test.tsx.)
let viewportWidth = 1024;
Object.defineProperty(window, "innerWidth", {
  get: () => viewportWidth,
  configurable: true,
});

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
    // The seal pin's two on-wire paths: the composition sweep behind the
    // identity-line seals (one verdict per queried name — every human in
    // its roster is BOTH an air and a sub main, so the row must press both
    // 空中小人 and 水下小人 whole) and the realmful roster's stats batch
    // (empty answers leave every stat cell dashed, so no career verdict
    // joins the composition tags on the line).
    lookupPlayersComposition: vi.fn(async (names: string[]) =>
      names.map(() => ({ air: true, sub: true, airVeteran: false, subVeteran: false })),
    ),
    lookupPlayersStatsBatch: vi.fn(async () => []),
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
  /** WG realm code (CLIENT_PUBLIC_RESULTS [9]). Omitted by the window
   *  fixtures so every on-mount stats path bails before the wire; the seal
   *  fixture passes one — the composition sweep keys `${realm}:${name}`. */
  realm?: string;
}): unknown[] {
  const arr: unknown[] = new Array(538).fill(null);
  arr[1] = opts.name;
  arr[6] = opts.team;
  arr[7] = opts.shipId;
  if (opts.realm) arr[9] = opts.realm;
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

/** The window fixtures plus a realmful twin for the seal pin. Same battle
 *  shape; every player carries a realm so the composition sweep has a key
 *  to ask under (a realmless roster idles both the sweep and the stats
 *  batch, which is exactly why the window tests use that one). */
const RAW_WITH_REALM = JSON.stringify({
  accountDBID: 1001,
  commonList: [],
  playersPublicInfo: {
    "1001": ppiRow({
      name: "AdmiralA",
      team: 0,
      shipId: 101,
      exp: 1200,
      damage: 56000,
      realm: "asia",
    }),
    "2001": ppiRow({
      name: "EnemyB",
      team: 1,
      shipId: 102,
      exp: 300,
      damage: 12000,
      realm: "asia",
    }),
  },
  privateDataList: [[], [], [], [], [], [], [], [450000, 0, 0, 1200]],
});

/** A decoded-but-empty stream: enough for the 全员/我的 switcher to render
 *  (the self view's source), while buildSelfStats bails to its empty report. */
const EMPTY_STREAM: SelfStatsStream = {
  trajectories: [],
  recorderVehicleId: null,
  shotKills: [],
  damageStats: [],
  achievements: [],
  arenaPlayers: [],
  battleResults: null,
  shellLaunches: [],
  torpedoes: [],
};

function mountPanel(
  props: {
    raw?: string;
    head?: PostBattleHead | null;
    operation?: boolean;
    stream?: SelfStatsStream | null;
  } = {},
) {
  return mount(PostBattlePanel, {
    props: { raw: RAW, head: null, operation: false, ...props },
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

describe("PostBattlePanel sticky head block", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("pins the toolbar + a hoisted two-cell header grid in ONE sticky block above the matrix", () => {
    const wrapper = mountPanel();
    const root = wrapper.element as HTMLElement;
    const stickyEl = root.querySelector(".replay-view__postbattle-sticky") as HTMLElement | null;
    expect(stickyEl).toBeTruthy();
    // The block is the panel's FIRST child (the sticky pin needs the top
    // edge it paints to be the panel's own top edge) and the toolbar opens
    // it — the toolbar's 8px margin gap must stay inside the block's paint.
    expect(root.firstElementChild).toBe(stickyEl);
    expect(
      (stickyEl as HTMLElement).firstElementChild?.classList.contains(
        "replay-view__postbattle-toolbar",
      ),
    ).toBe(true);
    // The header seat rides the block only while the header grid is in it.
    expect(
      (stickyEl as HTMLElement).classList.contains(
        "replay-view__postbattle-sticky--with-head",
      ),
    ).toBe(true);
    const sticky = wrapper.find(".replay-view__postbattle-sticky");
    const thead = sticky.find(".replay-view__postbattle-thead");
    expect(thead.exists()).toBe(true);
    // Desktop width (happy-dom's default 1024): roster view, both teams'
    // column titles moved up into the header grid.
    expect(thead.findAll(".replay-view__postbattle-col-title")).toHaveLength(2);
    // DOM order contract: the sticky block precedes the scrolling matrix.
    const matrixEl = root.querySelector(".replay-view__postbattle-matrix") as HTMLElement | null;
    expect(matrixEl).toBeTruthy();
    const children = [...root.children];
    expect(children.indexOf(stickyEl as HTMLElement)).toBeLessThan(
      children.indexOf(matrixEl as HTMLElement),
    );
    // At two-column width the matrix columns carry rows only — a title left
    // inside a column would scroll away from the pinned header (and double
    // the titles); the stacked layout puts it back per column.
    const inners = wrapper.findAll(".replay-view__postbattle-col__inner");
    expect(inners).toHaveLength(2);
    for (const inner of inners) {
      expect(inner.find(".replay-view__postbattle-col-title").exists()).toBe(false);
      expect(inner.findAll(".replay-view__postbattle-cell").length).toBeGreaterThan(0);
    }
  });

  it("mirrors the single-column matrix with the header grid's --single variant (operations)", () => {
    const wrapper = mountPanel({ operation: true });
    const matrix = wrapper.find(".replay-view__postbattle-matrix");
    expect(matrix.classes()).toContain("replay-view__postbattle-matrix--single");
    const thead = wrapper.find(".replay-view__postbattle-thead");
    expect(thead.exists()).toBe(true);
    expect(thead.classes()).toContain("replay-view__postbattle-thead--single");
    // Operations have no enemy roster: one full-width column, one title.
    expect(thead.findAll(".replay-view__postbattle-col-title")).toHaveLength(1);
  });

  it("keeps the toolbar sticky with no header row in the 我的战绩 self view", async () => {
    const wrapper = mountPanel({ stream: EMPTY_STREAM });
    // The switcher only renders when a decoded stream backs the self report;
    // the second segmented button is the 我的战绩 face.
    const switchBtns = wrapper.findAll(".replay-view__postbattle-viewswitch-btn");
    expect(switchBtns).toHaveLength(2);
    await switchBtns[1].trigger("click");
    // The self report replaces the matrix, but the toolbar keeps its pinned
    // block — with no roster header grid under it (and no header seat).
    const sticky = wrapper.find(".replay-view__postbattle-sticky");
    expect(sticky.exists()).toBe(true);
    expect(sticky.find(".replay-view__postbattle-toolbar").exists()).toBe(true);
    expect(sticky.classes()).not.toContain(
      "replay-view__postbattle-sticky--with-head",
    );
    expect(wrapper.find(".replay-view__postbattle-thead").exists()).toBe(false);
    expect(wrapper.find(".replay-view__postbattle-matrix").exists()).toBe(false);
  });

  it("keeps each team title inside its own column while the matrix stacks (≤960px)", () => {
    // 900px is the narrow-desktop stack PR #1820 added; 700px is the phone
    // stack. Both put the matrix into ONE column, so both must move the
    // titles back into their columns and keep only the toolbar in the block
    // — a hoisted two-cell header would cap the ALLIES rows with the
    // ENEMIES' title.
    for (const width of [900, 700]) {
      viewportWidth = width;
      try {
        const wrapper = mountPanel();
        const sticky = wrapper.find(".replay-view__postbattle-sticky");
        expect(sticky.exists()).toBe(true);
        expect(sticky.find(".replay-view__postbattle-toolbar").exists()).toBe(true);
        expect(sticky.classes()).not.toContain(
          "replay-view__postbattle-sticky--with-head",
        );
        expect(wrapper.find(".replay-view__postbattle-thead").exists()).toBe(false);
        // Each stacked team gets its title back as its column's FIRST child,
        // followed by that team's rows.
        const inners = wrapper.findAll(".replay-view__postbattle-col__inner");
        expect(inners).toHaveLength(2);
        for (const inner of inners) {
          expect(inner.findAll(".replay-view__postbattle-col-title")).toHaveLength(1);
          expect(
            (inner.element.firstElementChild as HTMLElement | null)?.classList.contains(
              "replay-view__postbattle-col-title",
            ),
          ).toBe(true);
          expect(inner.findAll(".replay-view__postbattle-cell").length).toBeGreaterThan(0);
        }
      } finally {
        viewportWidth = 1024;
        // The composable's resize listener must see the desktop width again
        // before the auto-unmount, so no later mount inherits a stack width.
        window.dispatchEvent(new Event("resize"));
      }
    }
  });

  it("swaps the header grid between the sticky block and the columns on a live resize", async () => {
    const wrapper = mountPanel();
    try {
      expect(wrapper.find(".replay-view__postbattle-thead").exists()).toBe(true);
      viewportWidth = 900;
      window.dispatchEvent(new Event("resize"));
      await nextTick();
      // The single stacked-matrix signal drives thead, --with-head and the
      // in-column titles together — a live resize must move all three.
      expect(wrapper.find(".replay-view__postbattle-thead").exists()).toBe(false);
      expect(wrapper.find(".replay-view__postbattle-sticky").classes()).not.toContain(
        "replay-view__postbattle-sticky--with-head",
      );
      for (const inner of wrapper.findAll(".replay-view__postbattle-col__inner")) {
        expect(inner.findAll(".replay-view__postbattle-col-title")).toHaveLength(1);
      }
      viewportWidth = 1024;
      window.dispatchEvent(new Event("resize"));
      await nextTick();
      expect(wrapper.find(".replay-view__postbattle-thead").exists()).toBe(true);
      expect(wrapper.find(".replay-view__postbattle-sticky").classes()).toContain(
        "replay-view__postbattle-sticky--with-head",
      );
      for (const inner of wrapper.findAll(".replay-view__postbattle-col__inner")) {
        expect(inner.findAll(".replay-view__postbattle-col-title")).toHaveLength(0);
      }
    } finally {
      // A failing assertion must not leave later mounts at the stacked width.
      viewportWidth = 1024;
      window.dispatchEvent(new Event("resize"));
    }
  });
});

describe("PostBattlePanel head row, inline seals and row hint", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("renders no battle-identity head row even when a head identity is passed", () => {
    // The mode pill + map label row above the toolbar was retired
    // (2026-11-07 review: the user read it as an extra element). The battle
    // identity still feeds the copied sheet's mode pill, so the prop stays —
    // it just must never repaint the DOM row.
    const wrapper = mountPanel({
      head: { matchGroup: "pvp", mapName: "42_Neighbors" },
    });
    expect(wrapper.find(".replay-view__postbattle-head").exists()).toBe(false);
    expect(wrapper.find(".replay-view__postbattle-toolbar").exists()).toBe(true);
  });

  it("presses every seal inline and puts the complete identity on the row hint", async () => {
    const { uiLocale } = useLanguage();
    const prevLocale = uiLocale.value;
    // The composition sweep (and the seal gates it feeds) only runs under a
    // zh UI — the module-singleton ref the panel reads, set before mount so
    // the first render already asks for the roster's verdicts.
    uiLocale.value = "zh-CN";
    try {
      const wrapper = mountPanel({ raw: RAW_WITH_REALM });
      await vi.waitFor(() => {
        expect(wrapper.find(".replay-view__postbattle-cell-seals").text()).toContain(
          "空中小人",
        );
      });
      // BOTH composition classes press on the identity line, whole — the
      // retired one-tag cap / alert marker must not swallow either.
      const seals = wrapper.find(".replay-view__postbattle-cell-seals");
      expect(seals.text()).toContain("空中小人");
      expect(seals.text()).toContain("水下小人");
      expect(wrapper.find(".replay-view__postbattle-seal-alert").exists()).toBe(false);
      expect(wrapper.find(".replay-view__postbattle-seal-dot").exists()).toBe(false);
      // The row's hover hint is the complete identity: line 1 the nickname
      // (clan-tagged when the profile has one), line 2 every tag one by one,
      // line 3 the ship. The seals are listed there too, so a long row that
      // ellipsizes its nick still reads whole on hover.
      const hint =
        wrapper.find(".replay-view__postbattle-cell-btn").attributes("data-hint") ?? "";
      const lines = hint.split("\n");
      expect(lines[0]).toBe("AdmiralA");
      expect(lines[1]).toContain("空中小人");
      expect(lines[1]).toContain("水下小人");
      // The eye keeps its own mask hint: a direct hover on the eye never
      // shows the row card (its own hover is the only one that lights it).
      const eye = wrapper.find(".replay-view__postbattle-cell-eye");
      expect(eye.attributes("data-hint")).toBe(t("replay.postbattle.hideName"));
    } finally {
      uiLocale.value = prevLocale;
    }
  });

  it("masks the nickname inside the row hint (the hint is a new surface)", async () => {
    const wrapper = mountPanel();
    // The toolbar's hide-all-nicknames toggle masks every row; the hint is a
    // separate render channel and must ride the same mask.
    const toggle = wrapper
      .findAll(".replay-view__postbattle-toolbar button")
      .find((button) => button.text().includes(t("replay.postbattle.hideAll")));
    expect(toggle).toBeTruthy();
    await toggle!.trigger("click");
    await vi.waitFor(() => {
      expect(wrapper.find(".replay-view__postbattle-cell-btn").attributes("data-hint")).toContain(
        NICK_MASK,
      );
    });
    const hint = wrapper.find(".replay-view__postbattle-cell-btn").attributes("data-hint") ?? "";
    expect(hint.split("\n")[0]).toBe(NICK_MASK);
    expect(hint).not.toContain("AdmiralA");
  });

  it("gives the full card the compact header's aligned columns and its identity lines", async () => {
    const wrapper = mountPanel();
    // Both densities share the two-line aggregate header — the full card no
    // longer squeezes its aggregates into one inline run (2026-11-07 review).
    const header = wrapper.find(".replay-view__postbattle-col-title--agg");
    expect(header.exists()).toBe(true);
    expect(header.find(".replay-view__postbattle-col-hlbl").exists()).toBe(true);
    expect(header.findAll(".replay-view__postbattle-col-hval").length).toBeGreaterThan(0);
    // Flip to the full density through the toolbar's own toggle.
    const toggle = wrapper
      .findAll(".replay-view__postbattle-toolbar button")
      .find((button) => button.text().includes(t("replay.roster.fullMode")));
    expect(toggle).toBeTruthy();
    await toggle!.trigger("click");
    await vi.waitFor(() => {
      expect(wrapper.find(".replay-view__postbattle-fcell").exists()).toBe(true);
    });
    // The header keeps the same two-line grid in full mode.
    const fullHeader = wrapper.find(".replay-view__postbattle-col-title--agg");
    expect(fullHeader.exists()).toBe(true);
    // The card's left stack carries the row hint's three lines; its right
    // block stacks the compact row's aligned data line over the ship strip.
    const card = wrapper.find(".replay-view__postbattle-fcell");
    expect(card.find(".replay-view__postbattle-fcell-main").exists()).toBe(true);
    expect(card.find(".replay-view__postbattle-fcell-ship").exists()).toBe(true);
    const data = card.find(".replay-view__postbattle-fcell-data");
    expect(data.exists()).toBe(true);
    expect(data.find(".replay-view__postbattle-cell-xp").exists()).toBe(true);
    expect(card.find(".replay-view__postbattle-fcell-meta").exists()).toBe(true);
    // The hint anchors on the identity stack, NOT the whole card: the ship
    // strip's own hover card owns the right block and two popups must never
    // stack, so the button itself carries no hint.
    expect(card.attributes("data-hint")).toBeUndefined();
    expect(
      card.find(".replay-view__postbattle-fcell-btn").attributes("data-hint"),
    ).toBeUndefined();
    expect(
      card.find(".replay-view__postbattle-fcell-main").attributes("data-hint"),
    ).toContain("AdmiralA");
  });
});
