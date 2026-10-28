/**
 * Tests for the Tab scoreboard overlay's tier column and live status
 * cells:
 *
 *  - the tier badge renders in its OWN fixed-width column (a centered
 *    cell of its own), so the Roman numeral never shifts the ship name
 *    beside it — the ship cell holds the name only;
 *  - an alive row renders the per-ship combat chips at the playhead —
 *    the gun reload countdown, the just-launched torpedo flash, the fire
 *    dot and the freshest hit pill — exactly what the 3D below-hull card
 *    floats under the ship, and no static 存活/Afloat text anywhere;
 *  - an alive ship with nothing showing renders the dim idle dash;
 *  - advancing the playhead past the activity retires the chips (the
 *    cell re-queries the status index every tick);
 *  - a sunk row keeps the red sunk phrasing with its mm:ss clock and the
 *    dimmed row class.
 */
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import { initLocaleMessages } from "@/i18n";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

// Partial mock: the real module's isTauri (and friends) must survive —
// useLanguage calls it on load; only the transport channel is stubbed.
vi.mock("@/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport")>();
  return { ...actual, transport: { invoke: mocks.invoke } };
});

import type { EntityTrajectory, ShipInfo, VehicleEntry } from "@/api";
import type { ShipStatusIndex } from "./shipStatusModel";

import HoloRosterOverlay from "./HoloRosterOverlay";

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
  mocks.invoke.mockResolvedValue([]);
});

/** A minimal roster entry — the overlay reads id/name/shipId/relation. */
const V = (over: Partial<VehicleEntry>): VehicleEntry =>
  ({ id: 0, name: "", relation: 1, ...over }) as VehicleEntry;

const TRAJ = (entityId: number) => ({ entityId }) as EntityTrajectory;

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

function mountOverlay(over: {
  vehicles?: VehicleEntry[];
  rosterState?: Map<number, { traj: EntityTrajectory | null; deathTime: number | null; maxHp: number | null }>;
  shipStatus?: Map<number, ShipStatusIndex>;
  encyclopedia?: Map<number, ShipInfo>;
  time?: number;
} = {}) {
  setActivePinia(createPinia());
  return mount(HoloRosterOverlay, {
    props: {
      vehicles: over.vehicles ?? [],
      time: over.time ?? 100,
      rosterState: over.rosterState ?? new Map(),
      kills: new Map(),
      stats: new Map(),
      encyclopedia: over.encyclopedia ?? new Map<number, ShipInfo>(),
      shipStatus: over.shipStatus ?? new Map(),
    },
  });
}

describe("HoloRosterOverlay tier column", () => {
  it("renders the tier badge in its own column, name cell holding only the name", () => {
    const wrapper = mountOverlay({
      vehicles: [V({ id: 1, name: "alpha", shipId: 4286, shipName: "fallback" })],
      encyclopedia: new Map([
        // Only the fields the identity chain reads; the rest of the
        // encyclopedia shape is irrelevant here.
        [4286, { id: 4286, name: "Izumo", tier: 9, type: "Battleship" } as unknown as ShipInfo],
      ]),
    });
    // The dedicated colgroup share + centered cells exist.
    expect(wrapper.find(".holo-roster__col--tier").exists()).toBe(true);
    const tierCell = wrapper.find(".holo-roster__td--tier");
    expect(tierCell.exists()).toBe(true);
    expect(tierCell.text()).toBe("IX");
    // The ship cell carries ONLY the name — the numeral no longer shifts it.
    const shipCell = wrapper.find(".holo-roster__ship");
    expect(shipCell.text()).toBe("Izumo");
    expect(shipCell.element.querySelector("b")).toBeNull();
  });
});

describe("HoloRosterOverlay live status cells", () => {
  const statusIndex = IDX({
    gun: [
      { t: 90, ammo: "HE" },
      { t: 118, ammo: "HE" },
    ],
    torp: [{ t: 99.5 }],
    hits: [{ t: 99.2, kind: "shell", ammo: "AP", dmg: 5320 }],
    dots: [{ kind: "fire", t0: 92, lastTick: 118, base: 30 }],
  });
  const state = new Map([
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
    // The static 存活/Afloat label is gone — alive rows never show it.
    expect(wrapper.find(".holo-roster__afloat").exists()).toBe(false);
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
