/** Pairing store: host-form validation, persisted pairing-file round-trips
 *  and the pair→upsert flow — LAN and built-in-gateway targets — with a
 *  mocked api client so no transport is involved. Mirrors the statsPrefs
 *  store-test pattern. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PairedHost } from "./pairing";

// ── api mock: an in-memory appdata dir + scripted pairing calls ──────────
const appdata = new Map<string, string>();
let pairShouldFail: string | null = null;
let gamedataShouldFail: string | null = null;

vi.mock("@/api", () => ({
  GAMEDATA_SENTINEL: ":gamedata:",
  api: {
    appdataRead: vi.fn(async (file: string) => appdata.get(file) ?? null),
    appdataWrite: vi.fn(async (file: string, content: string) => {
      appdata.set(file, content);
      return null;
    }),
    pairingPair: vi.fn(async (target: { kind: string }, _pin: string) => {
      if (pairShouldFail) throw new Error(pairShouldFail);
      const tag = target.kind === "lan" ? "lan" : "relay";
      return {
        token: `tok-${tag}`,
        // Internet mode echoes a room key; LAN mode doesn't.
        room: target.kind === "relay" ? "room-abc" : undefined,
      };
    }),
    pairingListRemote: vi.fn(async () => []),
    pairingPullReplay: vi.fn(
      async (_target: unknown, _token: string, remoteName: string) => {
        if (remoteName === "nope.wowsreplay") throw new Error("invalid or expired token");
        return { path: `/mock/${remoteName}` };
      },
    ),
    pairingPullGamedata: vi.fn(async () => {
      if (gamedataShouldFail) throw new Error(gamedataShouldFail);
      return { files: 3 };
    }),
    importReplayFile: vi.fn(async (name: string) => {
      if (name === "bad.wowsreplay") throw new Error("not a replay file");
      return { path: `/mock/${name}` };
    }),
    pairingGetStatus: vi.fn(async () => ({
      running: false,
      mode: null,
      relayOnline: false,
    })),
    pairingStart: vi.fn(async () => ({
      running: true,
      mode: "relay",
      relayOnline: true,
      pin: "123456",
    })),
    pairingStop: vi.fn(async () => null),
    pairingReallocateCode: vi.fn(async () => ({
      running: true,
      mode: "relay",
      relayOnline: true,
      pin: "654321",
    })),
    pairingDiscoveryStart: vi.fn(async () => null),
    pairingDiscoveryStop: vi.fn(async () => null),
    listenPairingDiscovery: undefined,
    pairingGetRelayConfig: vi.fn(async () => ({ enabled: true })),
    pairingSetRelay: vi.fn(async () => null),
    listenPairingProgress: undefined,
  },
}));

import {
  PAIRING_GATEWAY_WS,
  entryKey,
  gatewayTarget,
  hostKey,
  parseHostInput,
  parseHostsFile,
  parsePairingFile,
  sessionTargetOf,
  usePairingStore,
} from "./pairing";

beforeEach(() => {
  appdata.clear();
  pairShouldFail = null;
  gamedataShouldFail = null;
  vi.clearAllMocks();
  setActivePinia(createPinia());
});

describe("parseHostInput", () => {
  it("accepts a trimmed host and an integer port", () => {
    expect(parseHostInput("  192.0.2.10 ", " 58041 ")).toEqual({
      host: "192.0.2.10",
      port: 58041,
    });
    expect(parseHostInput("desktop.lan", 58041)).toEqual({
      host: "desktop.lan",
      port: 58041,
    });
  });

  it("rejects an empty host or a bad port", () => {
    expect(parseHostInput("", "58041")).toBeNull();
    expect(parseHostInput("   ", "58041")).toBeNull();
    expect(parseHostInput("192.0.2.10", "")).toBeNull();
    expect(parseHostInput("192.0.2.10", "http")).toBeNull();
    expect(parseHostInput("192.0.2.10", "0")).toBeNull();
    expect(parseHostInput("192.0.2.10", "65536")).toBeNull();
    expect(parseHostInput("192.0.2.10", "58041.5")).toBeNull();
  });
});

describe("parsePairingFile", () => {
  const entry: PairedHost = {
    host: "192.0.2.10",
    port: 58041,
    token: "tok",
    label: "Study PC",
    lastSeen: 1,
    mode: "lan",
  };

  it("round-trips a stored list", () => {
    const raw = JSON.stringify({ hosts: [entry] });
    expect(parseHostsFile(raw)).toEqual([entry]);
  });

  it("tolerates null / corrupt / wrong-shape payloads", () => {
    expect(parseHostsFile(null)).toEqual([]);
    expect(parseHostsFile("")).toEqual([]);
    expect(parseHostsFile("{not json")).toEqual([]);
    expect(parseHostsFile("{}")).toEqual([]);
    expect(parseHostsFile(JSON.stringify({ hosts: "nope" }))).toEqual([]);
    // Individual entries missing required fields are dropped, not fatal.
    expect(
      parseHostsFile(
        JSON.stringify({ hosts: [{ host: "x" }, { port: 1, token: "t" }, entry] }),
      ),
    ).toEqual([entry]);
  });

  it("tolerates legacy relayUrl keys (v2 ignores them — endpoint is built in)", () => {
    const entry: PairedHost = {
      host: "192.0.2.10",
      port: 58041,
      token: "tok",
      label: "Study PC",
      lastSeen: 1,
      mode: "lan",
    };
    const parsed = parsePairingFile(
      JSON.stringify({ hosts: [entry], relayUrl: "https://wowsp-pairing.example.workers.dev" }),
    );
    expect(parsed.hosts).toHaveLength(1);
    expect("relayUrl" in parsed).toBe(false);
    // Blank relay URLs are equally harmless.
    expect(parsePairingFile(JSON.stringify({ hosts: [], relayUrl: "  " }))).toEqual({ hosts: [] });
  });
});

describe("pairing store", () => {
  it("loads the persisted host list", async () => {
    appdata.set(
      "pairing-hosts.json",
      JSON.stringify({
        hosts: [
          {
            host: "192.0.2.10",
            port: 58041,
            token: "tok",
            label: "Study PC",
            lastSeen: 123,
            mode: "lan",
          },
        ],
      }),
    );
    const store = usePairingStore();
    await store.load();
    expect(store.hosts).toHaveLength(1);
    expect(store.hosts[0]).toMatchObject({ host: "192.0.2.10", port: 58041 });
    expect(store.loaded).toBe(true);
  });

  it("pairAndSave upserts by host:port and persists (LAN)", async () => {
    const store = usePairingStore();
    const first = await store.pairAndSave(
      { kind: "lan", host: "192.0.2.10", port: 58041 },
      "123456",
    );
    expect(first.token).toBe("tok-lan");
    expect(first.mode).toBe("lan");
    expect(first.label).toBe("192.0.2.10:58041");
    expect(store.hosts).toHaveLength(1);

    // Re-pairing the same host:port replaces (new token), never duplicates.
    const second = await store.pairAndSave(
      { kind: "lan", host: "192.0.2.10", port: 58041 },
      "654321",
      "Study PC",
    );
    expect(store.hosts).toHaveLength(1);
    expect(second.label).toBe("Study PC");
    // A different port is a different host.
    await store.pairAndSave({ kind: "lan", host: "192.0.2.10", port: 58042 }, "123456");
    expect(store.hosts).toHaveLength(2);

    const raw = appdata.get("pairing-hosts.json");
    expect(raw).toBeTruthy();
    expect(parseHostsFile(raw)).toHaveLength(2);
  });

  it("pairAndSave stores the internet session (gateway + room) keyed per gateway URL", async () => {
    const store = usePairingStore();
    const entry = await store.pairAndSave(gatewayTarget(), "123456");
    expect(entry.mode).toBe("relay");
    expect(entry.room).toBe("room-abc");
    expect(entry.relayUrl).toBe(PAIRING_GATEWAY_WS);
    // Session targets re-derive the tunnel address from the built-in
    // gateway (never a user-configured URL) + the stored room key.
    expect(sessionTargetOf(entry)).toEqual({
      kind: "relay",
      url: PAIRING_GATEWAY_WS,
      room: "room-abc",
    });

    // Re-pairing through the gateway replaces the entry.
    await store.pairAndSave(gatewayTarget(), "654321");
    expect(store.hosts).toHaveLength(1);
    expect(JSON.parse(appdata.get("pairing-hosts.json")!).hosts).toHaveLength(1);
  });

  it("sessionTargetOf falls back to the built-in gateway for legacy entries without a URL", () => {
    const legacy: PairedHost = {
      host: "",
      port: 0,
      token: "t",
      label: "R",
      lastSeen: 0,
      mode: "relay",
      room: "room-legacy",
    };
    expect(sessionTargetOf(legacy)).toEqual({
      kind: "relay",
      url: PAIRING_GATEWAY_WS,
      room: "room-legacy",
    });
  });

  it("pairAndSave failure leaves the stored list untouched", async () => {
    const store = usePairingStore();
    await store.pairAndSave({ kind: "lan", host: "192.0.2.10", port: 58041 }, "123456");
    const before = JSON.stringify(store.hosts);
    pairShouldFail = "invalid PIN";
    await expect(
      store.pairAndSave({ kind: "lan", host: "198.51.100.7", port: 58041 }, "000000"),
    ).rejects.toThrow("invalid PIN");
    expect(JSON.stringify(store.hosts)).toBe(before);
    expect(parseHostsFile(appdata.get("pairing-hosts.json"))).toHaveLength(1);
  });

  it("removes a host by identity and persists", async () => {
    const store = usePairingStore();
    await store.pairAndSave({ kind: "lan", host: "192.0.2.10", port: 58041 }, "123456");
    await store.pairAndSave({ kind: "lan", host: "192.0.2.10", port: 58042 }, "123456");
    store.removeHost("192.0.2.10", 58041);
    expect(store.hosts.map((h) => h.port)).toEqual([58042]);
    // Removal is persisted too (async settle of the fire-and-forget write).
    await Promise.resolve();
    await Promise.resolve();
    expect(parseHostsFile(appdata.get("pairing-hosts.json"))).toHaveLength(1);
  });

  it("hostKey is case-insensitive on the host; entryKey is mode-aware", () => {
    expect(hostKey("Desktop.LAN", 58041)).toBe(hostKey("desktop.lan", 58041));
    expect(hostKey("a", 1)).not.toBe(hostKey("a", 2));
    const relay: PairedHost = {
      host: "",
      port: 0,
      token: "t",
      label: "R",
      lastSeen: 0,
      mode: "relay",
      relayUrl: "https://wowsp-pairing.example.workers.dev",
      room: "r",
    };
    expect(entryKey(relay)).toBe("relay:https://wowsp-pairing.example.workers.dev");
  });

  it("removeEntry forgets one internet entry by identity (host:port cannot express them)", async () => {
    const store = usePairingStore();
    const lanEntry = await store.pairAndSave(
      { kind: "lan", host: "192.0.2.10", port: 58041 },
      "123456",
    );
    const relayA = await store.pairAndSave(gatewayTarget(), "123456", "PC-A");
    const relayB = await store.pairAndSave(
      { kind: "relay", url: "https://other-gateway.example.workers.dev" },
      "123456",
      "PC-B",
    );
    expect(store.hosts).toHaveLength(3);
    // Forgetting ONE internet entry leaves the other + the LAN host alone.
    store.removeEntry(relayA);
    expect(store.hosts.map((h) => entryKey(h))).toEqual([entryKey(lanEntry), entryKey(relayB)]);
    await Promise.resolve();
    await Promise.resolve();
    expect(parseHostsFile(appdata.get("pairing-hosts.json"))).toHaveLength(2);
  });

  it("reallocateCode refreshes the server status through the api", async () => {
    const store = usePairingStore();
    await store.reallocateCode();
    expect(store.server).toMatchObject({ running: true, pin: "654321", relayOnline: true });
  });

  it("importFiles reports per-file outcomes", async () => {
    const store = usePairingStore();
    const { imported, failed } = await store.importFiles([
      { name: "20260918_213010.wowsreplay", bytes: new Uint8Array(4) },
      { name: "bad.wowsreplay", bytes: new Uint8Array(4) },
    ]);
    expect(imported).toEqual(["/mock/20260918_213010.wowsreplay"]);
    expect(failed).toEqual([
      { name: "bad.wowsreplay", error: "not a replay file" },
    ]);
  });

  it("pullReplay surfaces transport failures as an error progress entry", async () => {
    const store = usePairingStore();
    const entry: PairedHost = {
      host: "192.0.2.10",
      port: 58041,
      token: "tok-lan",
      label: "PC",
      lastSeen: 0,
      mode: "lan",
    };
    await expect(store.pullReplay(entry, "nope.wowsreplay")).rejects.toThrow();
    expect(store.progressByFile["nope.wowsreplay"]).toMatchObject({ phase: "error" });
  });

  it("syncGamedata resolves with the file count and never pollutes progressByFile", async () => {
    const store = usePairingStore();
    const entry: PairedHost = {
      host: "192.0.2.10",
      port: 58041,
      token: "tok-lan",
      label: "PC",
      lastSeen: 0,
      mode: "lan",
    };
    const out = await store.syncGamedata(entry);
    expect(out).toEqual({ files: 3 });
    // The :gamedata: sentinel rides the shared stream but is kept out of the
    // per-replay progress map.
    expect(Object.keys(store.progressByFile)).not.toContain(":gamedata:");
  });

  it("syncGamedata failure lands in gamedataProgress", async () => {
    const store = usePairingStore();
    const entry: PairedHost = {
      host: "192.0.2.10",
      port: 58041,
      token: "tok-lan",
      label: "PC",
      lastSeen: 0,
      mode: "lan",
    };
    gamedataShouldFail = "no game data available on the host";
    await expect(store.syncGamedata(entry)).rejects.toThrow(
      "no game data available on the host",
    );
    expect(store.gamedataProgress).toMatchObject({ phase: "error" });
  });

  it("gateway toggle persists through the api (hidden setting, enabled by default)", async () => {
    const store = usePairingStore();
    await store.loadRelayConfig();
    expect(store.relayConfig).toEqual({ enabled: true });
    await store.saveRelayConfig({ enabled: false });
    expect(store.relayConfig.enabled).toBe(false);
    expect(store.relaySavedTick).toBe(1);
  });

  it("touchSeen is a no-op for an entry that is no longer stored", async () => {
    const store = usePairingStore();
    const ghost: PairedHost = {
      host: "192.0.2.10",
      port: 58041,
      token: "tok",
      label: "Ghost",
      lastSeen: 123,
      mode: "lan",
    };
    await store.touchSeen(ghost);
    expect(store.hosts).toHaveLength(0);
    // And it never persists an empty file for the ghost.
    await Promise.resolve();
    expect(appdata.has("pairing-hosts.json")).toBe(false);
  });

  it("touchSeen stamps lastSeen on a stored entry and persists", async () => {
    const store = usePairingStore();
    const entry = await store.pairAndSave(
      { kind: "lan", host: "192.0.2.10", port: 58041 },
      "123456",
    );
    const before = entry.lastSeen;
    entry.lastSeen = before - 60_000;
    await store.touchSeen(entry);
    expect(entry.lastSeen).toBeGreaterThanOrEqual(before);
    await Promise.resolve();
    await Promise.resolve();
    const raw = appdata.get("pairing-hosts.json");
    expect(parseHostsFile(raw)[0].lastSeen).toBeGreaterThanOrEqual(before);
  });

  it("startServer surfaces transport failures through serverError", async () => {
    const store = usePairingStore();
    const { api } = await import("@/api");
    (api.pairingStart as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("port 58041 already in use"),
    );
    await store.startServer();
    expect(store.serverBusy).toBe(false);
    expect(store.serverError).toBe("port 58041 already in use");
    expect(store.server).toBeNull();
  });

  it("stopServer refreshes the status after stopping", async () => {
    const store = usePairingStore();
    await store.startServer();
    expect(store.server).toMatchObject({ running: true });
    const { api } = await import("@/api");
    (api.pairingGetStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      running: false,
    });
    await store.stopServer();
    expect(store.server).toEqual({ running: false });
    expect(store.serverError).toBeNull();
  });
});
