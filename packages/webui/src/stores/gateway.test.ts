/** Gateway store: config load/save, the health cache, state-event routing
 *  (pub vs sub), the battle-frame state machine (battle → bye → host) and
 *  the socket command pass-throughs. The api module is mocked; the event
 *  handlers the store wires at creation are captured and fired by hand. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  getHealth: vi.fn(),
  publishStart: vi.fn(),
  publishStop: vi.fn(),
  subscribeStart: vi.fn(),
  subscribeStop: vi.fn(),
  selfhostProbe: vi.fn(),
  selfhostStep: vi.fn(),
  stateHandlers: [] as ((s: unknown) => void)[],
  battleHandlers: [] as ((f: unknown) => void)[],
  selfhostHandlers: [] as ((s: unknown) => void)[],
}));

vi.mock("@/api", () => ({
  api: {
    gatewayGetConfig: mocks.getConfig,
    gatewaySetConfig: mocks.setConfig,
    gatewayGetHealth: mocks.getHealth,
    gatewayOpenSession: vi.fn(),
    gatewayPublishStart: mocks.publishStart,
    gatewayPublishStop: mocks.publishStop,
    gatewaySubscribeStart: mocks.subscribeStart,
    gatewaySubscribeStop: mocks.subscribeStop,
    gatewaySelfhostProbe: mocks.selfhostProbe,
    gatewaySelfhostStep: mocks.selfhostStep,
    listenGatewayState: (h: (s: unknown) => void) => {
      mocks.stateHandlers.push(h);
      return Promise.resolve(() => undefined);
    },
    listenGatewayBattle: (h: (f: unknown) => void) => {
      mocks.battleHandlers.push(h);
      return Promise.resolve(() => undefined);
    },
    listenGatewaySelfhost: (h: (s: unknown) => void) => {
      mocks.selfhostHandlers.push(h);
      return Promise.resolve(() => undefined);
    },
  },
  GATEWAY_OFFICIAL_ROOT: "https://wowsp.langyo.xyz/gateway/",
  GATEWAY_ROUTE_RE: /^r:[a-z]{2,5}:[0-9]+$/,
}));

import { useGatewayStore } from "./gateway";

const OFFICIAL = "https://wowsp.langyo.xyz/gateway/";

function emitState(s: Record<string, unknown>): void {
  for (const h of mocks.stateHandlers) h(s);
}
function emitBattle(f: unknown): void {
  for (const h of mocks.battleHandlers) h(f);
}

function battleFrame(): Record<string, unknown> {
  return {
    type: "battle",
    realm: "asia",
    route: "r:asia:123",
    self: { name: "Tester", accountId: 123 },
    battle: {
      dateTime: "29.10.2026 22:00:00",
      matchGroup: "pvp",
      vehicles: [
        { id: 123, name: "Tester", relation: 0, shipId: 10, shipName: "Yamato" },
      ],
    },
  };
}

beforeEach(() => {
  const pinia = createPinia();
  setActivePinia(pinia);
  mocks.stateHandlers.length = 0;
  mocks.battleHandlers.length = 0;
  mocks.selfhostHandlers.length = 0;
  for (const m of [
    mocks.getConfig,
    mocks.setConfig,
    mocks.getHealth,
    mocks.publishStart,
    mocks.publishStop,
    mocks.subscribeStart,
    mocks.subscribeStop,
    mocks.selfhostProbe,
    mocks.selfhostStep,
  ]) {
    m.mockReset();
  }
});

describe("gateway config", () => {
  it("loads the persisted route entry and toggle", async () => {
    mocks.getConfig.mockResolvedValue({ root: OFFICIAL, enabled: false });
    const gateway = useGatewayStore();
    await gateway.loadConfig();
    expect(gateway.config.root).toBe(OFFICIAL);
    expect(gateway.config.enabled).toBe(false);
    expect(gateway.configLoaded).toBe(true);
    expect(gateway.isCustomRoot).toBe(false);
  });

  it("saves a patch and keeps the normalized echo", async () => {
    mocks.setConfig.mockResolvedValue({
      root: "https://gateway.example.com/gateway/",
      enabled: true,
    });
    const gateway = useGatewayStore();
    await gateway.saveConfig({ root: "https://gateway.example.com", enabled: true });
    expect(mocks.setConfig).toHaveBeenCalledWith({
      root: "https://gateway.example.com",
      enabled: true,
    });
    expect(gateway.config.root).toBe("https://gateway.example.com/gateway/");
    expect(gateway.isCustomRoot).toBe(true);
  });

  it("records the save error without throwing it out of the ref", async () => {
    mocks.setConfig.mockRejectedValue(new Error("gateway root must be an https URL"));
    const gateway = useGatewayStore();
    await expect(gateway.saveConfig({ root: "ftp://nope" })).rejects.toThrow(
      "gateway root must be an https URL",
    );
    expect(gateway.configError).toBe("gateway root must be an https URL");
  });
});

describe("health cache", () => {
  it("caches a resolved document per root (trailing-slash folded)", async () => {
    const doc = { gateway: "v1", auth: { turnstile: { required: false }, password: { required: false } } };
    mocks.getHealth.mockResolvedValue(doc);
    const gateway = useGatewayStore();
    await gateway.resolveHealth(OFFICIAL);
    await gateway.resolveHealth("https://wowsp.langyo.xyz/gateway");
    expect(mocks.getHealth).toHaveBeenCalledTimes(1);
    expect(await gateway.resolveHealth(OFFICIAL)).toStrictEqual(doc);
  });

  it("force re-resolves and keeps failures out of the cache", async () => {
    const doc = { gateway: "v1", auth: { turnstile: { required: false }, password: { required: false } } };
    mocks.getHealth.mockResolvedValueOnce(doc).mockRejectedValueOnce(
      new Error("gateway unreachable or health document invalid"),
    );
    const gateway = useGatewayStore();
    await gateway.resolveHealth(OFFICIAL);
    await expect(gateway.resolveHealth(OFFICIAL, true)).rejects.toThrow(
      "gateway unreachable or health document invalid",
    );
    // The failure must not poison the cache: the next pass re-fetches.
    mocks.getHealth.mockResolvedValue(doc);
    await expect(gateway.resolveHealth(OFFICIAL, true)).resolves.toBe(doc);
  });
});

describe("state events", () => {
  it("routes pub and sub phases into their own slots", () => {
    const gateway = useGatewayStore();
    emitState({ role: "pub", route: "r:asia:1", phase: "captcha", detail: null });
    emitState({ role: "sub", route: "r:asia:2", phase: "online", detail: null });
    expect(gateway.pubPhase).toBe("captcha");
    expect(gateway.subPhase).toBe("online");
    emitState({ role: "pub", phase: "error", detail: "gateway unreachable or health document invalid" });
    expect(gateway.pubPhase).toBe("error");
    expect(gateway.pubDetail).toBe("gateway unreachable or health document invalid");
  });
});

describe("battle frames", () => {
  it("battle → bye → host drive the live view's state machine", () => {
    const gateway = useGatewayStore();
    emitBattle(battleFrame());
    expect(gateway.battle?.type).toBe("battle");
    expect(gateway.battle?.battle.vehicles[0].name).toBe("Tester");
    expect(gateway.battleEnded).toBe(false);

    emitBattle({ type: "host", online: true });
    expect(gateway.hostOnline).toBe(true);

    emitBattle({ type: "bye" });
    expect(gateway.battleEnded).toBe(true);
    // The last battle stays rendered for review.
    expect(gateway.battle?.type).toBe("battle");

    emitBattle({ type: "host", online: false });
    expect(gateway.hostOnline).toBe(false);
  });

  it("ignores malformed frames instead of throwing", () => {
    const gateway = useGatewayStore();
    emitBattle({ type: "nope" });
    emitBattle(null);
    expect(gateway.battle).toBeNull();
    expect(gateway.battleEnded).toBe(false);
  });

  it("a fresh battle clears the ended flag", () => {
    const gateway = useGatewayStore();
    emitBattle(battleFrame());
    emitBattle({ type: "bye" });
    expect(gateway.battleEnded).toBe(true);
    emitBattle(battleFrame());
    expect(gateway.battleEnded).toBe(false);
  });

  it("clearBattle resets the receive pass", () => {
    const gateway = useGatewayStore();
    emitBattle(battleFrame());
    emitBattle({ type: "host", online: true });
    gateway.clearBattle();
    expect(gateway.battle).toBeNull();
    expect(gateway.battleEnded).toBe(false);
    expect(gateway.hostOnline).toBeNull();
  });
});

describe("selfhost wizard", () => {
  it("runSelfhostStep forwards the step args verbatim (domain/kvId/repoDir)", async () => {
    mocks.selfhostStep.mockResolvedValue({ step: "deploy" });
    const gateway = useGatewayStore();
    await gateway.runSelfhostStep("deploy", {
      domain: "gateway.example.com",
      kvId: "kv-1",
      repoDir: "D:\\wowsp",
    });
    expect(mocks.selfhostStep).toHaveBeenCalledWith("deploy", {
      domain: "gateway.example.com",
      kvId: "kv-1",
      repoDir: "D:\\wowsp",
    });
  });

  it("the wizard's repo path persists through localStorage (empty clears)", () => {
    localStorage.clear();
    const gateway = useGatewayStore();
    expect(gateway.selfhostRepo).toBe("");

    gateway.setSelfhostRepo("  D:/src/wowsp  ");
    expect(gateway.selfhostRepo).toBe("D:/src/wowsp");
    expect(localStorage.getItem("wowsp-selfhost-repo")).toBe("D:/src/wowsp");

    gateway.setSelfhostRepo("   ");
    expect(gateway.selfhostRepo).toBe("");
    expect(localStorage.getItem("wowsp-selfhost-repo")).toBeNull();
    localStorage.clear();
  });
});

describe("sockets", () => {
  it("startPublish passes the route and credentials", async () => {
    mocks.publishStart.mockResolvedValue(null);
    const gateway = useGatewayStore();
    await gateway.startPublish("r:asia:1", { turnstileToken: "tok" });
    expect(mocks.publishStart).toHaveBeenCalledWith({
      route: "r:asia:1",
      turnstileToken: "tok",
    });
    expect(gateway.pubRoute).toBe("r:asia:1");
  });

  it("stopPublish settles the phase even when the call rejects", async () => {
    mocks.publishStop.mockRejectedValue(new Error("already gone"));
    const gateway = useGatewayStore();
    await expect(gateway.stopPublish()).rejects.toThrow("already gone");
    expect(gateway.pubPhase).toBe("stopped");
  });

  it("startSubscribe carries root + route; stopSubscribe settles", async () => {
    mocks.subscribeStart.mockResolvedValue(null);
    mocks.subscribeStop.mockResolvedValue(null);
    const gateway = useGatewayStore();
    await gateway.startSubscribe(OFFICIAL, "r:asia:2", { password: "pw" });
    expect(mocks.subscribeStart).toHaveBeenCalledWith({
      root: OFFICIAL,
      route: "r:asia:2",
      password: "pw",
    });
    await gateway.stopSubscribe();
    expect(gateway.subPhase).toBe("stopped");
  });
});
