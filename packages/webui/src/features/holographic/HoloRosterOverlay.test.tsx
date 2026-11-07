/**
 * Tests for the Tab scoreboard overlay:
 *
 *  - the tier numeral LEADS the ship name in the ship cell (left-aligned,
 *    same type size): the old standalone tier column is gone;
 *  - the identity line before the nickname carries the dim [clan] prefix,
 *    the per-side division tag (組隊A/B) and the player-marker tag in the
 *    marker's own ink;
 *  - an alive row renders the per-ship combat chips at the playhead —
 *    the gun reload countdown, the just-launched torpedo flash, the fire
 *    dot and the freshest hit pill — exactly what the 3D below-hull card
 *    floats under the ship, and no static 存活/Afloat text anywhere;
 *  - hit pills are MERGED by damage source: one attacker's impacts arrive
 *    as a single pill with the summed damage, a ×N suffix and a source
 *    hint naming the attacker;
 *  - the icon column carries the top-scorebar-style HP mini bar BESIDE the
 *    class marker for afloat rows with an HP stream, team-tinted, and none
 *    for sunk rows;
 *  - an alive ship with nothing showing renders the dim idle dash;
 *  - advancing the playhead past the activity retires the chips (the
 *    cell re-queries the status index every tick);
 *  - a sunk row keeps the red sunk phrasing with its mm:ss clock and the
 *    dimmed row class;
 *  - the AI analysis layer adds the four decision-score columns (with the
 *    continuous lamp colour), the board modifier and the footer strip.
 */
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { initLocaleMessages, t as i18nT } from "@/i18n";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

// Partial mock: the real module's isNative (and friends) must survive —
// useLanguage calls it on load; only the transport channel is stubbed.
vi.mock("@/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport")>();
  return { ...actual, transport: { invoke: mocks.invoke } };
});

import type {
  EntityTrajectory,
  ShipInfo,
  ShipScoreEntry,
  ShipScoreReport,
  ShipScoreSample,
  VehicleEntry,
} from "@/api";
import type { RosterStat } from "@/composables/useRosterStats";
import { fakeAs } from "@/test-utils/fakes";
import type { ShipStatusIndex } from "./shipStatusModel";
import { aiLampColor } from "./rosterScore";

import HoloRosterOverlay from "./HoloRosterOverlay";

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
  mocks.invoke.mockResolvedValue([]);
});

/** A minimal roster entry — the overlay reads id/name/shipId/relation. */
const V = (over: Partial<VehicleEntry>): VehicleEntry =>
  ({ id: 0, name: "", relation: 1, ...over }) as VehicleEntry;

const TRAJ = (
  entityId: number,
  hpSamples?: { time: number; value: number }[],
): EntityTrajectory => ({ entityId, hpSamples }) as EntityTrajectory;

type RosterStateMap = Map<
  number,
  { traj: EntityTrajectory | null; deathTime: number | null; maxHp: number | null }
>;

/** Hand-built status index — the shapes shipStatusModel produces. */
const IDX = (over: Partial<ShipStatusIndex>): ShipStatusIndex => ({
  gun: [],
  torp: [],
  repairs: [],
  smokes: [],
  hits: [],
  dots: [],
  ...over,
});

const SAMPLE = (t: number, inst: number, confidence: number): ShipScoreSample => ({
  t,
  inst,
  fire: 0.5,
  fired: true,
  fireProb: 0.5,
  hpLost: 100,
  move: 0.2,
  confidence,
});

const SCORE_ENTRY = (entityId: number, over: Partial<ShipScoreEntry> = {}): ShipScoreEntry => ({
  entityId,
  shipId: null,
  shipClass: null,
  fireApplicable: true,
  teamId: 0,
  isRecorder: false,
  wholeGame: 0.62,
  wholeFire: 0.5,
  wholeMove: 0.7,
  contribution: 84_234,
  contributionShots: 3,
  samples: [SAMPLE(96, 0.75, 0.8)],
  outcome: { status: "missing" },
  ...over,
});

const SCORE_REPORT = (perShip: ShipScoreEntry[]): ShipScoreReport => ({
  replayId: "test-replay",
  mapName: null,
  gameMode: null,
  replayVersion: null,
  perShip,
  modelSources: { fire: "test-fire", moveModel: "test-move" },
  stats: {
    shipsScored: perShip.length,
    rowsScored: 120,
    rowsCanFire: 30,
    rowsFired: 20,
    rowsNoMove: 70,
  },
});

function mountOverlay(over: {
  vehicles?: VehicleEntry[];
  rosterState?: RosterStateMap;
  shipStatus?: Map<number, ShipStatusIndex>;
  encyclopedia?: Map<number, ShipInfo>;
  stats?: Map<string, RosterStat>;
  prebattle?: Map<string, number>;
  time?: number;
  aiOn?: boolean;
  scoreReport?: ShipScoreReport | null;
  scoreLoading?: boolean;
} = {}) {
  setActivePinia(createPinia());
  return mount(HoloRosterOverlay, {
    props: {
      vehicles: over.vehicles ?? [],
      time: over.time ?? 100,
      rosterState: over.rosterState ?? new Map(),
      kills: new Map(),
      stats: over.stats ?? new Map(),
      encyclopedia: over.encyclopedia ?? new Map<number, ShipInfo>(),
      shipStatus: over.shipStatus ?? new Map(),
      prebattle: over.prebattle ?? new Map(),
      aiOn: over.aiOn ?? false,
      scoreReport: over.scoreReport ?? null,
      scoreLoading: over.scoreLoading ?? false,
    },
  });
}

describe("HoloRosterOverlay ship identity cell", () => {
  it("leads the ship name with the tier numeral in the SAME ship cell", () => {
    const wrapper = mountOverlay({
      vehicles: [V({ id: 1, name: "alpha", shipId: 4286, shipName: "fallback" })],
      encyclopedia: new Map([
        // Only the fields the identity chain reads; the rest of the
        // encyclopedia shape is irrelevant here.
        [4286, fakeAs<ShipInfo>({ shipId: 4286, name: "Izumo", tier: 9, type: "Battleship" })],
      ]),
    });
    // The standalone tier column is gone (colgroup share + header + cell).
    expect(wrapper.find(".holo-roster__col--tier").exists()).toBe(false);
    expect(wrapper.find(".holo-roster__td--tier").exists()).toBe(false);
    expect(wrapper.find("th.holo-roster__th--tier").exists()).toBe(false);
    // The tier numeral and the ship name share ONE left-aligned cell, the
    // numeral coming first on the same line.
    const shipCell = wrapper.find(".holo-roster__td--ship");
    expect(shipCell.exists()).toBe(true);
    const tier = shipCell.find(".holo-roster__tier");
    const name = shipCell.find(".holo-roster__ship");
    expect(tier.text()).toBe("IX");
    expect(name.text()).toBe("Izumo");
    // No bold/oversized treatment — the numeral is a plain text run now.
    expect(tier.element.tagName.toLowerCase()).not.toBe("b");
    const kids = shipCell.element.children;
    expect(kids[0].classList.contains("holo-roster__tier")).toBe(true);
    expect(kids[1].classList.contains("holo-roster__ship")).toBe(true);
  });
});

describe("HoloRosterOverlay live status cells", () => {
  const statusIndex = IDX({
    gun: [
      { t: 90, ammo: "HE" },
      { t: 118, ammo: "HE" },
    ],
    torp: [{ t: 99.5 }],
    hits: [{ t: 99.2, kind: "shell", ammo: "AP", dmg: 5320, sourceId: 99 }],
    dots: [{ kind: "fire", t0: 92, lastTick: 118, base: 30 }],
  });
  const state: RosterStateMap = new Map([
    [1, { traj: TRAJ(101), deathTime: null, maxHp: null }],
    [2, { traj: TRAJ(102), deathTime: null, maxHp: null }],
    [3, { traj: TRAJ(103), deathTime: 65, maxHp: null }],
  ]);
  const vehicles = [
    V({ id: 1, name: "firing", shipId: undefined, shipName: "Firer" }),
    V({ id: 2, name: "idle", shipId: undefined, shipName: "Idler" }),
    V({ id: 3, name: "sunk", shipId: undefined, shipName: "Sinker" }),
  ];

  it("shows the combat chips (reload countdown, launch flash, fire dot, hit pill)", () => {
    const wrapper = mountOverlay({ vehicles, rosterState: state, shipStatus: new Map([[101, statusIndex]]) });
    const chips = wrapper.findAll(".holo-roster__st-chip").map((c) => c.classes());
    // Gun in cooldown draining toward its next salvo (118 − 100 = 18 s),
    // torpedo launch still flashing (no countdown yet), fire dot ticking.
    expect(chips).toContainEqual(["holo-roster__st-chip", "is-gun", "is-cooldown"]);
    expect(chips).toContainEqual(["holo-roster__st-chip", "is-torp", "is-flash"]);
    expect(chips).toContainEqual(["holo-roster__st-chip", "is-fire"]);
    const firingRow = wrapper.find(".holo-roster__td--status");
    expect(firingRow.text()).toContain("18"); // gun reload seconds
    expect(firingRow.text()).toContain("22"); // fire seconds (92 + 30 − 100)
    expect(firingRow.text()).toContain("-5,320"); // hit pill damage
    // A lone impact is not a merged pill — no ×N suffix.
    expect(wrapper.find(".holo-roster__st-count").exists()).toBe(false);
    // The static 存活/Afloat label is gone — alive rows never show it.
    expect(wrapper.find(".holo-roster__afloat").exists()).toBe(false);
  });

  it("merges hits from one damage source into a ×N pill and names the attacker", () => {
    const merged = IDX({
      hits: [
        { t: 98.2, kind: "shell", ammo: "AP", dmg: 3000, sourceId: 102 },
        { t: 99.4, kind: "shell", ammo: "AP", dmg: 4300, sourceId: 102 },
        { t: 99.6, kind: "torpedo", ammo: null, dmg: 1100, sourceId: 103 },
      ],
    });
    const wrapper = mountOverlay({
      vehicles: [
        V({ id: 1, name: "victim", shipName: "Victim" }),
        V({ id: 2, name: "attacker", shipName: "Attacker" }),
      ],
      rosterState: new Map([
        [1, { traj: TRAJ(101), deathTime: null, maxHp: null }],
        [2, { traj: TRAJ(102), deathTime: null, maxHp: null }],
      ]),
      shipStatus: new Map([[101, merged]]),
    });
    // Groups arrive newest-first: the lone torpedo hit leads, the merged
    // two-shell group follows (different damage source = its own pill).
    const pills = wrapper.findAll(".holo-roster__st-hit");
    expect(pills).toHaveLength(2);
    expect(pills[0].text()).toContain("-1,100");
    expect(pills[0].find(".holo-roster__st-count").exists()).toBe(false);
    const mergedPill = pills[1];
    expect(mergedPill.text()).toContain("-7,300"); // summed damage
    expect(mergedPill.find(".holo-roster__st-count").text()).toBe("×2");
    // The tooltip resolves the source through the roster entity join.
    expect(mergedPill.attributes("data-hint")).toBe(
      i18nT("replay.roster.hitSource", { name: "attacker", n: 2 }),
    );
  });

  it("shows the idle dash for an alive ship with nothing showing", () => {
    const wrapper = mountOverlay({ vehicles, rosterState: state, shipStatus: new Map([[101, statusIndex]]) });
    const idles = wrapper.findAll(".holo-roster__idle");
    // Ship 2 is alive but its entity has no status entry; ship 3's row is
    // sunk (asserted below), so exactly one dash.
    expect(idles).toHaveLength(1);
    expect(idles[0].text()).toBe("—");
  });

  it("keeps the sunk phrasing (mm:ss) and dimmed row for dead ships", () => {
    const wrapper = mountOverlay({ vehicles, rosterState: state, shipStatus: new Map([[101, statusIndex]]) });
    const sunkRow = wrapper.find(".holo-roster__row--dead");
    expect(sunkRow.exists()).toBe(true);
    expect(sunkRow.find(".holo-roster__sunk").text()).toContain("01:05");
    expect(sunkRow.find(".holo-roster__st").exists()).toBe(false);
  });

  it("re-queries the chips as the playhead advances", async () => {
    const wrapper = mountOverlay({ vehicles, rosterState: state, shipStatus: new Map([[101, statusIndex]]) });
    expect(wrapper.find(".holo-roster__st-chip.is-gun").exists()).toBe(true);
    // At 119.5 s the 118 salvo's flash window is over and there is no
    // following salvo to count down to; the fire dot still burns (2.5 s).
    await wrapper.setProps({ time: 119.5 });
    expect(wrapper.find(".holo-roster__st-chip.is-gun").exists()).toBe(false);
    expect(wrapper.find(".holo-roster__st-chip.is-fire").text()).toContain("2.5");
    // Past the dot's countdown the cell collapses to the idle dash.
    await wrapper.setProps({ time: 125 });
    expect(wrapper.find(".holo-roster__st").exists()).toBe(false);
    expect(wrapper.find(".holo-roster__idle").exists()).toBe(true);
  });
});

describe("HoloRosterOverlay HP mini bar", () => {
  it("renders a team-tinted fill BESIDE the icon of an afloat row", () => {
    const wrapper = mountOverlay({
      vehicles: [V({ id: 1, name: "hurt", relation: 0 })],
      rosterState: new Map([
        [
          1,
          {
            traj: TRAJ(101, [
              { time: 0, value: 10_000 },
              { time: 100, value: 2_500 },
            ]),
            deathTime: null,
            maxHp: 10_000,
          },
        ],
      ]),
    });
    const bar = wrapper.find(".holo-roster__hp");
    expect(bar.exists()).toBe(true);
    expect(bar.classes()).toContain("holo-roster__hp--ally");
    expect(bar.attributes("style")).toContain("--hp-pct: 25%");
    // Beside the icon: the bar is the marker's SIBLING inside the icon
    // stack (right of it), never a strip under it and never in the name cell.
    const iconCell = wrapper.find(".holo-roster__td--icon");
    const stack = iconCell.find(".holo-roster__icon");
    expect(stack.exists()).toBe(true);
    const kids = stack.element.children;
    expect(kids).toHaveLength(2);
    expect(kids[0].classList.contains("holo-roster__hp")).toBe(false);
    expect(kids[1].classList.contains("holo-roster__hp")).toBe(true);
    expect(wrapper.find(".holo-roster__td--name .holo-roster__hp").exists()).toBe(false);
  });

  it("tints enemy fills red", () => {
    const wrapper = mountOverlay({
      vehicles: [V({ id: 2, name: "foe", relation: 2 })],
      rosterState: new Map([
        [2, { traj: TRAJ(102, [{ time: 0, value: 1_000 }]), deathTime: null, maxHp: 4_000 }],
      ]),
    });
    const bar = wrapper.find(".holo-roster__hp");
    expect(bar.classes()).toContain("holo-roster__hp--enemy");
    expect(bar.attributes("style")).toContain("--hp-pct: 25%");
  });

  it("renders no bar for sunk rows or rows without HP data", () => {
    const wrapper = mountOverlay({
      vehicles: [V({ id: 3, name: "sunk" }), V({ id: 4, name: "nostream" })],
      rosterState: new Map([
        [3, { traj: TRAJ(103, [{ time: 0, value: 1_000 }]), deathTime: 60, maxHp: 4_000 }],
        [4, { traj: null, deathTime: null, maxHp: null }],
      ]),
    });
    expect(wrapper.find(".holo-roster__hp").exists()).toBe(false);
    expect(wrapper.find(".holo-roster__row--dead").exists()).toBe(true);
  });
});

describe("HoloRosterOverlay identity tags", () => {
  const identityState: RosterStateMap = new Map([
    [1, { traj: TRAJ(101), deathTime: null, maxHp: null }],
    [2, { traj: TRAJ(102), deathTime: null, maxHp: null }],
    [3, { traj: TRAJ(103), deathTime: null, maxHp: null }],
    [4, { traj: TRAJ(201), deathTime: null, maxHp: null }],
  ]);

  it("renders the dim [clan] prefix before the nickname", () => {
    const wrapper = mountOverlay({
      vehicles: [V({ id: 1, name: "alpha", shipName: "Alpha" })],
      rosterState: identityState,
      stats: new Map([["alpha", fakeAs<RosterStat>({ clanTag: "TST" })]]),
    });
    const clan = wrapper.find(".holo-roster__clan");
    expect(clan.text()).toBe("[TST]");
    const identity = wrapper.find(".holo-roster__identity");
    const kids = [...identity.element.children];
    // Order: [clan] first, nickname last.
    expect(kids[0].classList.contains("holo-roster__clan")).toBe(true);
    expect(kids[kids.length - 1].classList.contains("holo-roster__nick")).toBe(true);
  });

  it("letters divisions per side and tags only division members", () => {
    const wrapper = mountOverlay({
      vehicles: [
        V({ id: 1, name: "alpha", shipName: "Alpha" }),
        V({ id: 2, name: "beta", shipName: "Beta" }),
        V({ id: 3, name: "solo", shipName: "Solo" }),
        V({ id: 4, name: "foe", relation: 2, shipName: "Foe" }),
      ],
      rosterState: identityState,
      prebattle: new Map([
        ["alpha", 7],
        ["beta", 7],
        ["foe", 7],
        ["solo", 0],
      ]),
    });
    const letterA = i18nT("replay.postbattle.divisionTag", { letter: "A" });
    const tags = wrapper.findAll(".division-tag");
    // alpha + beta (ally side, division 7 = A) and foe (enemy side, ALSO A:
    // each table letters its own display order independently).
    expect(tags).toHaveLength(3);
    expect(tags.every((tag) => tag.text() === letterA)).toBe(true);
    // The solo row (prebattle 0 / absent) carries no division tag.
    const soloRow = wrapper.findAll("tbody tr").find((row) => row.text().includes("solo"))!;
    expect(soloRow.find(".division-tag").exists()).toBe(false);
  });

  it("renders the marker tag in the marker's own ink, marked players only", async () => {
    // The markers store loads through the mocked transport: seed the batch
    // with one red-marked nickname.
    mocks.invoke.mockResolvedValue([
      { nickname: "marked", color: "red", accountId: null, note: null },
    ]);
    const wrapper = mountOverlay({
      vehicles: [
        V({ id: 1, name: "marked", shipName: "Marked" }),
        V({ id: 2, name: "clean", shipName: "Clean" }),
      ],
      rosterState: identityState,
    });
    await flushPromises();
    await nextTick();
    const tag = wrapper.find(".holo-roster__marker-tag");
    expect(tag.exists()).toBe(true);
    expect(tag.text()).toBe(i18nT("settings.markersColorRed"));
    // The stamp face carries the marker's own ink (red #e5484d), not the
    // division yellow.
    expect(tag.attributes("style") ?? "").toMatch(/e5484d|229, 72, 77/i);
    // Only marked players get the tag.
    const cleanRow = wrapper.findAll("tbody tr").find((row) => row.text().includes("clean"))!;
    expect(cleanRow.find(".holo-roster__marker-tag").exists()).toBe(false);
    mocks.invoke.mockResolvedValue([]);
  });
});

describe("HoloRosterOverlay AI decision-score columns", () => {
  const state: RosterStateMap = new Map([
    [1, { traj: TRAJ(101), deathTime: null, maxHp: null }],
    [2, { traj: TRAJ(102), deathTime: null, maxHp: null }],
  ]);
  const vehicles = [
    V({ id: 1, name: "scored", shipName: "Scored" }),
    V({ id: 2, name: "unscored", shipName: "Unscored" }),
  ];

  it("renders contribution / whole / instant / lamp only while the layer is on", () => {
    const off = mountOverlay({ vehicles, rosterState: state });
    expect(off.find(".holo-roster__lamp").exists()).toBe(false);
    expect(off.find(".holo-map__roster-board--ai").exists()).toBe(false);
    expect(off.find(".holo-map__roster-ai-foot").exists()).toBe(false);
    expect(off.text()).not.toContain(i18nT("replay.scores.contribution"));

    const on = mountOverlay({
      vehicles,
      rosterState: state,
      aiOn: true,
      scoreReport: SCORE_REPORT([SCORE_ENTRY(101)]),
    });
    expect(on.find(".holo-map__roster-board--ai").exists()).toBe(true);
    expect(on.text()).toContain(i18nT("replay.scores.contribution"));
    expect(on.text()).toContain(i18nT("replay.scores.whole"));
    expect(on.text()).toContain(i18nT("replay.scores.instant"));
    // The scored row: contribution 84234 -> 84.2k, wholeGame .62 -> 62,
    // sample at t=96 inst .75 -> 75.
    const rowFor = (name: string) =>
      on.findAll("tbody tr").find((row) => row.text().includes(name))!;
    // Cells: icon, player, ship, (no kills), contrib, whole, instant, lamp,
    // status — the tier column is gone, the ship cell holds tier + name.
    const scored = rowFor("scored").findAll("td");
    expect(scored[3].text()).toBe("84.2k");
    expect(scored[4].text()).toBe("62");
    expect(scored[5].text()).toBe("75");
    expect(scored[5].attributes("data-hint")).toBe(
      i18nT("replay.scores.confidence") + " 80",
    );
    // Continuous lamp colour: hue 0.75 * 120 = 90.0 (red→yellow→green).
    const lamp = scored[6].find(".holo-roster__lamp");
    expect(lamp.exists()).toBe(true);
    expect(lamp.classes()).not.toContain("holo-roster__lamp--empty");
    expect(lamp.attributes("style") ?? "").toContain(aiLampColor(0.75));
    // The unscored row (no report entry): dim dash everywhere, empty lamp.
    const unscored = rowFor("unscored").findAll("td");
    expect(unscored[3].text()).toBe("—");
    expect(unscored[5].text()).toBe("—");
    expect(unscored[6].find(".holo-roster__lamp--empty").exists()).toBe(true);
  });

  it("marks an uncovered class as not covered instead of a fire score", () => {
    const wrapper = mountOverlay({
      vehicles,
      rosterState: state,
      aiOn: true,
      scoreReport: SCORE_REPORT([
        SCORE_ENTRY(101, {
          shipClass: "AirCarrier",
          fireApplicable: false,
          wholeFire: null,
          contribution: null,
          contributionShots: null,
        }),
      ]),
    });
    const scored = wrapper
      .findAll("tbody tr")
      .find((row) => row.text().includes("scored"))!
      .findAll("td");
    // Contribution stays a dash — never a 0 placeholder — with a hint
    // explaining the class sits outside the fire model's label space.
    expect(scored[3].text()).toBe("—");
    expect(scored[3].attributes("data-hint")).toBe(
      i18nT("replay.report.classNotCovered"),
    );
    // The fire slot of the whole-game hint says "not covered", not the
    // trivial "no can-fire rows" phrasing.
    const hint = scored[4].attributes("data-hint") ?? "";
    expect(hint).toContain(i18nT("replay.scores.fireNotCovered"));
    expect(hint).not.toContain(i18nT("replay.scores.noFire"));
    // The whole-game number itself still renders (movement-only agreement).
    expect(scored[4].text()).toBe("62");
  });

  it("footer carries the disclaimer, the legend and the samples line", () => {
    const wrapper = mountOverlay({
      vehicles,
      rosterState: state,
      aiOn: true,
      scoreReport: SCORE_REPORT([SCORE_ENTRY(101)]),
    });
    const foot = wrapper.find(".holo-map__roster-ai-foot");
    expect(foot.exists()).toBe(true);
    expect(foot.text()).toContain(i18nT("replay.scores.disclaimer"));
    expect(foot.text()).toContain(i18nT("replay.moveAdvice.holdMark"));
    expect(foot.text()).toContain(i18nT("replay.moveAdvice.second"));
    expect(foot.text()).toContain(
      i18nT("replay.scores.samples", { ships: 1, rows: 120 }),
    );
  });

  it("footer shows loading, then no-data, until a report lands", async () => {
    const wrapper = mountOverlay({ vehicles, rosterState: state, aiOn: true, scoreLoading: true });
    expect(wrapper.find(".holo-map__roster-ai-foot").text()).toContain(
      i18nT("replay.moveAdvice.loading"),
    );
    await wrapper.setProps({ scoreLoading: false });
    expect(wrapper.find(".holo-map__roster-ai-foot").text()).toContain(
      i18nT("replay.scores.noData"),
    );
  });
});
