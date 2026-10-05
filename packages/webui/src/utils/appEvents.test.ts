/** The app-event broadcast helper: the one fire-and-forget channel to the
 *  shell's auxiliary windows (the Tab overlay). Pins the Tauri gate — a
 *  plain browser tab must stay a silent no-op, the same contract the
 *  stores' broadcasts are tested through. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { emitTauriEvent } from "./appEvents";

const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: emitMock }));

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  emitMock.mockClear();
});

describe("emitTauriEvent", () => {
  it("broadcasts the event inside the Tauri shell", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    emitTauriEvent("wowsp://stamps-changed");
    // The bus rides a dynamic import — let that microtask land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitMock).toHaveBeenCalledWith("wowsp://stamps-changed");
  });

  it("is a silent no-op outside the Tauri shell", async () => {
    emitTauriEvent("wowsp://stamps-changed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitMock).not.toHaveBeenCalled();
  });
});
