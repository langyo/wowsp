/**
 * Page-level regression for the overlay's SELF-DIAGNOSTICS faces
 * (feedback 2026-10-23): a detected table with NO roster data must render
 * the honest waiting card (the rosterHint copy) — never the old EMPTY body
 * that read on screen as "the window is just transparent". Also pins the
 * two diagnostics channels the Rust watcher cross-checks:
 *
 *  - the paint report (`report_overlay_paint`): every VISIBLE render
 *    reports what it painted (hint / waiting card / chip row count), and
 *    NOTHING reports while the page is hidden (overlay-hidden class);
 *  - the verify marker (`wowsp://overlay-verify`): a solid corner square
 *    on documentElement (NOT body — render() wipes body) that dies on the
 *    visibility drop.
 *
 * Driven the way production drives it: the real main.ts bootstrap against
 * a mocked `window.__TAURI__` (same harness as renderLoading.test.ts).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

const arena = {
  matchGroup: "pvp",
  dateTime: "20261023_waiting_roster",
  scenario: null,
  eventType: null,
  vehicles: [
    { id: 1, name: "ally_one", relation: 1, shipId: 1 },
    { id: 2, name: "langyo", relation: 0, shipId: 2 },
    { id: 3, name: "enemy_one", relation: 2, shipId: 3 },
    { id: 4, name: "enemy_two", relation: 2, shipId: 4 },
  ],
};

const anchor = {
  gameRect: { x: 0, y: 0, width: 3072, height: 1920 },
  overlayRect: { x: 0, y: 140, width: 3072, height: 911 },
  rosterRect: { x: 420, y: 91, width: 2208, height: 729 },
  rowCenters: [173, 229, 285, 341],
  teamSplit: 0.5,
  tableDetected: true,
  rowAlive: Array(4).fill(true),
  rosterMode: "passive",
};

const rowChips = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>(".overlay-chip")].filter(
    (el) => !el.classList.contains("overlay-chip--intel"),
  );

// The paint-report call log: [kind, rows] per report_overlay_paint.
const paintReports: Array<{ kind: string; rows: number | null }> = [];
const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "report_overlay_paint") {
    paintReports.push({ kind: String(args?.kind), rows: (args?.rows as number | null) ?? null });
  }
  if (cmd === "read_temp_arena_info") return null;
  if (cmd.startsWith("lookup_")) return [];
  return null;
});

beforeAll(async () => {
  // zh-CN pins the rosterHint copy assertion to the Chinese card.
  history.replaceState(null, "", "?realm=ru&locale=zh-CN");
  vi.stubGlobal("__TAURI__", {
    core: { invoke: invokeMock },
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

const lastPaint = () => paintReports[paintReports.length - 1];

describe("overlay page waiting / diagnostics faces", () => {
  it("renders the honest waiting card (never an empty body) when the table is located but no roster landed", async () => {
    // NO arena-info event, and the page's own read_temp_arena_info poll
    // answers null — arena stays absent exactly like the ghost-gated
    // feedback case.
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() =>
      expect(document.querySelector(".overlay-status")?.textContent).toContain(
        "已定位到表格",
      ),
    );
    // The body carries ONLY the waiting card — no chips anywhere.
    expect(rowChips()).toHaveLength(0);
    expect(lastPaint()?.kind).toBe("waitingRoster");
    expect(lastPaint()?.rows).toBeNull();
  });

  it("reports the located hint paint while the table itself is not found", async () => {
    handlers.get("wowsp://overlay-anchor")!({ payload: { ...anchor, tableDetected: false } });
    await vi.waitFor(() => expect(lastPaint()?.kind).toBe("hint"));
    expect(document.querySelector(".overlay-status")).toBeTruthy();
    // Back to the waiting card for the rest of the suite.
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(lastPaint()?.kind).toBe("waitingRoster"));
  });

  it("reports the rendered chip count once the roster lands", async () => {
    handlers.get("wowsp://arena-info")!({ payload: arena });
    // The anchor event re-renders with the roster in hand (chips this time).
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(rowChips().length).toBe(4));
    expect(lastPaint()?.kind).toBe("chips");
    expect(lastPaint()?.rows).toBe(4);
  });

  it("paints the verify marker on documentElement and drops it with visibility", async () => {
    expect(document.querySelector(".overlay-verify-marker")).toBeNull();
    handlers.get("wowsp://overlay-verify")!({ payload: true });
    expect(document.querySelector(".overlay-verify-marker")).toBeTruthy();
    // The marker rides on <html>, so a body-wiping render must not remove
    // it mid-verify.
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(rowChips().length).toBe(4));
    expect(document.querySelector(".overlay-verify-marker")).toBeTruthy();
    // The visibility drop (the watcher's load-bearing hide) tears it down.
    handlers.get("wowsp://overlay-visibility")!({ payload: false });
    expect(document.querySelector(".overlay-verify-marker")).toBeNull();
    // Hidden pages never report paints. NOTE: an anchor event can't probe
    // this — the anchor listener reveals the page by design ("an anchor
    // always precedes a show") — so drive a re-render through the prefs
    // broadcast instead, which renders without touching visibility.
    const reportsBefore = paintReports.length;
    handlers.get("wowsp://stats-prefs-changed")!({ payload: null });
    await Promise.resolve();
    expect(paintReports.length).toBe(reportsBefore);
    // Reveal again for any later suite work.
    handlers.get("wowsp://overlay-visibility")!({ payload: true });
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(rowChips().length).toBe(4));
  });
});
