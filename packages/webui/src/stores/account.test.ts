import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api", () => ({
  api: {
    appdataRead: vi.fn(async () => null),
    appdataWrite: vi.fn(async () => null),
    syncActiveAccount: vi.fn(async () => undefined),
  },
}));

import { api } from "@/api";
import { useAccountStore } from "./account";

const asia = { realm: "asia", accountId: 42, nickname: "TestAsia" };
const eu = { realm: "eu", accountId: 42, nickname: "TestEurope" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("realm-scoped account selection", () => {
  it("resolves the active profile by realm and account ID", async () => {
    const store = useAccountStore();
    await store.addAccount(asia);
    await store.addAccount(eu);
    await store.setActive(eu.realm, eu.accountId);
    expect(store.activeAccount).toEqual(eu);
  });

  it("does not clear a same-ID active account when removing another realm's profile", async () => {
    const store = useAccountStore();
    await store.addAccount(asia);
    await store.addAccount(eu);
    await store.setActive(eu.realm, eu.accountId);
    await store.removeAccount(asia.realm, asia.accountId);
    expect(store.activeAccount).toEqual(eu);
    expect(api.syncActiveAccount).toHaveBeenLastCalledWith(eu.realm, eu.accountId);
  });

  it("clears the cached active ID when the selected account is removed", async () => {
    const store = useAccountStore();
    await store.addAccount(asia);
    await store.setActive(asia.realm, asia.accountId);
    await store.removeAccount(asia.realm, asia.accountId);
    expect(localStorage.getItem("wowsp-active-account")).toBeNull();
    expect(store.activeAccountId).toBeNull();
  });

  it("honors an explicitly empty disk selection over the localStorage fallback", async () => {
    localStorage.setItem("wowsp-active-account", "42");
    vi.mocked(api.appdataRead).mockResolvedValueOnce(JSON.stringify({ accounts: [asia], activeRealm: "asia", activeAccountId: null }));
    const store = useAccountStore();
    await store.load();
    expect(store.activeAccount).toBeNull();
  });
});

describe("account persistence ordering", () => {
  it("shares a pending load and applies a selection only after that registry arrives", async () => {
    const read = deferred<string | null>();
    vi.mocked(api.appdataRead).mockReturnValueOnce(read.promise);
    const store = useAccountStore();
    const first = store.load();
    const second = store.load();
    const selecting = store.setActive(eu.realm, eu.accountId);
    await Promise.resolve();
    expect(api.appdataRead).toHaveBeenCalledTimes(1);
    expect(api.appdataWrite).not.toHaveBeenCalled();
    read.resolve(JSON.stringify({ accounts: [asia, eu], activeRealm: "asia", activeAccountId: 42 }));
    await Promise.all([first, second, selecting]);
    expect(store.activeAccount).toEqual(eu);
    expect(store.loading).toBe(false);
  });

  it("waits for startup accounts before applying and saving a new binding", async () => {
    const read = deferred<string | null>();
    vi.mocked(api.appdataRead).mockReturnValueOnce(read.promise);
    const store = useAccountStore();
    const loading = store.load();
    const adding = store.addAccount(eu);
    await Promise.resolve();
    expect(api.appdataWrite).not.toHaveBeenCalled();
    read.resolve(JSON.stringify({ accounts: [asia], activeRealm: "asia", activeAccountId: asia.accountId }));
    await Promise.all([loading, adding]);
    expect(store.accounts).toEqual([asia, eu]);
    expect(JSON.parse(vi.mocked(api.appdataWrite).mock.lastCall![1]).accounts).toEqual([asia, eu]);
  });

  it("serializes snapshots and session updates in selection order", async () => {
    const store = useAccountStore();
    const firstWrite = deferred<null>();
    vi.mocked(api.appdataWrite).mockReturnValueOnce(firstWrite.promise);
    const first = store.setActive(asia.realm, asia.accountId);
    const second = store.setActive(eu.realm, eu.accountId);
    await Promise.resolve();
    expect(api.appdataWrite).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(api.appdataWrite).mock.lastCall![1]).activeRealm).toBe("asia");
    firstWrite.resolve(null);
    await Promise.all([first, second]);
    expect(JSON.parse(vi.mocked(api.appdataWrite).mock.lastCall![1]).activeRealm).toBe("eu");
    expect(vi.mocked(api.syncActiveAccount).mock.calls).toEqual([["asia", 42], ["eu", 42]]);
    expect(localStorage.getItem("wowsp-active-realm")).toBe("eu");
  });

  it("recovers the write queue after a failed save", async () => {
    const store = useAccountStore();
    vi.mocked(api.appdataWrite).mockRejectedValueOnce(new Error("synthetic disk failure"));
    await expect(store.setActive(asia.realm, asia.accountId)).rejects.toThrow("synthetic disk failure");
    await store.setActive(eu.realm, eu.accountId);
    expect(JSON.parse(vi.mocked(api.appdataWrite).mock.lastCall![1]).activeRealm).toBe("eu");
    expect(api.syncActiveAccount).toHaveBeenLastCalledWith("eu", 42);
  });
});
