/**
 * Page-level regression for the CN client's row list on the SINGLE-team
 * table (realm 'cn', anchor team_split exactly 1.0 — the co-op /
 * operation layout): that table never re-sorts mid-battle — sunk rows
 * dim IN PLACE at their battle-start positions (observed on the real
 * 2026-10-07 co-op Tab capture: a 5-dead ally block still interleaving
 * alive rows) — so the overlay must keep the battle-start order and flag
 * rows off the row-ALIGNED luma vector (vector row i IS player i there),
 * never the [alive] ++ [sunk] regroup the WG realms get.
 *
 * The layout gate matters (issue #1360): the 360 client's TWO-team table
 * renders the WG-family key order and re-sorts like every other realm,
 * so this static behavior must ride the single-team anchor, not the
 * realm alone — see renderCnTwoTeam.test.ts for that side.
 *
 * The anchor's alive vector here is deliberately NON-blockwise
 * ([true, false, true]) — the shape the CN single-team client actually
 * produces, and exactly the shape whose blockwise assumption
 * false-positives on the WG path.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

const arena = {
  matchGroup: "pvp",
  dateTime: "20261012_cn_rows",
  scenario: null,
  eventType: null,
  vehicles: [
    { id: 1, name: "alpha", relation: 0, shipId: 1 },
    { id: 2, name: "bravo", relation: 1, shipId: 2 },
    { id: 3, name: "charlie", relation: 1, shipId: 3 },
    { id: 4, name: "delta", relation: 2, shipId: 4 },
    { id: 5, name: "echo", relation: 2, shipId: 5 },
  ],
};

const anchor = {
  gameRect: { x: 0, y: 0, width: 1920, height: 1080 },
  overlayRect: { x: 0, y: 0, width: 1920, height: 1080 },
  rosterRect: { x: 500, y: 200, width: 900, height: 500 },
  // The SINGLE-team table: one full-width team column, NO enemy rows —
  // the green-only header (team_split exactly 1.0). The middle ally row
  // reads sunk.
  rowCenters: [240, 300, 360],
  teamSplit: 1.0,
  tableDetected: true,
  rowAlive: [true, false, true],
  rosterMode: "passive",
};

const rowChips = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>(".overlay-chip")].filter(
    (el) =>
      !el.classList.contains("overlay-chip--intel") &&
      !el.classList.contains("overlay-chip--head"),
  );

beforeAll(async () => {
  // The realm is baked into the window URL at import time — the CN layout
  // gates on it (overlay/main.ts's cnLayout).
  history.replaceState(null, "", "?realm=cn&locale=zh-CN");
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

describe("overlay page render (CN single-team static layout)", () => {
  it("keeps battle-start positions and dims the sunk row in place", async () => {
    handlers.get("wowsp://arena-info")!({ payload: arena });
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(rowChips().length).toBe(3));

    const chips = rowChips();
    const namesOf = (list: HTMLElement[]) =>
      list.map((c) => c.querySelector(".overlay-chip__name")?.textContent ?? "");
    // The CN permutation collates the display names: alpha, bravo,
    // charlie — NO re-sort, so a dimmed bravo keeps slot 2. The roster's
    // enemy rows have no grid block on a single-team table, so only the
    // three ally chips render.
    expect(namesOf(chips)).toEqual(["alpha", "bravo", "charlie"]);
    // The luma vector flags EXACTLY the middle ally row (in place).
    expect(chips.map((c) => c.classList.contains("overlay-chip--sunk"))).toEqual([
      false,
      true,
      false,
    ]);
  });
});
