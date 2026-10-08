import { effectScope, reactive } from "vue";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: {
    createOverlayWindow: vi.fn(), destroyOverlayWindow: vi.fn(),
    startIngameBridge: vi.fn(), stopIngameBridge: vi.fn(),
  },
  game: vi.fn(), installs: vi.fn(), config: vi.fn(), plugin: vi.fn(),
}));
vi.mock("@/api", () => ({ api: mocks.api }));
vi.mock("@/i18n", () => ({ i18n: { global: { locale: { value: "en-US" } } } }));
vi.mock("@/stores/gameStatus", () => ({ useGameStatusStore: mocks.game }));
vi.mock("@/stores/config", () => ({ useConfigStore: mocks.installs }));
vi.mock("@/stores/overlayConfig", () => ({ useOverlayConfigStore: mocks.config }));
vi.mock("@/stores/ingamePlugin", () => ({ useIngamePluginStore: mocks.plugin }));
import { useOverlayLifecycle } from "./useOverlayLifecycle";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

let scope = effectScope();
let game = reactive({ process: { running: true, realm: "asia" as string | null } });
let config = reactive({ table: "detect", loaded: true, load: vi.fn(async () => {}) });
let installs = reactive({ activeInstall: null as { realm: string } | null });

beforeEach(() => {
  vi.resetAllMocks();
  scope = effectScope();
  game = reactive({ process: { running: true, realm: "asia" as string | null } });
  config = reactive({ table: "detect", loaded: true, load: vi.fn(async () => {}) });
  installs = reactive({ activeInstall: null as { realm: string } | null });
  mocks.game.mockReturnValue(game);
  mocks.config.mockReturnValue(config);
  mocks.installs.mockReturnValue(installs);
  mocks.plugin.mockReturnValue(reactive({ liveSelfRealm: null }));
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
    if (change === "off") config.table = "off";
    else game.process.running = false;
    await flushPromises();
    creating.resolve();
    await flushPromises();
    expect(mocks.api.destroyOverlayWindow).toHaveBeenCalledTimes(1);
  });

  it("retires a pending bridge after the user switches to off", async () => {
    config.table = "ingame";
    const starting = deferred();
    mocks.api.startIngameBridge.mockReturnValueOnce(starting.promise);
    scope.run(useOverlayLifecycle);
    await flushPromises();
    config.table = "off";
    await flushPromises();
    starting.resolve();
    await flushPromises();
    expect(mocks.api.stopIngameBridge).toHaveBeenCalledTimes(1);
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

  it("retries a failed stop on the next transition instead of forgetting the window", async () => {
    scope.run(useOverlayLifecycle);
    await flushPromises();
    mocks.api.destroyOverlayWindow.mockRejectedValueOnce(new Error("synthetic window busy"));
    config.table = "off";
    await flushPromises();
    game.process.realm = "eu";
    await flushPromises();
    expect(mocks.api.destroyOverlayWindow).toHaveBeenCalledTimes(2);
  });

  it("stops the old bridge before starting the overlay backend", async () => {
    config.table = "ingame";
    scope.run(useOverlayLifecycle);
    await flushPromises();
    const stopping = deferred();
    mocks.api.stopIngameBridge.mockReturnValueOnce(stopping.promise);
    config.table = "detect";
    await flushPromises();
    expect(mocks.api.stopIngameBridge).toHaveBeenCalledTimes(1);
    expect(mocks.api.createOverlayWindow).not.toHaveBeenCalled();
    stopping.resolve();
    await flushPromises();
    expect(mocks.api.createOverlayWindow).toHaveBeenCalledTimes(1);
  });

  it("does not launch a second backend when the old one failed to stop", async () => {
    scope.run(useOverlayLifecycle);
    await flushPromises();
    mocks.api.destroyOverlayWindow.mockRejectedValueOnce(new Error("synthetic window busy"));
    config.table = "ingame";
    await flushPromises();
    expect(mocks.api.startIngameBridge).not.toHaveBeenCalled();
    game.process.realm = "eu";
    await flushPromises();
    expect(mocks.api.destroyOverlayWindow).toHaveBeenCalledTimes(2);
    expect(mocks.api.startIngameBridge).toHaveBeenCalledTimes(1);
  });

  it.each(["detect", "ingame"])("does not start a cancelled %s replacement after teardown finishes", async (replacement) => {
    config.table = replacement === "detect" ? "ingame" : "detect";
    scope.run(useOverlayLifecycle);
    await flushPromises();
    const stopping = deferred();
    const stop = replacement === "detect" ? mocks.api.stopIngameBridge : mocks.api.destroyOverlayWindow;
    const start = replacement === "detect" ? mocks.api.createOverlayWindow : mocks.api.startIngameBridge;
    stop.mockReturnValueOnce(stopping.promise);
    config.table = replacement;
    await flushPromises();
    config.table = "off";
    await flushPromises();
    stopping.resolve();
    await flushPromises();
    expect(start).not.toHaveBeenCalled();
  });
});
