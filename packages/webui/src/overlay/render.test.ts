/**
 * Page-level render regression for the overlay's row list, driven the way
 * production drives it: the real main.ts bootstrap against a mocked
 * `window.__TAURI__`, then the Lesta battle payload captured from the
 * 2026-10-08 field logs (3072x1920 client, 6 allies + a 4-vehicle enemy
 * roster — the anchor's grid carries exactly those 10 rows).
 *
 * Pins the two-column row contract (see rowFace): every player renders ONE
 * line — a stat cell against the table's edge and a NAME cell beside it
 * carrying the game's own '[TAG]nickname' display string — where the old
 * per-row chips rendered anonymous faces (a "…" waiting face, slash-joined
 * candidate ranges) and needed per-row attribution to place. The name
 * column is also the stats-outage visibility: with the batch unable to
 * answer (a realm the window URL baked stale, an unreachable API, or
 * lookups disabled), the numbers empty but the rows still name every
 * player.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

const arena = {
  matchGroup: "pvp",
  dateTime: "20261008_100355",
  scenario: null,
  eventType: null,
  vehicles: [
    { id: 1, name: "[TENET]dreffk", relation: 1, shipId: 1 },
    { id: 2, name: "[WMF-1]Slon731", relation: 1, shipId: 2 },
    { id: 3, name: "[DORO]rainbowotis", relation: 1, shipId: 3 },
    { id: 4, name: "Object703", relation: 1, shipId: 4 },
    { id: 5, name: "[RURC]Crawley38", relation: 1, shipId: 5 },
    { id: 6, name: "langyo", relation: 0, shipId: 6 },
    { id: 7, name: "Vitia_Minsk", relation: 2, shipId: 7 },
    { id: 8, name: "enemy_two", relation: 2, shipId: 8 },
    { id: 9, name: "enemy_three", relation: 2, shipId: 9 },
    { id: 10, name: "enemy_four", relation: 2, shipId: 10 },
  ],
};

// The production anchor: overlay "3072x911 at (0,140)", 6 ally rows at the
// measured 56 px pitch + 4 enemy rows.
const anchor = {
  gameRect: { x: 0, y: 0, width: 3072, height: 1920 },
  overlayRect: { x: 0, y: 140, width: 3072, height: 911 },
  rosterRect: { x: 420, y: 91, width: 2208, height: 729 },
  rowCenters: [173, 229, 285, 342, 398, 454, 175, 231, 287, 343],
  teamSplit: 0.505,
  tableDetected: true,
  rowAlive: Array(10).fill(true),
  rosterMode: "passive",
};

const rowChips = (): HTMLElement[] =>
  // The intel summary cards share the overlay-chip base class; the row
  // chips are the ones carrying a side modifier only.
  [...document.querySelectorAll<HTMLElement>(".overlay-chip")].filter(
    (el) => !el.classList.contains("overlay-chip--intel"),
  );

const nameOf = (chip: HTMLElement): string =>
  chip.querySelector(".overlay-chip__name")?.textContent ?? "";

beforeAll(async () => {
  vi.stubGlobal("__TAURI__", {
    core: {
      invoke: vi.fn(async (cmd: string) => {
        // Every lookup silently fails / is disabled (the broken-realm
        // production shape): the page must stay informative anyway.
        if (cmd === "read_temp_arena_info") return null;
        if (cmd.startsWith("lookup_")) return [];
        return null;
      }),
    },
    event: {
      listen: vi.fn(async (ev: string, h: Handler) => {
        handlers.set(ev, h);
        return () => handlers.delete(ev);
      }),
    },
  });
  await import("./main");
  await vi.waitFor(() => expect(handlers.has("wowsp://overlay-anchor")).toBe(true));
});

describe("overlay page render", () => {
  it("renders one named line per player when the stats lookups never answer", async () => {
    handlers.get("wowsp://arena-info")!({ payload: arena });
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(rowChips().length).toBe(10));

    const chips = rowChips();
    const text = chips.map((c) => c.textContent ?? "").join("|");
    // Ally rows: the game's own '[TAG]nickname' display string (the roster
    // carries its tags — the row list shows them verbatim).
    for (const name of [
      "[TENET]dreffk",
      "[WMF-1]Slon731",
      "[DORO]rainbowotis",
      "Object703",
      "[RURC]Crawley38",
      "langyo",
    ]) {
      expect(text).toContain(name);
    }
    // Enemy rows — every row identified, nothing renders as the anonymous
    // "…" waiting face.
    expect(text).toContain("Vitia_Minsk");
    expect(text).not.toContain("…");
    // Every row carries the two columns: a stat cell (a muted dash with no
    // stats landed) and a name cell beside it.
    for (const chip of chips) {
      expect(chip.querySelectorAll(".overlay-chip__stat")).toHaveLength(1);
      expect(chip.querySelectorAll(".overlay-chip__name")).toHaveLength(1);
      expect(chip.querySelector(".overlay-chip__stat")!.textContent).toBe("—");
    }
  });

  it("escapes game-controlled roster names in the name column", async () => {
    handlers.get("wowsp://arena-info")!({
      payload: {
        ...arena,
        vehicles: [{ id: 1, name: "<b>bold&</b>", relation: 0, shipId: 1 }],
      },
    });
    handlers.get("wowsp://overlay-anchor")!({
      payload: { ...anchor, rowCenters: [173], rowAlive: [true] },
    });
    await vi.waitFor(() => expect(rowChips().length).toBe(1));

    const chips = rowChips();
    // The name renders as TEXT (no injected <b> element).
    expect(chips[0]!.querySelectorAll("b")).toHaveLength(0);
    expect(chips[0]!.textContent).toContain("<b>bold&</b>");
  });

  it("re-sorts by the trusted sunk set and flags the sunk row", async () => {
    // A sink transition the solver NAMED (row index 0 of the ally pre-sink
    // alive order): the next render's ally list splits [alive] ++ [sunk] —
    // the game's own regroup — and flags the victim. The anchor's ally
    // block ends with one sunk row (the blockwise shape), so the reconcile
    // agrees and the set stays trusted.
    handlers.get("wowsp://arena-info")!({ payload: arena });
    handlers.get("wowsp://sink-attrib")!({ payload: { allyRows: [0], enemyRows: [] } });
    handlers.get("wowsp://overlay-anchor")!({
      payload: {
        ...anchor,
        rowAlive: [true, true, true, true, true, false, true, true, true, true],
      },
    });
    await vi.waitFor(() => expect(rowChips().length).toBe(10));

    const chips = rowChips();
    const allyNames = chips.slice(0, 6).map(nameOf);
    // The believed order here is the offline WG string-key order over the
    // unknown ships: all segments tie, so the '[TAG]name' display strings
    // decide byte-wise ('O' < '[' < lowercase; tags by their bracket
    // letter) — Object703, the first of it, is the victim index [0] named
    // by the solver and moves to the ally block's tail.
    expect(allyNames).toEqual([
      "[DORO]rainbowotis",
      "[RURC]Crawley38",
      "[TENET]dreffk",
      "[WMF-1]Slon731",
      "langyo",
      "Object703",
    ]);
    expect(chips[5]!.classList.contains("overlay-chip--sunk")).toBe(true);
    expect(
      chips.slice(0, 5).some((c) => c.classList.contains("overlay-chip--sunk")),
    ).toBe(false);
  });
});
