/** Local player-markers store: the matching contract (nickname first,
 *  account id second) and the add/remove round-trip. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RPC } from "@/rpc";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/transport", () => ({ transport: { invoke: mocks.invoke } }));

import { useMarkersStore } from "./markers";

const redEntry = {
  nickname: "Laneigedc",
  color: "red",
  note: "挂机",
  accountId: 1001,
  createdAt: 1,
};
const purpleEntry = {
  nickname: "BigShot",
  color: "purple",
  note: null,
  accountId: null,
  createdAt: 2,
};

function routeTransport(
  routes: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>,
) {
  mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    const route = routes[cmd];
    if (route === undefined) return Promise.resolve(undefined);
    return Promise.resolve(typeof route === "function" ? route(args ?? {}) : route);
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.invoke.mockReset();
});

describe("colorOf", () => {
  it("matches the exact nickname case-insensitively", async () => {
    routeTransport({ [RPC.markers_list]: [redEntry, purpleEntry] });
    const store = useMarkersStore();
    await store.ensureLoaded();
    expect(store.colorOf("Laneigedc")).toBe("red");
    expect(store.colorOf("LANEIGEDC")).toBe("red");
    expect(store.colorOf("  laneigedc ")).toBe("red");
    expect(store.colorOf("BigShot")).toBe("purple");
    expect(store.colorOf("SomebodyElse")).toBeNull();
  });

  it("falls back to the account id (rename-proof)", async () => {
    routeTransport({ [RPC.markers_list]: [redEntry] });
    const store = useMarkersStore();
    await store.ensureLoaded();
    // The player renamed; the row's nickname no longer matches, the id does.
    expect(store.colorOf("RenamedPlayer", 1001)).toBe("red");
    expect(store.colorOf(null, 1001)).toBe("red");
    expect(store.colorOf("RenamedPlayer", 9999)).toBeNull();
  });

  it("nickname wins when both halves match different entries", async () => {
    routeTransport({
      [RPC.markers_list]: [
        redEntry, // nickname Laneigedc / id 1001
        { ...purpleEntry, nickname: "Other", accountId: 2002 },
      ],
    });
    const store = useMarkersStore();
    await store.ensureLoaded();
    // Row named Laneigedc but id 2002 (the entry named Other): the name
    // wins — the user typed the name, that judgment is explicit.
    expect(store.colorOf("Laneigedc", 2002)).toBe("red");
  });

  it("never matches before a load", () => {
    routeTransport({});
    const store = useMarkersStore();
    expect(store.colorOf("Laneigedc", 1001)).toBeNull();
  });
});

describe("add / remove", () => {
  it("adopts the backend list as the store truth", async () => {
    routeTransport({
      [RPC.markers_list]: [],
      [RPC.markers_add]: (args: Record<string, unknown>) => [
        {
          ...redEntry,
          nickname: String(args.nickname),
          color: args.color,
          note: args.note,
        },
      ],
      [RPC.markers_remove]: [],
    });
    const store = useMarkersStore();
    await store.ensureLoaded();
    await store.add("Laneigedc", "red", "挂机");
    expect(store.entries).toHaveLength(1);
    expect(store.colorOf("Laneigedc")).toBe("red");
    await store.remove("laneigedc");
    expect(store.entries).toHaveLength(0);
    expect(store.colorOf("Laneigedc")).toBeNull();
  });
});
