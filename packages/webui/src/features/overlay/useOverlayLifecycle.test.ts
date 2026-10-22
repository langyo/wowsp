import { effectScope, reactive } from "vue";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: {
    createOverlayWindow: vi.fn(), destroyOverlayWindow: vi.fn(),
  },
  game: vi.fn(), installs: vi.fn(), config: vi.fn(), plugin: vi.fn(), account: vi.fn(),
}));
vi.mock("@/api", () => ({ api: mocks.api }));
vi.mock("@/i18n", () => ({
  i18n: { global: { locale: { value: "en-US" } } },
}));
vi.mock("@/stores/gameStatus", () => ({ useGameStatusStore: mocks.game }));
vi.mock("@/stores/config", () => ({ useConfigStore: mocks.installs }));
vi.mock("@/stores/overlayConfig", () => ({ useOverlayConfigStore: mocks.config }));
vi.mock("@/stores/ingamePlugin", () => ({ useIngamePluginStore: mocks.plugin }));
vi.mock("@/stores/account", () => ({ useAccountStore: mocks.account }));
import { useOverlayLifecycle } from "./useOverlayLifecycle";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

let scope = effectScope();
let game = reactive({ process: { running: true, realm: "asia" as string | null } });
let config = reactive({ table: "detect", aimCard: true, loaded: true, load: vi.fn(async () => {}) });
let installs = reactive({ activeInstall: null as { realm: string } | null });
let account = reactive({ activeRealm: "asia" });

beforeEach(() => {
  vi.resetAllMocks();
  scope = effectScope();
  game = reactive({ process: { running: true, realm: "asia" as string | null } });
  config = reactive({ table: "detect", aimCard: true, loaded: true, load: vi.fn(async () => {}) });
  installs = reactive({ activeInstall: null as { realm: string } | null });
  account = reactive({ activeRealm: "asia" });
  mocks.game.mockReturnValue(game);
  mocks.config.mockReturnValue(config);
  mocks.installs.mockReturnValue(installs);
  mocks.plugin.mockReturnValue(reactive({ liveSelfRealm: null }));
  mocks.account.mockReturnValue(account);
  for (const call of Object.values(mocks.api)) call.mockResolvedValue(null);
});

afterEach(() => { scope.stop(); });

describe("overlay lifecycle transitions", () => {
  it("waits for stored settings before starting the default overlay", async () => {
    config.loaded = false;
    scope.run(useOverlayLifecycle);
    await flushPromises();
    expect(mocks.api.createOverlayWindow).not.toHaveBeenCalled();
    config.table = "off";
    config.aimCard = false;
    config.loaded = true;
    await flushPromises();
    expect(mocks.api.createOverlayWindow).not.toHaveBeenCalled();
  });

  it.each(["off", "exit"])("retires a pending window when the desired state becomes %s", async (change) => {
    const creating = deferred();
    mocks.api.createOverlayWindow.mockReturnValueOnce(creating.promise);
    scope.run(useOverlayLifecycle);
    await flushPromises();
    expect(mocks.api.createOverlayWindow).toHaveBeenCalledTimes(1);
    if (change === "off") {
      config.table = "off";
      config.aimCard = false;
    } else {
      game.process.running = false;
    }
    await flushPromises();
    creating.resolve();
    await flushPromises();
    expect(mocks.api.destroyOverlayWindow).toHaveBeenCalledTimes(1);
  });

  it("reconciles a realm change after the old window finishes creating", async () => {
    const creating = deferred();
    mocks.api.createOverlayWindow.mockReturnValueOnce(creating.promise);
    scope.run(useOverlayLifecycle);
    await flushPromises();
    game.process.realm = "eu";
    await flushPromises();
    expect(mocks.api.createOverlayWindow).toHaveBeenCalledTimes(1);
    creating.resolve();
    await flushPromises();
    expect(mocks.api.destroyOverlayWindow).toHaveBeenCalledTimes(1);
    expect(mocks.api.createOverlayWindow).toHaveBeenLastCalledWith("eu", "en-US");
  });

  it("recreates when the selected installation changes the fallback realm", async () => {
    game.process.realm = null;
    installs.activeInstall = { realm: "asia" };
    scope.run(useOverlayLifecycle);
    await flushPromises();
    installs.activeInstall = { realm: "eu" };
    await flushPromises();
    expect(mocks.api.createOverlayWindow).toHaveBeenLastCalledWith("eu", "en-US");
    expect(mocks.api.destroyOverlayWindow).toHaveBeenCalledTimes(1);
  });

  it("falls back to the bound account's realm when every detection link is silent", async () => {
    // The records-dead client shape: no probe identity, no process realm,
    // an install scan that cannot name one — the chain's last link (the
    // bound account's realm) must still bake a usable realm into the
    // window URL, or every stats lookup of the session stays disabled.
    game.process.realm = null;
    scope.run(useOverlayLifecycle);
    await flushPromises();
    expect(mocks.api.createOverlayWindow).toHaveBeenLastCalledWith("asia", "en-US");
    // The account realm rides the watch list: flipping it re-bakes the URL.
    account.activeRealm = "eu";
    await flushPromises();
    expect(mocks.api.destroyOverlayWindow).toHaveBeenCalledTimes(1);
    expect(mocks.api.createOverlayWindow).toHaveBeenLastCalledWith("eu", "en-US");
  });

  it("prefers detection over the account realm when detection answers", async () => {
    game.process.realm = "na";
    scope.run(useOverlayLifecycle);
    await flushPromises();
    expect(mocks.api.createOverlayWindow).toHaveBeenLastCalledWith("na", "en-US");
  });

  it("retries a failed stop on the next transition instead of forgetting the window", async () => {
    scope.run(useOverlayLifecycle);
    await flushPromises();
    mocks.api.destroyOverlayWindow.mockRejectedValueOnce(new Error("synthetic window busy"));
    config.table = "off";
    config.aimCard = false;
    await flushPromises();
    game.process.realm = "eu";
    await flushPromises();
    expect(mocks.api.destroyOverlayWindow).toHaveBeenCalledTimes(2);
  });

  it("keeps the mode up while the aim-card switch alone wants a window", async () => {
    // The two window switches are independent: the mode (windows + watcher)
    // exists while EITHER switch wants a window — the watcher enforces each
    // switch per tick — and only both-off tears it down.
    config.table = "off";
    config.aimCard = false;
    scope.run(useOverlayLifecycle);
    await flushPromises();
    expect(mocks.api.createOverlayWindow).not.toHaveBeenCalled();
    config.aimCard = true;
    await flushPromises();
    expect(mocks.api.createOverlayWindow).toHaveBeenCalledTimes(1);
    config.aimCard = false;
    await flushPromises();
    expect(mocks.api.destroyOverlayWindow).toHaveBeenCalledTimes(1);
  });
});
