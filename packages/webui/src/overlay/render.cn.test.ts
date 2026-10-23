/**
 * Page-level render regression for the CN (ship-name-order) realm's
 * exact-grade release (2026-10-18): boots the REAL main.ts under
 * `?realm=cn` the way production's window URL bakes the realm, then
 * drives the plugin-telemetry lifecycle of the name column.
 *
 * The CN road to "exact" is the calibrated name-order arrangement, not
 * the sort keys (the CN HUD never renders key order): full per-side
 * coverage of the probe-bridged localized ship NAMES (telemetry
 * shipNames) grades the side exact and drops its name column; a side
 * missing one name falls back to the inference (its names return —
 * game-true and inferred rows never interleave); a stale stream clears
 * the names wholesale and every side's names return.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

const arena = {
  matchGroup: "pvp",
  dateTime: "20261018_cn_exact",
  scenario: null,
  eventType: null,
  vehicles: [
    { id: 1, name: "耿鬼", relation: 1, shipId: 1 },
    { id: 2, name: "名字不长不足以让联盟看到", relation: 1, shipId: 1 },
    { id: 3, name: "槐序二十七", relation: 1, shipId: 3 },
    { id: 4, name: "红男爵A", relation: 1, shipId: 4 },
    { id: 5, name: "青春北风寒", relation: 1, shipId: 5 },
    { id: 6, name: "langyo", relation: 0, shipId: 6 },
    { id: 7, name: "敌方一", relation: 2, shipId: 7 },
    { id: 8, name: "敌方二", relation: 2, shipId: 8 },
    { id: 9, name: "敌方三", relation: 2, shipId: 9 },
    { id: 10, name: "敌方四", relation: 2, shipId: 10 },
  ],
};

// The render.test.ts anchor geometry: 6 ally rows + 4 enemy rows.
const anchor = {
  gameRect: { x: 0, y: 0, width: 3072, height: 1920 },
  overlayRect: { x: 0, y: 140, width: 3072, height: 911 },
  rosterRect: { x: 420, y: 91, width: 2208, height: 729 },
  rowCenters: [173, 229, 285, 342, 398, 454, 175, 231, 287, 343],
  teamSplit: 0.505,
  tableDetected: true,
  rowAlive: Array(10).fill(true),
  rosterMode: "plugin",
};

const rowChips = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>(".overlay-chip")].filter(
    (el) =>
      !el.classList.contains("overlay-chip--intel") &&
      !el.classList.contains("overlay-chip--head"),
  );

beforeAll(async () => {
  // The realm the production window URL bakes: main.ts reads it once at
  // import, so it must be in place BEFORE the dynamic import below.
  window.history.replaceState(null, "", "/?realm=cn");
  vi.stubGlobal("__TAURI__", {
    core: {
      invoke: vi.fn(async (cmd: string) => {
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

describe("overlay page render (CN realm)", () => {
  it("grades exact on full client ship-name coverage and degrades per side", async () => {
    handlers.get("wowsp://arena-info")!({ payload: arena });
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(rowChips().length).toBe(10));
    // The inference face: every row carries its name cell.
    expect(document.querySelectorAll(".overlay-chip__name").length).toBe(10);

    const alive = Object.fromEntries(arena.vehicles.map((v) => [v.name, true]));
    const fullNames = Object.fromEntries(
      arena.vehicles.map((v) => [v.name, `船_${v.shipId}`]),
    );
    // Full per-side client ship-name coverage (both sides): the calibrated
    // arrangement's inputs are the rendered strings — every side grades
    // exact and drops its name column. No sort keys needed: CN never
    // renders key order.
    handlers.get("wowsp://ingame-telemetry")!({
      payload: {
        t: Date.now(),
        battle: "cn_exact",
        players: alive,
        shipNames: fullNames,
      },
    });
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".overlay-chip__name").length).toBe(0),
    );
    expect(rowChips()).toHaveLength(10);

    // One ally name missing = partial coverage on the ALLY side only: the
    // side falls back to the inference and carries its names again, while
    // the still-covered enemy side stays exact and nameless.
    const partialNames = { ...fullNames };
    delete partialNames["langyo"];
    handlers.get("wowsp://ingame-telemetry")!({
      payload: {
        t: Date.now(),
        battle: "cn_exact",
        players: alive,
        shipNames: partialNames,
      },
    });
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".overlay-chip__name").length).toBe(6),
    );

    // A stale stream (the plugin died) clears the names wholesale — every
    // side returns to the inference and its names.
    handlers.get("wowsp://ingame-telemetry")!({
      payload: { t: 1, battle: "cn_exact", players: alive, shipNames: partialNames },
    });
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".overlay-chip__name").length).toBe(10),
    );
  });
});
