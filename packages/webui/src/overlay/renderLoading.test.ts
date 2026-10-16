/**
 * Page-level regression for the overlay's LOADING faces: while the stats
 * batch is still owed, every waiting number renders the chasing three-dot
 * marquee (overlay-dots) — each row chip's stat cell AND every enabled
 * value in the team summary cards' average line. The settled faces follow
 * the answer: real rows swap the dots for numbers, a not-found answer
 * swaps them for the honest muted dashes, and a PR-algo flip (which clears
 * the cache wholesale) lights the dots back up for the re-query. Also pins
 * the phase-locked markup: every bead carries an inline animation-delay
 * off the shared clock, the trick that keeps render()'s full-DOM rebuilds
 * from restarting the chase.
 *
 * Driven the way production drives it: the real main.ts bootstrap against
 * a mocked `window.__TAURI__` whose stats batch hangs until a test
 * resolves it (render.test.ts covers the opposite outage shape — a realm
 * that never answers and the dash it keeps).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { STATS_PREFS_STORAGE_KEY } from "../stores/statsPrefs";

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

// The deferred batch answer: each lookup hangs (the loading state under
// test) until a test resolves it. batchCalls tells re-query rounds apart.
let resolveBatch: ((rows: unknown[]) => void) | null = null;
let batchNames: string[] = [];
let batchCalls = 0;

const arena = {
  matchGroup: "pvp",
  dateTime: "20261013_loading_dots",
  scenario: null,
  eventType: null,
  vehicles: [
    { id: 1, name: "ally_one", relation: 1, shipId: 1 },
    { id: 2, name: "ally_two", relation: 1, shipId: 2 },
    { id: 3, name: "langyo", relation: 0, shipId: 3 },
    { id: 4, name: "enemy_one", relation: 2, shipId: 4 },
    { id: 5, name: "enemy_two", relation: 2, shipId: 5 },
    { id: 6, name: "enemy_three", relation: 2, shipId: 6 },
  ],
};

const anchor = {
  gameRect: { x: 0, y: 0, width: 3072, height: 1920 },
  overlayRect: { x: 0, y: 140, width: 3072, height: 911 },
  rosterRect: { x: 420, y: 91, width: 2208, height: 729 },
  rowCenters: [173, 229, 285, 175, 231, 287],
  teamSplit: 0.5,
  tableDetected: true,
  rowAlive: Array(6).fill(true),
  rosterMode: "passive",
};

const rowChips = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>(".overlay-chip")].filter(
    (el) => !el.classList.contains("overlay-chip--intel"),
  );

const avgLines = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(".overlay-intel-line--avg"),
];

const statRows = (hidden = false) =>
  batchNames.map((name) => ({
    accountId: 1,
    winrate: 48.5,
    avgDamage: 43210,
    pr: 1234,
    battles: 8600,
    rankedWinrate: null,
    rankedPr: null,
    rankedBattles: null,
    rankedAvgDamage: null,
    globalWinrate: null,
    globalPr: null,
    globalBattles: null,
    globalAvgDamage: null,
    clanId: null,
    clanTag: null,
    realm: "ru",
    hidden,
    name,
  }));

beforeAll(async () => {
  // The realm unlocks the lookups (render.test.ts runs realm-less and pins
  // the dash); zh-CN turns the seals on like the user's own settings.
  history.replaceState(null, "", "?realm=ru&locale=zh-CN");
  // The team-average line defaults off — the loading dots on it are part
  // of this contract, so switch it on the way the settings window would.
  localStorage.setItem(
    STATS_PREFS_STORAGE_KEY,
    JSON.stringify({ overlayTeamAvg: { winrate: true, pr: true, damage: true } }),
  );
  vi.stubGlobal("__TAURI__", {
    core: {
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "lookup_players_stats_batch") {
          batchCalls += 1;
          batchNames = (args?.names as string[]) ?? [];
          return new Promise((resolve) => {
            resolveBatch = resolve as (rows: unknown[]) => void;
          });
        }
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

describe("overlay page loading faces", () => {
  it("renders the chasing dots in every waiting number while the batch is owed", async () => {
    handlers.get("wowsp://arena-info")!({ payload: arena });
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(rowChips().length).toBe(6));

    // Every row chip's stat cell carries exactly one three-bead marquee.
    for (const chip of rowChips()) {
      const stat = chip.querySelector(".overlay-chip__stat")!;
      expect(stat.querySelectorAll(".overlay-dots")).toHaveLength(1);
      expect(stat.querySelectorAll(".overlay-dots i")).toHaveLength(3);
    }
    // The team summary cards' average line: one marquee per enabled value
    // (winrate / PR / damage), both sides.
    expect(avgLines().length).toBe(2);
    for (const line of avgLines()) {
      expect(line.querySelectorAll(".overlay-dots")).toHaveLength(3);
    }
    // Phase-locked delays: every bead's inline animation-delay off the
    // shared clock (negative = mid-cycle start) — the reason render()
    // rebuilds never restart the chase.
    for (const bead of document.querySelectorAll(".overlay-dots i")) {
      expect(bead.getAttribute("style") ?? "").toMatch(/animation-delay:-\d+\.\d{3}s/);
    }
  });

  it("swaps the dots for the honest dashes once the batch answers not-found", async () => {
    // The batch dispatches off a 250 ms timer — wait for it to be owed
    // before settling it.
    await vi.waitFor(() => expect(batchCalls).toBe(1));
    resolveBatch!(batchNames.map(() => null));

    // No marquee anywhere — and the per-part dashes of a settled,
    // not-found player instead of numbers.
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".overlay-dots").length).toBe(0),
    );
    for (const chip of rowChips()) {
      const text = chip.querySelector(".overlay-chip__stat")!.textContent ?? "";
      expect(text).toContain("—");
      expect(text).not.toContain("%");
    }
    for (const line of avgLines()) {
      const text = line.textContent ?? "";
      expect(text).toContain("—");
      expect(text).not.toContain("48.5%");
    }
  });

  it("lights the dots back up for a re-query and then lands the numbers", async () => {
    // A PR-algo flip invalidates the cached careers wholesale (the same
    // path a settings flip takes): the prefs blob is rewritten, the store
    // broadcasts, and every name re-queues under the new algo.
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({
        prEnabled: true,
        prAlgo: "expected",
        overlayTeamAvg: { winrate: true, pr: true, damage: true },
      }),
    );
    handlers.get("wowsp://stats-prefs-changed")!({ payload: null });

    // The cleared roster goes back to the chasing dots…
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".overlay-dots").length).toBeGreaterThan(0),
    );
    // …and the second batch settles them into the real numbers.
    await vi.waitFor(() => expect(batchCalls).toBe(2));
    resolveBatch!(statRows());
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".overlay-dots").length).toBe(0),
    );
    const chip = rowChips()[0]!;
    expect(chip.querySelector(".overlay-chip__stat")!.textContent).toContain("48.5%");
    // The average line shows the settled mean, not a dash.
    expect(avgLines()[0]!.textContent).toContain("48.5%");
    expect(avgLines()[0]!.textContent).toContain("43.2k");
  });
});
