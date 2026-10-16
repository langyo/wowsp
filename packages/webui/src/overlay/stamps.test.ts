import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type StampFile = { kind: string; path: string };
type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();
const stampList = vi.fn<() => Promise<StampFile[]>>().mockResolvedValue([]);
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const changed = () => handlers.get("wowsp://stamps-changed")!({ payload: null });
const image = () => document.querySelector("img[data-stamp='rat']")?.getAttribute("src");

beforeAll(async () => {
  history.replaceState(null, "", "?realm=asia&locale=zh-CN");
  vi.stubGlobal("__TAURI__", {
    core: {
      invoke: vi.fn(async (cmd: string) => {
        if (cmd === "stamp_list") return stampList();
        if (cmd === "lookup_players_stats_batch") return [{ hidden: true }];
        if (cmd.startsWith("lookup_")) return [];
        return null;
      }),
    },
    event: {
      listen: vi.fn(async (name: string, handler: Handler) => {
        handlers.set(name, handler);
        return () => handlers.delete(name);
      }),
    },
  });
  await import("./main");
  await vi.waitFor(() => expect(stampList).toHaveBeenCalled());
  handlers.get("wowsp://arena-info")!({ payload: {
    matchGroup: "pvp", dateTime: "stamp-test-battle",
    vehicles: [{ id: 1, name: "TestPlayer", relation: 0, shipId: 1 }],
  } });
  handlers.get("wowsp://overlay-anchor")!({ payload: {
    overlayRect: { x: 0, y: 0, width: 1920, height: 1080 },
    rosterRect: { x: 400, y: 100, width: 1100, height: 700 },
    rowCenters: [200], teamSplit: 0.5, tableDetected: true,
    rowAlive: [true], rosterMode: "passive",
  } });
  await vi.waitFor(() => expect(document.querySelector("[data-stamp='rat']")).not.toBeNull());
});

afterAll(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("overlay stamp refresh", () => {
  it("keeps the latest imported image when an older listing finishes later", async () => {
    const old = deferred<StampFile[]>();
    stampList.mockReturnValueOnce(old.promise);
    changed();
    stampList.mockResolvedValueOnce([{ kind: "rat", path: "new.jpg" }]);
    changed();
    await vi.waitFor(() => expect(image()).toBe("new.jpg"));
    old.resolve([{ kind: "rat", path: "old.png" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(image()).toBe("new.jpg");
  });

  it("does not resurrect the custom image after resetting it", async () => {
    const old = deferred<StampFile[]>();
    stampList.mockReturnValueOnce(old.promise);
    changed();
    stampList.mockResolvedValueOnce([]);
    changed();
    await vi.waitFor(() => expect(image()).toBeUndefined());
    old.resolve([{ kind: "rat", path: "old.png" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(image()).toBeUndefined();
    expect(document.querySelector("span[data-stamp='rat']")).not.toBeNull();
  });
});
