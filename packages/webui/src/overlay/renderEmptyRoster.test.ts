/**
 * Page-level regression for the 2026-10-29 blank Tab panel: a Lesta battle
 * announces itself with a vehicles-less tempArenaInfo.json, so the FIRST
 * `arena-info` delivery can carry ZERO players and the probe's roster lands a
 * beat later. The page used to fall through every render() branch in that
 * state (no chips to loop, no side cards, no "querying" badge) and paint a
 * completely EMPTY body — the window looked transparent except for the verify
 * marker. Pins:
 *
 *  - an empty roster is the honest "roster not landed" waiting card, never an
 *    empty body;
 *  - a complete roster that arrives LATER repaints (no new anchor needed);
 *  - an anchor press re-reads the roster while it is still empty (the
 *    page-side half of the backend heal);
 *  - uncaught page errors reach the Rust log (a thrown render() leaves an
 *    empty body with every app-side signal green — undiagnosable otherwise).
 *
 * Driven the way production drives it: the real main.ts bootstrap against a
 * mocked `window.__TAURI__` (same harness as renderWaiting.test.ts).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

const roster = {
  matchGroup: "pvp",
  dateTime: "20261029_empty_roster",
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
    (el) =>
      !el.classList.contains("overlay-chip--intel") &&
      !el.classList.contains("overlay-chip--head"),
  );

// The payload the page's own `read_temp_arena_info` poll answers — the tests
// steer it to prove the anchor re-read heals an empty roster.
let arenaReadResult: unknown = null;
const paintReports: Array<{ kind: string; rows: number | null }> = [];
const errorReports: string[] = [];
const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "report_overlay_paint") {
    paintReports.push({ kind: String(args?.kind), rows: (args?.rows as number | null) ?? null });
  }
  if (cmd === "report_overlay_page_error") {
    errorReports.push(String(args?.message));
  }
  if (cmd === "read_temp_arena_info") return arenaReadResult;
  if (cmd.startsWith("lookup_")) return [];
  return null;
});

beforeAll(async () => {
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
const waitingCard = () => document.querySelector(".overlay-status")?.textContent ?? "";

describe("overlay page empty-roster (Lesta first read) handling", () => {
  it("renders the waiting card — never an empty body — when the delivered roster is empty", async () => {
    // The battle's first delivery: a vehicles-less payload (players=0 in the
    // field log), exactly the 2026-10-29 shape. It lands BEFORE the anchor,
    // so the anchor's render is the one that has to cope with it.
    handlers.get("wowsp://arena-info")!({ payload: { ...roster, vehicles: [] } });
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(waitingCard()).toContain("已定位到表格"));
    expect(rowChips()).toHaveLength(0);
    expect(document.body.children.length).toBeGreaterThan(0);
    expect(lastPaint()?.kind).toBe("waitingRoster");
  });

  it("repaints the chips SYNCHRONOUSLY as soon as a filled roster arrives", () => {
    // Synchronous on purpose: the stats batch would also re-render ~250 ms
    // later, so a waitFor assertion here would pass even on the unfixed page.
    handlers.get("wowsp://arena-info")!({ payload: roster });
    expect(rowChips().length).toBe(4);
    expect(lastPaint()?.kind).toBe("chips");
    expect(lastPaint()?.rows).toBe(4);
  });

  it("does NOT repaint on a filled→filled delivery", () => {
    // The sink-attrib pipeline depends on the arena handler staying render-free
    // between a sink transition and the anchor of the same Rust pass; only the
    // empty↔filled flip may render.
    const before = paintReports.length;
    handlers.get("wowsp://arena-info")!({ payload: roster });
    expect(paintReports.length).toBe(before);
  });

  it("re-reads the roster on an anchor press while it is still empty", async () => {
    // Back to the empty delivery (a fresh battle that lost the same race).
    handlers.get("wowsp://arena-info")!({ payload: { ...roster, vehicles: [] } });
    await vi.waitFor(() => expect(waitingCard()).toContain("已定位到表格"));
    // The backend now answers the page's own read with the warmed roster.
    arenaReadResult = roster;
    handlers.get("wowsp://overlay-anchor")!({ payload: anchor });
    await vi.waitFor(() => expect(rowChips().length).toBe(4));
  });

  it("reports uncaught page errors to the Rust log", async () => {
    const errEvent = new Event("error") as Event & { message?: string };
    errEvent.message = "boom from render";
    window.dispatchEvent(errEvent);
    await vi.waitFor(() => expect(errorReports.length).toBeGreaterThan(0));
    expect(errorReports[0]).toContain("boom from render");
  });
});
