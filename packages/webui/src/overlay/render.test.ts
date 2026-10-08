/**
 * Page-level render regression for the stats-LESS chip face, driven the
 * way production drives it: the real main.ts bootstrap against a mocked
 * `window.__TAURI__`, then the Lesta battle payload captured from the
 * 2026-10-08 field logs (3072x1920 client, 6 allies + a 4-vehicle enemy
 * roster of which one row was still visible — the anchor's grid carries
 * the 3 pitch-extended phantom rows the detector legitimately emits for
 * the departed players).
 *
 * Pins the failure surface of the Lesta report ("the overlay never even
 * appeared"): with the stats batch unable to answer — a realm the window
 * URL baked stale, an unreachable API, or lookups disabled outright — the
 * chip is the ONLY thing on screen, and a bare "…" there reads as nothing
 * at all. Every stats-less chip must fall back to the row's NAME.
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
// measured 56 px pitch + 4 enemy rows (1 real + 3 grid-extended).
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
  it("names every row when the stats lookups never answer", async () => {
    handlers.get("wowsp://arena-info")!({ payload: arena });
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(rowChips().length).toBe(10));

    const chips = rowChips();
    const text = chips.map((c) => c.textContent ?? "").join("|");
    // Ally rows: bare nicknames (the clan-tag prefix the game's table
    // already carries stays off the fallback face).
    for (const name of ["dreffk", "Slon731", "rainbowotis", "Object703", "Crawley38", "langyo"]) {
      expect(text).toContain(name);
    }
    // Enemy rows incl. the phantom block — every row identified, nothing
    // renders as the anonymous "…" waiting face.
    expect(text).toContain("Vitia_Minsk");
    expect(text).not.toContain("…");
  });

  it("escapes game-controlled roster names in the fallback face", async () => {
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
});
