/** Account online badge store: the poll maps a fresh last_battle_time onto
 *  per-account suspect flags, keeps the previous map across upstream
 *  failures, skips polls with nothing bound and stays single-flight. */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RPC } from "@/rpc";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/transport", () => ({ transport: { invoke: mocks.invoke } }));

import { useAccountStore } from "@/stores/account";
import { RECENT_BATTLE_WINDOW_MS, useAccountOnlineStore } from "./accountOnline";

const NOW = 1_800_000_000_000;

function seedAccounts() {
  const accounts = useAccountStore();
  accounts.accounts = [
    { accountId: 1001, nickname: "Fresh", realm: "asia" },
    { accountId: 2002, nickname: "Stale", realm: "eu" },
    { accountId: 3003, nickname: "Hidden", realm: "cn" },
  ];
  return accounts;
}

function routeOnline(
  rows: { accountId: number; realm: string; lastBattleTime: number | null }[],
) {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === RPC.account_online_check) {
      return Promise.resolve(
        rows.map((r) => ({ ...r, checkedAt: Math.round(NOW / 1000) })),
      );
    }
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.invoke.mockReset();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pollOnce", () => {
  it("flags only accounts whose last battle is inside the window", async () => {
    seedAccounts();
    routeOnline([
      { accountId: 1001, realm: "asia", lastBattleTime: (NOW - 5 * 60_000) / 1000 },
      {
        accountId: 2002,
        realm: "eu",
        lastBattleTime: (NOW - (RECENT_BATTLE_WINDOW_MS + 60_000)) / 1000,
      },
      { accountId: 3003, realm: "cn", lastBattleTime: null },
    ]);
    const store = useAccountOnlineStore();
    await store.pollOnce();
    expect(store.suspectOf("asia", 1001)).toBe(true);
    expect(store.suspectOf("eu", 2002)).toBe(false);
    expect(store.suspectOf("cn", 3003)).toBe(false);
    // Unknown account / id-less rows can never flag.
    expect(store.suspectOf("asia", 9999)).toBe(false);
    expect(store.suspectOf("eu", null)).toBe(false);
  });

  it("keeps the previous flags when the poll rejects", async () => {
    seedAccounts();
    routeOnline([{ accountId: 1001, realm: "asia", lastBattleTime: (NOW - 60_000) / 1000 }]);
    const store = useAccountOnlineStore();
    await store.pollOnce();
    expect(store.suspectOf("asia", 1001)).toBe(true);

    mocks.invoke.mockImplementation(() => Promise.reject(new Error("upstream")));
    await store.pollOnce();
    expect(store.suspectOf("asia", 1001)).toBe(true);
  });

  it("stays single-flight: a concurrent poll is a no-op", async () => {
    seedAccounts();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    mocks.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          void gate.then(() => resolve([]));
        }),
    );
    const store = useAccountOnlineStore();
    const first = store.pollOnce();
    const second = store.pollOnce();
    release?.();
    await Promise.all([first, second]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("does not poll with no bound accounts", async () => {
    useAccountStore().accounts = [];
    routeOnline([]);
    const store = useAccountOnlineStore();
    await store.pollOnce();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
