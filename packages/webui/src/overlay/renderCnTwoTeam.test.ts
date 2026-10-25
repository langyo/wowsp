/**
 * Page-level regression for issue #1360 (the CN two-team Tab order): the
 * 360 client's TWO-team table renders the decompiled WG-family NATION
 * rank — the 2026-10-23 capture ordered one (class, tier) group
 * 塞勒姆(Salem, usa) → 斯大林格勒(Stalingrad, russia) → 那不勒斯(Napoli,
 * italy), exactly the nation order, while the pinyin ship-name reading
 * puts 那不勒斯 first (na < sai < si) and is contradicted 4/4 there. The
 * CN name-order permutation must therefore stand down on a two-team
 * anchor (team_split < 1.0) and the offline WG-family key inference take
 * over — the chip column then matches the rendered rows instead of
 * permuting against them.
 *
 * The three ships are the capture's own trio from the baked DB: same
 * class (cruiser), same tier (X), three nations.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

const SALEM = 3550394352; // usa, cruiser X — 塞勒姆
const STALINGRAD = 3760109008; // russia, cruiser X — 斯大林格勒
const NAPOLI = 3760109296; // italy, cruiser X — 那不勒斯

const arena = {
  matchGroup: "pvp",
  dateTime: "20261023_cn_two_team",
  scenario: null,
  eventType: null,
  vehicles: [
    { id: 1, name: "self", relation: 0, shipId: 1 },
    { id: 2, name: "队友", relation: 1, shipId: 2 },
    { id: 3, name: "italy号", relation: 2, shipId: NAPOLI },
    { id: 4, name: "usa号", relation: 2, shipId: SALEM },
    { id: 5, name: "russia号", relation: 2, shipId: STALINGRAD },
  ],
};

const anchor = {
  gameRect: { x: 0, y: 0, width: 1920, height: 1080 },
  overlayRect: { x: 0, y: 0, width: 1920, height: 1080 },
  rosterRect: { x: 500, y: 200, width: 900, height: 500 },
  // Two ally rows + three enemy rows — the standard two-team table.
  rowCenters: [240, 300, 240, 300, 360],
  teamSplit: 0.5,
  tableDetected: true,
  rowAlive: Array(5).fill(true),
  rosterMode: "passive",
};

const rowChips = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>(".overlay-chip")].filter(
    (el) =>
      !el.classList.contains("overlay-chip--intel") &&
      !el.classList.contains("overlay-chip--head"),
  );

beforeAll(async () => {
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

describe("overlay page render (CN two-team table)", () => {
  it("sorts the enemy chips by the WG-family nation rank, not pinyin", async () => {
    handlers.get("wowsp://arena-info")!({ payload: arena });
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(rowChips().length).toBe(5));

    const namesOf = (list: HTMLElement[]) =>
      list.map((c) => c.querySelector(".overlay-chip__name")?.textContent ?? "");
    const chips = rowChips();
    // Ally rows: the roster's unknown ships tie on every key segment, so
    // the array order stands.
    expect(namesOf(chips.slice(0, 2))).toEqual(["self", "队友"]);
    // The enemy column follows the nation rank (usa 1 < russia 2 < italy
    // 6) — the rendered table's own order. The pinyin permutation would
    // put the Napoli chip first ([italy号, usa号, russia号]) and mismap
    // every chip below the column's second row.
    expect(namesOf(chips.slice(2, 5))).toEqual(["usa号", "russia号", "italy号"]);
  });
});
