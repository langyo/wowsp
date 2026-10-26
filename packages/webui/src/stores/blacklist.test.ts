/** Blacklist sync store: the marker lookup contract (isBlocked — realm +
 *  account id must BOTH match), the auto-sync gate and the save round-trip.
 *  The save case pins the P0 regression where a wire-null response clobbered
 *  config.value and crashed the whole settings section. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RPC } from "@/rpc";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/transport", () => ({ transport: { invoke: mocks.invoke } }));

import { useBlacklistStore } from "./blacklist";

function routeTransport(
  routes: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>,
) {
  mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    const route = routes[cmd];
    if (route === undefined) return Promise.resolve(undefined);
    return Promise.resolve(typeof route === "function" ? route(args ?? {}) : route);
  });
}

const NOW_SEC = Math.floor(Date.now() / 1000);

const AUTH_LOGGED_IN = {
  realm: "eu",
  platform: "wargaming",
  loggedIn: true,
  accountId: 42,
  nickname: "me",
  expiresAt: NOW_SEC + 10_000,
};

const FRESH_SNAPSHOT = {
  realm: "eu",
  platform: "wargaming",
  accountId: 42,
  nickname: "me",
  lastSyncedAt: NOW_SEC - 60,
  entries: [
    { accountId: 7, nickname: "Seven" },
    { accountId: 8, nickname: null },
  ],
  unresolved: 1,
};

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.invoke.mockReset();
});

describe("isBlocked", () => {
  it("matches on account id within the bound realm", async () => {
    routeTransport({
      [RPC.blacklist_auth_state]: AUTH_LOGGED_IN,
      [RPC.blacklist_snapshot]: FRESH_SNAPSHOT,
      [RPC.blacklist_load_config]: { autoSync: false, intervalHours: 24 },
    });
    const store = useBlacklistStore();
    await store.ensureRealm("eu");
    expect(store.isBlocked("eu", 7)).toBe(true);
    // A null-nickname entry (unresolved) still blocks — ids are the key.
    expect(store.isBlocked("eu", 8)).toBe(true);
    expect(store.isBlocked("eu", 9)).toBe(false);
  });

  it("fails closed on a realm mismatch and on missing halves", async () => {
    routeTransport({
      [RPC.blacklist_auth_state]: AUTH_LOGGED_IN,
      [RPC.blacklist_snapshot]: FRESH_SNAPSHOT,
      [RPC.blacklist_load_config]: { autoSync: false, intervalHours: 24 },
    });
    const store = useBlacklistStore();
    await store.ensureRealm("eu");
    // A row resolved on another realm must never light the dot.
    expect(store.isBlocked("na", 7)).toBe(false);
    // A missing realm falls back to the bound snapshot (same-account call
    // sites that simply do not know the realm).
    expect(store.isBlocked(null, 7)).toBe(true);
    expect(store.isBlocked("eu", null)).toBe(false);
    expect(store.isBlocked(undefined, undefined)).toBe(false);
  });

  it("never matches before a snapshot exists", () => {
    routeTransport({});
    const store = useBlacklistStore();
    expect(store.isBlocked("eu", 7)).toBe(false);
  });
});

describe("autoSyncIfDue", () => {
  function armRoutes(syncs: { count: number }) {
    routeTransport({
      [RPC.blacklist_auth_state]: AUTH_LOGGED_IN,
      [RPC.blacklist_snapshot]: {
        ...FRESH_SNAPSHOT,
        lastSyncedAt: NOW_SEC - 100 * 3600,
      },
      [RPC.blacklist_load_config]: { autoSync: true, intervalHours: 24 },
      [RPC.blacklist_sync_now]: () => {
        syncs.count += 1;
        return { realm: "eu", ok: true, fetched: 2, resolved: 2, message: null };
      },
    });
  }

  it("pulls when logged in, enabled and stale past the interval", async () => {
    const syncs = { count: 0 };
    armRoutes(syncs);
    const store = useBlacklistStore();
    await store.ensureRealm("eu");
    await store.autoSyncIfDue();
    expect(syncs.count).toBe(1);
  });

  it("skips a fresh snapshot", async () => {
    const syncs = { count: 0 };
    armRoutes(syncs);
    const store = useBlacklistStore();
    await store.ensureRealm("eu");
    // The armed snapshot is 100 h old; shorten the interval to make it FRESH.
    store.config = { autoSync: true, intervalHours: 168 };
    await store.autoSyncIfDue();
    expect(syncs.count).toBe(0);
  });

  it("skips when auto-sync is disabled", async () => {
    const syncs = { count: 0 };
    armRoutes(syncs);
    const store = useBlacklistStore();
    await store.ensureRealm("eu");
    store.config = { autoSync: false, intervalHours: 24 };
    await store.autoSyncIfDue();
    expect(syncs.count).toBe(0);
  });

  it("skips when logged out", async () => {
    const syncs = { count: 0 };
    routeTransport({
      [RPC.blacklist_auth_state]: {
        realm: "eu",
        platform: "wargaming",
        loggedIn: false,
        accountId: null,
        nickname: null,
        expiresAt: null,
      },
      [RPC.blacklist_snapshot]: null,
      [RPC.blacklist_load_config]: { autoSync: true, intervalHours: 24 },
      [RPC.blacklist_sync_now]: () => {
        syncs.count += 1;
        return { realm: "eu", ok: true, fetched: 0, resolved: 0, message: null };
      },
    });
    const store = useBlacklistStore();
    await store.ensureRealm("eu");
    await store.autoSyncIfDue();
    expect(syncs.count).toBe(0);
  });
});

describe("saveConfig round-trip", () => {
  it("adopts the SANITIZED response", async () => {
    routeTransport({
      [RPC.blacklist_auth_state]: AUTH_LOGGED_IN,
      [RPC.blacklist_snapshot]: FRESH_SNAPSHOT,
      [RPC.blacklist_load_config]: { autoSync: true, intervalHours: 24 },
      // The backend clamps interval_hours — the response, not the optimistic
      // local copy, becomes the store's config.
      [RPC.blacklist_save_config]: (args: Record<string, unknown>) => ({
        ...((args.config ?? {}) as { autoSync: boolean; intervalHours: number }),
        intervalHours: 24,
      }),
    });
    const store = useBlacklistStore();
    await store.ensureRealm("eu");
    store.config = { autoSync: true, intervalHours: 5000 };
    await store.saveConfig();
    expect(store.config.intervalHours).toBe(24);
  });

  it("never lets a wire-null response clobber the config (P0 regression)", async () => {
    routeTransport({
      [RPC.blacklist_auth_state]: AUTH_LOGGED_IN,
      [RPC.blacklist_snapshot]: FRESH_SNAPSHOT,
      [RPC.blacklist_load_config]: { autoSync: true, intervalHours: 24 },
      // The OLD backend shape returned () → null over IPC. The store must
      // not blindly assign whatever comes back.
      [RPC.blacklist_save_config]: () => null,
    });
    const store = useBlacklistStore();
    await store.ensureRealm("eu");
    await store.saveConfig();
    expect(store.config).toEqual({ autoSync: true, intervalHours: 24 });
  });
});
