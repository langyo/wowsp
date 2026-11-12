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
 * (a passed `head` identity must not bring it back), the identity-line
 * seal rule (single-character wordings stay inline; every wider wording —
 * the four-character composition tags included — collapses behind ONE "!"
 * badge pressed BEFORE the nickname in the compact row, vertically centered
 * on the name line (2026-11-12: moved left of the nick), while the full
 * card stacks every wording whole on its seals line and carries no badge;
 * and the rich three-line hover card paints the whole cluster as real
 * StampTag chips — plus the division tag face and the marker's wording the
 * old plain hint carried — in the hovered density's own classes while the
 * mask eye keeps its own hint). The
 * seal pins need the opposite fixture setup (a realmful roster + zh UI, the
 * composition sweep's gates), so they mount their own payload while the
 * window tests keep the realmless one. happy-dom measures zero rects, so the
 * hover-card pins stub getBoundingClientRect (the MapNameTag / LiveShipMeta
 * harness trick) and restore it per test; the touch pin flips only the
 * "(hover: none)" media query and delegates every other query to the real
 * matcher.
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
import { statsPrefsState } from "@/stores/statsPrefs";
import { useCapabilitiesStore } from "@/stores/capabilities";
import { STATIC_REPORT_READ_TIMEOUT_MS } from "@/api/modules/decision";
import { api, type StaticReport } from "@/api";
import { useMarkersStore } from "@/stores/markers";
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
    // The AI score column's on-wire path (only reachable when the mounted
    // capabilities store reports aiInference — the other suites keep it off).
    decisionStaticReport: vi.fn(),
  },
}));

/** One CLIENT_PUBLIC_RESULTS row, the 15.2–15.9 layout: 538 entries (the
 *  500..549 band) so the late fields (exp 404 / killer 408 / damage 426)
 *  read unshifted. */
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
  /** CLIENT_PUBLIC_RESULTS [21]; defaults to true so the plain fixtures
   *  keep every row alive — the sunk-row fixture passes false. */
  survived?: boolean;
}): unknown[] {
  const arr: unknown[] = new Array(538).fill(null);
  arr[1] = opts.name;
  arr[6] = opts.team;
  arr[7] = opts.shipId;
  if (opts.realm) arr[9] = opts.realm;
  arr[15] = 20000; // max hull HP
  arr[20] = 9000; // remained hull HP
  arr[21] = opts.survived ?? true; // survived
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

/** The sunk-row fixture: real baked-DB shipIds (src/data/ship_names.json)
 *  so the row icons resolve their class — the ally self rides a Battleship
 *  (3247387984, PVSB999 Cordillera) and the dead enemy a Destroyer
 *  (3256759600, PWSD990 Södermanland, survived: false). Same battle shape
 *  as RAW. */
const RAW_SUNK = JSON.stringify({
  accountDBID: 1001,
  commonList: [],
  playersPublicInfo: {
    "1001": ppiRow({ name: "AdmiralA", team: 0, shipId: 3247387984, exp: 1200, damage: 56000 }),
    "2001": ppiRow({
      name: "EnemyB",
      team: 1,
      shipId: 3256759600,
      exp: 300,
      damage: 12000,
      survived: false,
    }),
  },
  privateDataList: [[], [], [], [], [], [], [], [450000, 0, 0, 1200]],
});

/** The realmful seal fixture with divisions on both sides: the arena join
 *  letters "AdmiralA" and "EnemyB" as 组队A (each side letters independently
 *  over its own rows), so the hover-card pin can assert the yellow tag face
 *  rides the card too. */
const DIVISION_STREAM: SelfStatsStream = {
  trajectories: [],
  recorderVehicleId: null,
  shotKills: [],
  damageStats: [],
  achievements: [],
  arenaPlayers: [
    { entityId: 1001, teamId: 0, name: "AdmiralA", prebattle: 7 },
    { entityId: 2001, teamId: 1, name: "EnemyB", prebattle: 7 },
  ],
  battleResults: null,
  shellLaunches: [],
  torpedoes: [],
};

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

/** happy-dom measures every box 0×0, and the identity card skips a zero-rect
 *  anchor (a vanished row must not clamp the float into a corner) — stub a
 *  real anchor box for the hover-card pins and restore it afterwards. */
function stubAnchorRect() {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
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
}

/** Hover a compact row and wait out the identity card's show delay. */
async function openRowCard(wrapper: ReturnType<typeof mountPanel>) {
  await wrapper.find(".replay-view__postbattle-cell-btn").trigger("mouseenter");
  await vi.waitFor(() => {
    expect(document.body.querySelector(".postbattle-idcard")).toBeTruthy();
  });
  return document.body.querySelector(".postbattle-idcard") as HTMLElement;
}

/** The toolbar's full-density toggle (a persisted stats pref — every pin
 *  that flips it restores it, or a later mount inherits full mode). */
function fullModeToggle(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper
    .findAll(".replay-view__postbattle-toolbar button")
    .find((button) => button.text().includes(t("replay.roster.fullMode")));
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

describe("PostBattlePanel head row, inline seals and identity hover card", () => {
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

  it("collapses multi-character seals behind one badge and floats the whole cluster in the rich hover card", async () => {
    const { uiLocale } = useLanguage();
    const prevLocale = uiLocale.value;
    // The composition sweep (and the seal gates it feeds) only runs under a
    // zh UI — the module-singleton ref the panel reads, set before mount so
    // the first render already asks for the roster's verdicts.
    uiLocale.value = "zh-CN";
    const rect = stubAnchorRect();
    try {
      const wrapper = mountPanel({ raw: RAW_WITH_REALM });
      await vi.waitFor(() => {
        expect(wrapper.find(".replay-view__postbattle-seals-badge").exists()).toBe(true);
      });
      // The four-character composition tags no longer press inline: the
      // fixture owns no single-character seal, so the inline cluster is gone
      // entirely and ONE badge per row stands in for the pair.
      const firstCell = wrapper.find(".replay-view__postbattle-cell");
      expect(firstCell.find(".replay-view__postbattle-cell-seals").exists()).toBe(false);
      expect(firstCell.findAll(".replay-view__postbattle-seals-badge")).toHaveLength(1);
      const badge = firstCell.find(".replay-view__postbattle-seals-badge");
      // A plain span (the row IS a button — no nested interactive control)
      // whose accessible label names the hidden wordings.
      expect(badge.element.tagName).toBe("SPAN");
      expect(badge.attributes("aria-label")).toContain("空中小人");
      expect(badge.attributes("aria-label")).toContain("水下小人");
      // (2026-11-12: the badge moved before the nick; the old top-right
      // superscript seat is gone.) Seat pin: the badge LEADS the name line —
      // its first element child, ahead of the nickname span, the same seat
      // the inline seal chips read from.
      const nameLine = firstCell.find(".replay-view__postbattle-cell-name");
      expect(nameLine.element.firstElementChild).toBe(badge.element);
      expect(wrapper.find(".replay-view__postbattle-seal-alert").exists()).toBe(false);
      expect(wrapper.find(".replay-view__postbattle-seal-dot").exists()).toBe(false);
      // The old plain-text row hint is gone — the rich card replaces it.
      expect(
        wrapper.find(".replay-view__postbattle-cell-btn").attributes("data-hint"),
      ).toBeUndefined();
      // The eye keeps its own mask hint: a direct hover on the eye never
      // shows the row card (its own hover is the only one that lights it).
      expect(wrapper.find(".replay-view__postbattle-cell-eye").attributes("data-hint")).toBe(
        t("replay.postbattle.hideName"),
      );

      const card = await openRowCard(wrapper);
      // Line 1: the row's masked, tinted nickname.
      expect(card.querySelector(".postbattle-idcard__name")?.textContent).toContain(
        "AdmiralA",
      );
      // Line 2: EVERY seal the row owns, as the real StampTag chips (the
      // collapsed ones included — the same faces the list presses).
      const chips = [...card.querySelectorAll(".stamp-tag")].map((el) => el.textContent);
      expect(chips).toContain("空中小人");
      expect(chips).toContain("水下小人");
      // Line 3: the row's own tier + ship sub-line styling.
      expect(card.querySelector(".replay-view__postbattle-cell-tier")).toBeTruthy();
      expect(card.querySelector(".replay-view__postbattle-cell-ship")).toBeTruthy();
      // Exactly the three identity lines: name / seals / ship.
      expect(card.children).toHaveLength(3);
    } finally {
      rect.mockRestore();
      uiLocale.value = prevLocale;
    }
  });

  it("carries the division tag, the marker wording and every seal into the hover card", async () => {
    const { uiLocale } = useLanguage();
    const prevLocale = uiLocale.value;
    uiLocale.value = "zh-CN";
    const rect = stubAnchorRect();
    try {
      const wrapper = mountPanel({ raw: RAW_WITH_REALM, stream: DIVISION_STREAM });
      await vi.waitFor(() => {
        expect(wrapper.find(".replay-view__postbattle-cell-seals, .replay-view__postbattle-seals-badge").exists()).toBe(true);
      });
      // The row keeps the yellow division tag inline, unchanged by the seal
      // collapse.
      const divisionLabel = t("replay.postbattle.divisionTag", { letter: "A" });
      expect(
        wrapper.find(".replay-view__postbattle-cell-name .division-tag").text(),
      ).toContain(divisionLabel);
      // A local marker tints the row's nick and contributes its WORDING to
      // the card (the tint alone cannot say which mark the row carries).
      useMarkersStore().entries = [{ nickname: "AdmiralA", color: "purple" }];
      await nextTick();
      const card = await openRowCard(wrapper);
      // Line 2: the real division tag face + the marker's localized name +
      // the seal chips (collapsed included) — the old hint's whole tag line.
      expect(card.querySelector(".division-tag")?.textContent).toContain(divisionLabel);
      expect(card.textContent).toContain(t("settings.markersColorPurple"));
      const chips = [...card.querySelectorAll(".stamp-tag")].map((el) => el.textContent);
      expect(chips).toContain("空中小人");
      expect(chips).toContain("水下小人");
      // Line 1 keeps the marker-tinted masked nick.
      expect(card.querySelector(".postbattle-idcard__name .marker-tint")).toBeTruthy();
    } finally {
      rect.mockRestore();
      uiLocale.value = prevLocale;
    }
  });

  it("dresses the hover card like the density it hovers in (compact and full card)", async () => {
    const rect = stubAnchorRect();
    const prevFull = statsPrefsState.value.postbattleRosterFull;
    try {
      // Compact host: the float wears the compact row's own classes.
      const compact = mountPanel();
      const compactCard = await openRowCard(compact);
      expect(compactCard.classList.contains("postbattle-idcard--compact")).toBe(true);
      expect(compactCard.querySelector(".replay-view__postbattle-cell-nick")).toBeTruthy();
      expect(compactCard.querySelector(".replay-view__postbattle-cell-tier")).toBeTruthy();
      expect(compactCard.querySelector(".replay-view__postbattle-cell-ship")).toBeTruthy();
      expect(compactCard.querySelector(".replay-view__postbattle-fcell-nick")).toBeNull();
      compact.unmount();

      // Full host: the identity stack floats the full card's own classes.
      const full = mountPanel();
      await fullModeToggle(full)!.trigger("click");
      await vi.waitFor(() => {
        expect(full.find(".replay-view__postbattle-fcell").exists()).toBe(true);
      });
      await full.find(".replay-view__postbattle-fcell-main").trigger("mouseenter");
      await vi.waitFor(() => {
        expect(document.body.querySelector(".postbattle-idcard")).toBeTruthy();
      });
      const fullCard = document.body.querySelector(".postbattle-idcard") as HTMLElement;
      expect(fullCard.classList.contains("postbattle-idcard--full")).toBe(true);
      expect(fullCard.querySelector(".replay-view__postbattle-fcell-nick")).toBeTruthy();
      expect(fullCard.querySelector(".replay-view__postbattle-fcell-tier")).toBeTruthy();
      expect(fullCard.querySelector(".replay-view__postbattle-fcell-shipname")).toBeTruthy();
      expect(fullCard.querySelector(".replay-view__postbattle-cell-nick")).toBeNull();
      // Click-through survives the card host (no nested button / role
      // conflict): the identity stack is an ordinary span inside the card's
      // own drill-down button, so clicking it opens the detail window.
      await full.find(".replay-view__postbattle-fcell-main").trigger("click");
      await vi.waitFor(() => {
        expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
      });
    } finally {
      rect.mockRestore();
      statsPrefsState.value.postbattleRosterFull = prevFull;
    }
  });

  it("keeps the plain-text hint for hover-less surfaces (touch / AT), never stacking both channels", async () => {
    const original = window.matchMedia.bind(window);
    const spy = vi.spyOn(window, "matchMedia").mockImplementation(((
      query: string,
    ) =>
      query === "(hover: none)"
        ? ({
            matches: true,
            media: query,
            onchange: null,
            addListener: () => undefined,
            removeListener: () => undefined,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            dispatchEvent: () => false,
          } as unknown as MediaQueryList)
        : original(query)) as typeof window.matchMedia);
    try {
      const wrapper = mountPanel();
      // The old three-line string is the hint channel touch / AT get — the
      // rich card needs a pointer and never mounts on this surface.
      const hint =
        wrapper.find(".replay-view__postbattle-cell-btn").attributes("data-hint") ?? "";
      expect(hint.split("\n")[0]).toBe("AdmiralA");
      await wrapper.find(".replay-view__postbattle-cell-btn").trigger("mouseenter");
      await new Promise((resolve) => setTimeout(resolve, 260));
      expect(document.body.querySelector(".postbattle-idcard")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps single-character seals inline (both densities) and renders no badge", async () => {
    const { uiLocale } = useLanguage();
    const prevLocale = uiLocale.value;
    const prevLabels = statsPrefsState.value.sealLabels;
    const prevFull = statsPrefsState.value.postbattleRosterFull;
    uiLocale.value = "zh-CN";
    // The rule is wording-based: a composition label shortened to one
    // character keeps its old inline seat (defaults 空中小人 / 水下小人 are
    // four characters and collapse).
    statsPrefsState.value.sealLabels = { air: "空", sub: "水" };
    try {
      const wrapper = mountPanel({ raw: RAW_WITH_REALM });
      await vi.waitFor(() => {
        expect(wrapper.find(".replay-view__postbattle-cell-seals").exists()).toBe(true);
      });
      const seals = wrapper.find(".replay-view__postbattle-cell-seals");
      expect(seals.text()).toContain("空");
      expect(seals.text()).toContain("水");
      expect(wrapper.find(".replay-view__postbattle-seals-badge").exists()).toBe(false);
      // The full card keeps the same single-character cluster on its own
      // line, still with no badge.
      await fullModeToggle(wrapper)!.trigger("click");
      await vi.waitFor(() => {
        expect(wrapper.find(".replay-view__postbattle-fcell").exists()).toBe(true);
      });
      expect(wrapper.find(".replay-view__postbattle-fcell-seals").text()).toContain("空");
      expect(wrapper.find(".replay-view__postbattle-seals-badge").exists()).toBe(false);
    } finally {
      statsPrefsState.value.postbattleRosterFull = prevFull;
      statsPrefsState.value.sealLabels = prevLabels;
      uiLocale.value = prevLocale;
    }
  });

  it("drops the badge in the full card and stacks every seal wording whole on its seals line", async () => {
    const { uiLocale } = useLanguage();
    const prevLocale = uiLocale.value;
    const prevFull = statsPrefsState.value.postbattleRosterFull;
    uiLocale.value = "zh-CN";
    try {
      const wrapper = mountPanel({ raw: RAW_WITH_REALM });
      await vi.waitFor(() => {
        expect(wrapper.find(".replay-view__postbattle-seals-badge").exists()).toBe(true);
      });
      await fullModeToggle(wrapper)!.trigger("click");
      await vi.waitFor(() => {
        expect(wrapper.find(".replay-view__postbattle-fcell").exists()).toBe(true);
      });
      const card = wrapper.find(".replay-view__postbattle-fcell");
      // (2026-11-12 user feedback: the full card's second line has the room
      // — no "!" stand-in.) The full card carries NO badge at all and its
      // seals line presses EVERY wording whole: this fixture's four-char
      // wordings (空中小人 / 水下小人) used to collapse behind the badge.
      expect(card.find(".replay-view__postbattle-seals-badge").exists()).toBe(false);
      const seals = card.find(".replay-view__postbattle-fcell-seals");
      expect(seals.exists()).toBe(true);
      expect(seals.text()).toContain("空中小人");
      expect(seals.text()).toContain("水下小人");
      // The rich card anchors on the identity stack, not the whole button:
      // the ship strip's own hover card owns the right block.
      expect(
        card.find(".replay-view__postbattle-fcell-main").attributes("data-hint"),
      ).toBeUndefined();
    } finally {
      statsPrefsState.value.postbattleRosterFull = prevFull;
      uiLocale.value = prevLocale;
    }
  });

  it("masks the nickname inside the identity hover card", async () => {
    const rect = stubAnchorRect();
    try {
      const wrapper = mountPanel();
      // The toolbar's hide-all-nicknames toggle masks every row; the card is a
      // separate render channel and must ride the same mask.
      const toggle = wrapper
        .findAll(".replay-view__postbattle-toolbar button")
        .find((button) => button.text().includes(t("replay.postbattle.hideAll")));
      expect(toggle).toBeTruthy();
      await toggle!.trigger("click");
      const card = await openRowCard(wrapper);
      expect(card.textContent).toContain(NICK_MASK);
      expect(card.textContent).not.toContain("AdmiralA");
    } finally {
      rect.mockRestore();
    }
  });

  it("gives the full card the compact header's aligned columns and its identity lines", async () => {
    const prevFull = statsPrefsState.value.postbattleRosterFull;
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
    // The card's left stack carries the identity lines; its right block
    // stacks the compact row's aligned data line over the ship strip.
    const card = wrapper.find(".replay-view__postbattle-fcell");
    expect(card.find(".replay-view__postbattle-fcell-main").exists()).toBe(true);
    expect(card.find(".replay-view__postbattle-fcell-ship").exists()).toBe(true);
    const data = card.find(".replay-view__postbattle-fcell-data");
    expect(data.exists()).toBe(true);
    expect(data.find(".replay-view__postbattle-cell-xp").exists()).toBe(true);
    expect(card.find(".replay-view__postbattle-fcell-meta").exists()).toBe(true);
    // The rich identity card anchors on the identity stack, NOT the whole
    // card: the ship strip's own hover card owns the right block and two
    // popups must never stack, so neither the button nor the stack carries
    // the retired plain-text hint.
    expect(card.attributes("data-hint")).toBeUndefined();
    expect(
      card.find(".replay-view__postbattle-fcell-btn").attributes("data-hint"),
    ).toBeUndefined();
    expect(
      card.find(".replay-view__postbattle-fcell-main").attributes("data-hint"),
    ).toBeUndefined();
    statsPrefsState.value.postbattleRosterFull = prevFull;
  });

  it("faces the dead enemy marker LEFT (sunk-enemy) and keeps the alive self face white", async () => {
    // Fleet-facing contract (shipIcons.ts INK RULE): ally/sunk art faces
    // right, enemy/sunk-enemy is its horizontal mirror — a dead enemy row
    // must render the mirrored sunk-enemy face, not the ally-facing "sunk"
    // one (the panel used to pass "sunk" for EVERY dead row).
    const wrapper = mountPanel({ raw: RAW_SUNK });
    // The dead enemy row carries the dead dressing and the mirrored face;
    // the dead class rides the row wrapper around the named button.
    const enemyBtn = wrapper.find('[data-player-name="EnemyB"]');
    expect(enemyBtn.exists()).toBe(true);
    const enemyRow = enemyBtn.element.closest(".replay-view__postbattle-cell");
    expect(enemyRow?.classList.contains("replay-view__postbattle-cell--dead")).toBe(true);
    expect(
      enemyBtn.find(".replay-view__postbattle-cell-ico img").attributes("src"),
    ).toContain("icon_sunk_enemy_destroyer");
    // Control: the alive self row keeps the white self face — alive rows and
    // the self face are unchanged by the fix.
    const selfBtn = wrapper.find('[data-player-name="AdmiralA"]');
    expect(selfBtn.exists()).toBe(true);
    expect(
      selfBtn.find(".replay-view__postbattle-cell-ico img").attributes("src"),
    ).toContain("icon_white_battleship");
  });
});


/** A never/settle-later promise factory for the watchdog pins. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Minimal StaticReport: one scoreable roster entry joined by the PLAYER
 *  nickname onto the RAW fixture's recorder row (wholeGame 0.62 → "62%"). */
function aiReport(): StaticReport {
  return {
    replayPath: "match.wowsreplay",
    replayId: "match",
    entityId: 1,
    roster: [
      {
        entityId: 1,
        shipId: 101,
        shipClass: "Destroyer",
        fireApplicable: true,
        torpedoApplicable: true,
        name: "ShipA",
        playerName: "AdmiralA",
        teamId: 0,
        isRecorder: true,
        diedAt: null,
        coverage: {
          aliveFrom: 0,
          aliveTo: 600,
          samples: 100,
          gapSeconds: 0,
          completeness: 1,
          gapSegments: [],
        },
        whole: {
          wholeGame: 0.62,
          wholeFire: 0.7,
          wholeMove: 0.55,
          contribution: 0,
          contributionShots: 0,
          torpedo: null,
        },
        outcome: null,
      },
    ],
    timeline: [],
    moments: [],
  } as unknown as StaticReport;
}

describe("PostBattlePanel AI score column", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
    statsPrefsState.value.postbattleAiScore = true;
  });

  /** Mount with the column armed: the capability probe answered ON, the
   *  score switch is on (the default), and a replayPath feeds the fetch.
   *  The immediate watch starts the fetch during setup, so by the first
   *  nextTick the invoke is already in flight. */
  async function mountAiPanel() {
    const capabilities = useCapabilitiesStore();
    capabilities.aiInference = true;
    const wrapper = mount(PostBattlePanel, {
      props: {
        raw: RAW,
        head: null,
        operation: false,
        stream: null,
        replayPath: "match.wowsreplay",
      },
    });
    await nextTick();
    return wrapper;
  }

  it("lands the report and renders the whole-game percentage", async () => {
    vi.mocked(api.decisionStaticReport).mockResolvedValue(aiReport());
    const wrapper = await mountAiPanel();
    expect(api.decisionStaticReport).toHaveBeenCalledExactlyOnceWith("match.wowsreplay", null);
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("62%");
    });
  });

  it("stands the column down when the report never answers, then takes a late cached answer", async () => {
    vi.useFakeTimers();
    const pending = deferred<StaticReport>();
    vi.mocked(api.decisionStaticReport).mockReturnValue(pending.promise);
    const wrapper = await mountAiPanel();
    // In flight: the column renders (its header, spinners in the cells).
    expect(wrapper.text()).toContain(t("replay.postbattle.aiScore"));
    vi.advanceTimersByTime(STATIC_REPORT_READ_TIMEOUT_MS);
    await nextTick();
    // The watchdog bounds the wait: the column stands down instead of
    // spinning forever (the same rule the results pill's stream read got).
    expect(wrapper.text()).not.toContain(t("replay.postbattle.aiScore"));
    // The seq was NOT orphaned by the expiry: the backend caches the scoring
    // pass, so the late answer still lands and upgrades the panel in place.
    pending.resolve(aiReport());
    await nextTick();
    await nextTick();
    expect(wrapper.text()).toContain("62%");
  });

  it("restarts the fetch after the score switch is flipped off mid-flight", async () => {
    vi.useFakeTimers();
    const orphaned = deferred<StaticReport>();
    vi.mocked(api.decisionStaticReport).mockReturnValueOnce(orphaned.promise);
    const wrapper = await mountAiPanel();
    expect(api.decisionStaticReport).toHaveBeenCalledTimes(1);
    // Off mid-flight: the run is orphaned and the state drops to 'idle' —
    // the old aiState gate would have pinned 'loading' here forever.
    statsPrefsState.value.postbattleAiScore = false;
    await nextTick();
    const fresh = deferred<StaticReport>();
    vi.mocked(api.decisionStaticReport).mockReturnValueOnce(fresh.promise);
    statsPrefsState.value.postbattleAiScore = true;
    await nextTick();
    await nextTick();
    // Re-enabling started a FRESH fetch instead of inheriting the wedge.
    expect(api.decisionStaticReport).toHaveBeenCalledTimes(2);
    fresh.resolve(aiReport());
    await nextTick();
    await nextTick();
    expect(wrapper.text()).toContain("62%");
    // The orphaned first answer never patches the panel.
    orphaned.resolve(aiReport());
    await nextTick();
    expect(api.decisionStaticReport).toHaveBeenCalledTimes(2);
  });
});

