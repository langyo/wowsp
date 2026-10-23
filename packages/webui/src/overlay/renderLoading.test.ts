/**
 * Page-level regression for the overlay's LOADING faces: while the stats
 * batch is still owed, every waiting number renders the chasing three-dot
 * marquee (overlay-dots) — each row chip's stat cell AND every value of
 * the team summary cards' averages line (one all-or-nothing switch). The
 * settled faces follow the answer: real rows swap the dots for numbers, a
 * not-found answer swaps them for the honest DRAWN dashes (overlay-dash),
 * and a PR-algo flip (which clears the cache wholesale) lights the dots
 * back up for the re-query. Also pins the phase-locked markup: every bead
 * carries an inline animation-delay off the shared clock, the trick that
 * keeps render()'s full-DOM rebuilds from restarting the chase. The last
 * case pins the PER-COLUMN faces a ship-scoped column set produces: the
 * career columns (global/solo) render their figures the moment the batch
 * lands while the ship cell keeps the dots until its per-ship list
 * arrives, and a MIRRORED solo split (solo battles == career battles,
 * rejected by soloSplitReliable) renders the drawn dash instead of the
 * career numbers wearing a 单人 tag.
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
    (el) =>
      !el.classList.contains("overlay-chip--intel") &&
      !el.classList.contains("overlay-chip--head"),
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
    JSON.stringify({ teamAvgEnabled: true }),
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
        // The per-ship pipeline hangs by default: the last case pins the
        // ship-scoped column's OWN loading face, which needs the list to
        // stay owed (an empty answer would settle it into dashes).
        if (cmd === "lookup_player_ship_stats") return new Promise(() => {});
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
      // The waiting figures carry no comparative tone — a verdict needs
      // both sides settled (see teamAvgTone).
      expect(line.querySelectorAll(".overlay-intel-b--hi")).toHaveLength(0);
      expect(line.querySelectorAll(".overlay-intel-b--lo")).toHaveLength(0);
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

    // No marquee anywhere — and the per-part DRAWN dashes of a settled,
    // not-found player instead of numbers (one per configured column,
    // each a painted rule, never the "—" glyph).
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".overlay-dots").length).toBe(0),
    );
    for (const chip of rowChips()) {
      const stat = chip.querySelector(".overlay-chip__stat")!;
      expect(stat.querySelectorAll(".overlay-dash")).toHaveLength(4);
      expect(stat.textContent).not.toContain("%");
    }
    for (const line of avgLines()) {
      expect(line.querySelectorAll(".overlay-dash")).toHaveLength(3);
      expect(line.textContent).not.toContain("48.5%");
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
        teamAvgEnabled: true,
      }),
    );
    handlers.get("wowsp://stats-prefs-changed")!({ payload: null });

    // The cleared roster goes back to the chasing dots…
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".overlay-dots").length).toBeGreaterThan(0),
    );
    // …and the second batch settles them into the real numbers — the two
    // sides graded APART so the settled faces carry the comparative tone
    // (see teamAvgTone): every ally figure beats every enemy figure
    // (48.5 / 1234 / 43.2k vs 45.1 / 1100 / 38k), so the ally card's
    // three figures grade hi and the enemy card's lo.
    await vi.waitFor(() => expect(batchCalls).toBe(2));
    resolveBatch!(
      batchNames.map((name) => {
        const row = statRows()[0]!;
        return name.startsWith("enemy")
          ? { ...row, winrate: 45.1, pr: 1100, avgDamage: 38000 }
          : row;
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".overlay-dots").length).toBe(0),
    );
    const chip = rowChips()[0]!;
    expect(chip.querySelector(".overlay-chip__stat")!.textContent).toContain("48.5%");
    // The average line shows the settled mean, not a dash.
    expect(avgLines()[0]!.textContent).toContain("48.5%");
    expect(avgLines()[0]!.textContent).toContain("43.2k");
    // Both sides settled → the comparative tone lands: the ally card
    // grades hi on all three metrics, the enemy card lo.
    const intelCard = (side: string) =>
      document.querySelector<HTMLElement>(
        `.overlay-chip--${side}.overlay-chip--intel`,
      )!;
    for (const b of intelCard("ally")!.querySelectorAll(".overlay-intel-line--avg b")) {
      expect(b.classList.contains("overlay-intel-b--hi")).toBe(true);
      expect(b.classList.contains("overlay-intel-b--lo")).toBe(false);
    }
    for (const b of intelCard("enemy")!.querySelectorAll(".overlay-intel-line--avg b")) {
      expect(b.classList.contains("overlay-intel-b--lo")).toBe(true);
      expect(b.classList.contains("overlay-intel-b--hi")).toBe(false);
    }
  });

  it("renders per-column faces: career figures land with the batch, ship cells keep their dots, mirrored solo splits dash", async () => {
    // A new battle under a column set mixing scopes — global winrate,
    // solo winrate, ship battles. The prefs rewrite also flips the PR
    // algorithm back to winrate, which clears the stats cache wholesale:
    // every name re-queues (batchCalls 3) under the fresh columns.
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({
        prEnabled: true,
        teamAvgEnabled: true,
        overlayColumns: [
          { scope: "global", metric: "winrate" },
          { scope: "solo", metric: "winrate" },
          { scope: "ship", metric: "battles" },
        ],
      }),
    );
    handlers.get("wowsp://stats-prefs-changed")!({ payload: null });
    handlers.get("wowsp://arena-info")!({
      payload: { ...arena, dateTime: "20261023_partial_columns" },
    });
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(batchCalls).toBe(3));
    // langyo's solo split MIRRORS his career (8600 == 8600 — the shape
    // soloSplitReliable rejects); everyone else carries an honest split.
    resolveBatch!(
      batchNames.map((name) => ({
        ...statRows()[0]!,
        soloWr: 51.0,
        soloBattles: name === "langyo" ? 8600 : 5400,
        name,
      })),
    );

    // The batch landed the careers, but every per-ship list is still owed
    // (the hanging mock above): each row renders its global and solo
    // FIGURES while the ship column's own cell keeps the chasing dots —
    // the row no longer waits on its slowest column. (data-col keys stay
    // the CONFIG column on both sides: 0 global, 1 solo, 2 ship.)
    await vi.waitFor(() =>
      expect(rowChips()[0]!.querySelector(".overlay-chip__stat")!.textContent).toContain(
        "48.5%",
      ),
    );
    const chips = rowChips();
    expect(chips).toHaveLength(6);
    for (const chip of chips) {
      const stat = chip.querySelector(".overlay-chip__stat")!;
      expect(stat.textContent).toContain("48.5%");
      expect(stat.querySelectorAll("b")).toHaveLength(3);
      // The ship cell (config column 2) is the one still owed: a centered
      // col-waiting cell (not the muted right-aligned dash face) whose
      // beads read as "this column is coming".
      const shipCell = chip.querySelector('b[data-col="2"]')!;
      expect(shipCell.classList.contains("col-waiting")).toBe(true);
      expect(shipCell.classList.contains("muted")).toBe(false);
      expect(shipCell.querySelectorAll(".overlay-dots")).toHaveLength(1);
      // No per-cell scope tags — the head row owns the naming.
      expect(chip.querySelectorAll(".overlay-scope")).toHaveLength(0);
      // The row itself carries figures, so it is NOT sparse — the stat cell
      // still joins the side's pinned width.
      expect(stat.classList.contains("overlay-chip__stat--sparse")).toBe(false);
    }
    // The per-side COLUMN HEAD rows name the three configured columns —
    // 胜率 / 单人胜率 / 单船场次 (zh join empty) — riding the same data-col
    // cells as the figures, the enemy head mirroring the column order.
    const headOf = (side: string) =>
      [
        ...document.querySelectorAll<HTMLSpanElement>(
          `.overlay-chip--head.overlay-chip--${side} .overlay-chip__stat b`,
        ),
      ].map((b) => `${b.dataset.col}:${b.textContent}`);
    expect(document.querySelectorAll(".overlay-chip--head")).toHaveLength(2);
    expect(headOf("ally")).toEqual(["0:胜率", "1:单人胜率", "2:单船场次"]);
    expect(headOf("enemy")).toEqual(["2:单船场次", "1:单人胜率", "0:胜率"]);
    // The mirrored split: langyo's solo cell is the drawn dash, never the
    // career winrate; the honest splits show 51.0%.
    const langyoChip = chips.find((c) => c.textContent?.includes("langyo"))!;
    const langyoSolo = langyoChip.querySelector('b[data-col="1"]')!;
    expect(langyoSolo.querySelector(".overlay-dash")).not.toBeNull();
    expect(langyoSolo.textContent).not.toContain("%");
    for (const chip of chips.filter((c) => c !== langyoChip)) {
      expect(chip.querySelector('b[data-col="1"]')!.textContent).toContain("51.0%");
    }
  });
});
