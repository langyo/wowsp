/** Stamp overrides: the stamps-changed broadcast contract. The Tab overlay
 *  cannot see this module's reactive map, so every LANDED folder write
 *  (a cancelled import dialog is not one) must announce itself — see the
 *  overlay's wowsp://stamps-changed listener. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importStampImage, resetStampImage } from "./stampOverrides";

const { apiMock } = vi.hoisted(() => ({
  apiMock: { stampList: vi.fn(), stampImport: vi.fn(), stampReset: vi.fn() },
}));
vi.mock("@/api", () => ({ api: apiMock }));

const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: emitMock }));
// refreshStampOverrides resolves the asset URLs through this import.
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  apiMock.stampList.mockResolvedValue([]);
  apiMock.stampImport.mockReset();
  apiMock.stampReset.mockReset();
  emitMock.mockClear();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("stamp override broadcasts", () => {
  it("broadcasts stamps-changed after a landed import", async () => {
    apiMock.stampImport.mockResolvedValue({ kind: "rat", path: "C:\\s\\rat.png" });
    expect(await importStampImage("rat")).toBe(true);
    await settle();
    expect(emitMock).toHaveBeenCalledWith("wowsp://stamps-changed");
  });

  it("does not broadcast when the import dialog was cancelled", async () => {
    apiMock.stampImport.mockResolvedValue(null);
    expect(await importStampImage("rat")).toBe(false);
    await settle();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("broadcasts stamps-changed after a reset lands", async () => {
    apiMock.stampReset.mockResolvedValue(undefined);
    await resetStampImage("rat");
    await settle();
    expect(emitMock).toHaveBeenCalledWith("wowsp://stamps-changed");
  });
});
