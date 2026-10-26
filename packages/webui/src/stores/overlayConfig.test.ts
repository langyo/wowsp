import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";

const { apiMock } = vi.hoisted(() => ({
  apiMock: { getOverlayConfig: vi.fn(), setOverlayConfig: vi.fn() },
}));
vi.mock("@/api", () => ({ api: apiMock }));
import { useOverlayConfigStore } from "./overlayConfig";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
  apiMock.getOverlayConfig.mockResolvedValue({
    table: "detect",
    roster: "plugin",
    aimCard: true,
    aimCardHangPx: 60,
    chatPanel: false,
    chatPanelMaxLines: 8,
  });
  apiMock.setOverlayConfig.mockImplementation(
    async (
      table: string,
      roster: string,
      aimCard: boolean,
      aimCardHangPx: number,
      chatPanel: boolean,
      chatPanelMaxLines: number,
    ) => ({ table, roster, aimCard, aimCardHangPx, chatPanel, chatPanelMaxLines }),
  );
});

describe("overlay settings persistence", () => {
  it("keeps every loader waiting for the same initial settings", async () => {
    const read = deferred<{ table: string; roster: string; aimCard: boolean }>();
    apiMock.getOverlayConfig.mockReturnValueOnce(read.promise);
    const store = useOverlayConfigStore();
    const first = store.load();
    let secondFinished = false;
    const second = store.load().then(() => { secondFinished = true; });
    await flushPromises();
    expect(store.loaded).toBe(false);
    expect(secondFinished).toBe(false);
    expect(apiMock.getOverlayConfig).toHaveBeenCalledTimes(1);
    read.resolve({ table: "off", roster: "passive", aimCard: false });
    await Promise.all([first, second]);
    expect(store.loaded).toBe(true);
    expect(store.table).toBe("off");
    expect(store.aimCard).toBe(false);
  });

  it("maps a stored in-game panel pick onto the overlay window mode", async () => {
    // The retired "ingame" backend's picks land on the detect default —
    // the overlay window takes over as the display backend (the Rust side
    // heals the stored file to the same value).
    apiMock.getOverlayConfig.mockResolvedValueOnce({ table: "ingame", roster: "plugin", aimCard: true });
    const store = useOverlayConfigStore();
    await store.load();
    expect(store.table).toBe("detect");
  });

  it("lands a non-boolean aim-card reply on the enabled default", async () => {
    // An older shell without the aim-card field (or a corrupted one) must
    // not flip the card off — the tolerant parse mirrors the Rust side.
    apiMock.getOverlayConfig.mockResolvedValueOnce({ table: "detect", roster: "plugin", aimCard: "off" });
    const store = useOverlayConfigStore();
    await store.load();
    expect(store.aimCard).toBe(true);
  });

  it("loads the untouched setting before persisting a choice made during startup", async () => {
    const read = deferred<{ table: string; roster: string; aimCard: boolean }>();
    apiMock.getOverlayConfig.mockReturnValueOnce(read.promise);
    const store = useOverlayConfigStore();
    const loading = store.load();
    const changing = store.setTable("off");
    await flushPromises();
    expect(apiMock.setOverlayConfig).not.toHaveBeenCalled();
    read.resolve({ table: "ingame", roster: "passive", aimCard: true });
    await Promise.all([loading, changing]);
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("off", "passive", true, 60, false, 8);
    expect(store.table).toBe("off");
    expect(store.roster).toBe("passive");
  });

  it("orders writes and never applies an older reply over a newer choice", async () => {
    const store = useOverlayConfigStore();
    await store.load();
    const firstWrite = deferred<{ table: string; roster: string; aimCard: boolean }>();
    apiMock.setOverlayConfig.mockReturnValueOnce(firstWrite.promise);
    const first = store.setTable("off");
    await flushPromises();
    const second = store.setRoster("passive");
    await flushPromises();
    expect(apiMock.setOverlayConfig).toHaveBeenCalledTimes(1);
    firstWrite.resolve({ table: "off", roster: "plugin", aimCard: true });
    await Promise.all([first, second]);
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("off", "passive", true, 60, false, 8);
    expect(store.table).toBe("off");
    expect(store.roster).toBe("passive");
  });

  it("continues saving after a failure without losing the in-memory choices", async () => {
    const store = useOverlayConfigStore();
    await store.load();
    apiMock.setOverlayConfig.mockRejectedValueOnce(new Error("synthetic locked settings"));
    await store.setTable("off");
    await store.setRoster("passive");
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("off", "passive", true, 60, false, 8);
    expect(store.table).toBe("off");
    expect(store.roster).toBe("passive");
  });

  it("persists the aim-card switch independently of the table switch", async () => {
    const store = useOverlayConfigStore();
    await store.load();
    await store.setAimCard(false);
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("detect", "plugin", false, 60, false, 8);
    expect(store.aimCard).toBe(false);
    // The table switch stays untouched by an aim-card flip, and the next
    // write carries both current choices.
    expect(store.table).toBe("detect");
    await store.setTable("off");
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("off", "plugin", false, 60, false, 8);
  });

  it("commits the aim-card hang with rounding, a zero floor and no ceiling", async () => {
    const store = useOverlayConfigStore();
    await store.load();
    // Below the slider's 60 floor and far above its 240 ceiling both ride
    // through — the box is deliberately unbounded; only negatives clamp.
    await store.setAimCardHangPx(30);
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("detect", "plugin", true, 30, false, 8);
    await store.setAimCardHangPx(480);
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("detect", "plugin", true, 480, false, 8);
    expect(store.aimCardHangPx).toBe(480);
    await store.setAimCardHangPx(-25);
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("detect", "plugin", true, 0, false, 8);
    expect(store.aimCardHangPx).toBe(0);
    await store.setAimCardHangPx(137.6);
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("detect", "plugin", true, 138, false, 8);
    // A non-finite input is ignored outright (the box reverts its draft).
    await store.setAimCardHangPx(Number.NaN);
    expect(store.aimCardHangPx).toBe(138);
    // A no-op value (already current) skips the IPC round-trip entirely.
    apiMock.setOverlayConfig.mockClear();
    await store.setAimCardHangPx(138);
    expect(apiMock.setOverlayConfig).not.toHaveBeenCalled();
  });

  it("lands a missing or junk hang reply on the 60 default", async () => {
    // An older shell without the field (or a corrupted one) must not drag
    // the hang to NaN/0 — the tolerant parse mirrors the Rust heal.
    apiMock.getOverlayConfig.mockResolvedValueOnce({ table: "detect", roster: "plugin", aimCard: true });
    const store = useOverlayConfigStore();
    await store.load();
    expect(store.aimCardHangPx).toBe(60);
    apiMock.getOverlayConfig.mockResolvedValueOnce({ table: "detect", roster: "plugin", aimCard: true, aimCardHangPx: "far" });
    await store.load();
    expect(store.aimCardHangPx).toBe(60);
  });

  it("persists the chat card's switch and line cap independently", async () => {
    const store = useOverlayConfigStore();
    await store.load();
    expect(store.chatPanel).toBe(false);
    expect(store.chatPanelMaxLines).toBe(8);
    await store.setChatPanel(true);
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("detect", "plugin", true, 60, true, 8);
    expect(store.chatPanel).toBe(true);
    // The other switches stay untouched by the chat-card flips, and every
    // later write carries the chat fields too.
    await store.setChatPanelMaxLines(12);
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("detect", "plugin", true, 60, true, 12);
    expect(store.chatPanelMaxLines).toBe(12);
    expect(store.aimCard).toBe(true);
    expect(store.chatPanel).toBe(true);
  });

  it("clamps the chat line cap to the shell's 3–30 band", async () => {
    const store = useOverlayConfigStore();
    await store.load();
    // Both ends of the band clamp; fractional input rounds first.
    await store.setChatPanelMaxLines(1);
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("detect", "plugin", true, 60, false, 3);
    await store.setChatPanelMaxLines(99);
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("detect", "plugin", true, 60, false, 30);
    await store.setChatPanelMaxLines(21.6);
    expect(store.chatPanelMaxLines).toBe(22);
    // A non-finite input is ignored outright (the slider cannot emit one,
    // but an older/hostile shell merge could).
    await store.setChatPanelMaxLines(Number.NaN);
    expect(store.chatPanelMaxLines).toBe(22);
    // A no-op value (already current) skips the IPC round-trip entirely.
    apiMock.setOverlayConfig.mockClear();
    await store.setChatPanelMaxLines(22);
    expect(apiMock.setOverlayConfig).not.toHaveBeenCalled();
  });

  it("lands missing or junk chat-panel replies on the off/8 defaults", async () => {
    // An older shell without the fields (or a corrupted file) must not turn
    // the opt-in card on — the tolerant parse mirrors the Rust heal.
    apiMock.getOverlayConfig.mockResolvedValueOnce({ table: "detect", roster: "plugin", aimCard: true, aimCardHangPx: 60 });
    const store = useOverlayConfigStore();
    await store.load();
    expect(store.chatPanel).toBe(false);
    expect(store.chatPanelMaxLines).toBe(8);
    apiMock.getOverlayConfig.mockResolvedValueOnce({
      table: "detect",
      roster: "plugin",
      aimCard: true,
      aimCardHangPx: 60,
      chatPanel: "yes",
      chatPanelMaxLines: "many",
    });
    await store.load();
    expect(store.chatPanel).toBe(false);
    expect(store.chatPanelMaxLines).toBe(8);
  });
});
