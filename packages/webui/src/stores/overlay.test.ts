/** The arena store's battle-realm latch: the roster belongs to the server
 *  it played on, so `battleRealm` freezes on a battle-identity change (a
 *  fresh arena dateTime — running client first, selection tiers as the
 *  fallback) and a same-battle roster refresh must NOT re-latch. Otherwise
 *  switching the bottom-left client-version after a battle ends would
 *  retarget the retained roster's stats (the refresh button included) at
 *  another cluster where these nicknames are different players. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ArenaInfo } from "@/api";
import { useAccountStore } from "./account";
import { useConfigStore } from "./config";
import { useGameStatusStore } from "./gameStatus";
import { useOverlayStore } from "./overlay";

vi.mock("@/api", () => ({
  api: {
    readTempArenaInfo: vi.fn(),
  },
}));

import { api } from "@/api";

function arena(dateTime: string): ArenaInfo {
  return {
    dateTime,
    matchGroup: "pvp",
    mapName: "",
    scenario: null,
    eventType: null,
    botCount: 0,
    scriptedUnitCount: 0,
    vehicles: [],
  } as unknown as ArenaInfo;
}

/** Selection tiers for a test run: active install realm, bound account
 *  realm, and the process-matched install realm. */
function seedSelection(realm: string | null) {
  const config = useConfigStore();
  config.installs = [];
  config.activeInstall = realm
    ? { kind: "steam", path: "C:\\game", realm }
    : null;
  const gameStatus = useGameStatusStore();
  gameStatus.process = {
    running: false,
    pid: null,
    kind: null,
    realm: null,
    exePath: null,
    matchedInstall: null,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  localStorage.clear();
  seedSelection(null);
});

describe("overlay battleRealm latch", () => {
  it("latches the selection on a battle's first arena file", async () => {
    seedSelection("asia");
    vi.mocked(api.readTempArenaInfo).mockResolvedValue(arena("2026-10-09 12:00:00"));
    const store = useOverlayStore();
    await store.refreshArenaInfo();
    expect(store.battleRealm).toBe("asia");
  });

  it("prefers the running client's matched install at latch time", async () => {
    seedSelection("asia");
    useGameStatusStore().process = {
      running: true,
      pid: 1,
      kind: "lesta",
      realm: "ru",
      exePath: "C:\\lesta\\woWSs.exe",
      matchedInstall: { kind: "lesta", path: "C:\\lesta", realm: "ru" },
    };
    vi.mocked(api.readTempArenaInfo).mockResolvedValue(arena("2026-10-09 12:00:00"));
    const store = useOverlayStore();
    await store.refreshArenaInfo();
    expect(store.battleRealm).toBe("ru");
  });

  it("keeps the latch on a same-battle roster refresh", async () => {
    seedSelection("asia");
    vi.mocked(api.readTempArenaInfo)
      .mockResolvedValueOnce(arena("2026-10-09 12:00:00"))
      .mockResolvedValueOnce(arena("2026-10-09 12:00:00"));
    const store = useOverlayStore();
    await store.refreshArenaInfo();
    expect(store.battleRealm).toBe("asia");
    // The selection flips between the two reads (players loading in —
    // same battle): the latch must not follow it.
    seedSelection("eu");
    await store.refreshArenaInfo();
    expect(store.battleRealm).toBe("asia");
  });

  it("re-latches when a NEW battle's arena file appears", async () => {
    seedSelection("asia");
    vi.mocked(api.readTempArenaInfo)
      .mockResolvedValueOnce(arena("2026-10-09 12:00:00"))
      .mockResolvedValueOnce(arena("2026-10-09 13:30:00"));
    const store = useOverlayStore();
    await store.refreshArenaInfo();
    expect(store.battleRealm).toBe("asia");
    seedSelection("eu");
    await store.refreshArenaInfo();
    expect(store.battleRealm).toBe("eu");
  });

  it("clears the latch with the roster (battle-cap / session reset)", async () => {
    seedSelection("asia");
    vi.mocked(api.readTempArenaInfo).mockResolvedValue(arena("2026-10-09 12:00:00"));
    const store = useOverlayStore();
    await store.refreshArenaInfo();
    expect(store.battleRealm).toBe("asia");
    store.clearArenaInfo();
    expect(store.battleRealm).toBe("");
  });

  it("falls through the selection ladder install → account → default", async () => {
    vi.mocked(api.readTempArenaInfo).mockResolvedValue(arena("2026-10-09 12:00:00"));
    const store = useOverlayStore();
    // No install matched and no bound account: the account store's own
    // default realm (asia) stands in as the terminal default.
    await store.refreshArenaInfo();
    expect(store.battleRealm).toBe("asia");
    // The bound account's realm outranks the default on the NEXT battle.
    useAccountStore().activeRealm = "na";
    vi.mocked(api.readTempArenaInfo).mockResolvedValue(arena("2026-10-09 13:00:00"));
    await store.refreshArenaInfo();
    expect(store.battleRealm).toBe("na");
  });
});
