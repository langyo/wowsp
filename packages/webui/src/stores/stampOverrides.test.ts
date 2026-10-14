/** Stamp overrides: the stamps-changed broadcast contract. The Tab overlay
 *  cannot see this module's reactive map, so every LANDED folder write must
 *  announce itself — see the overlay's wowsp://stamps-changed listener.
 *  Imports arrive as crop-dialog bytes (ImageSquareCropModal →
 *  stampImportBytes raw IPC), so a failed write is the only silent path. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  importStampImage,
  refreshStampOverrides,
  resetStampImage,
  stampOverrideUrl,
} from "./stampOverrides";

const { apiMock } = vi.hoisted(() => ({
  apiMock: { stampList: vi.fn(), stampImportBytes: vi.fn(), stampReset: vi.fn() },
}));
vi.mock("@/api", () => ({ api: apiMock }));

const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: emitMock }));
// refreshStampOverrides resolves the asset URLs through this import.
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  apiMock.stampList.mockReset().mockResolvedValue([]);
  apiMock.stampImportBytes.mockReset();
  apiMock.stampReset.mockReset();
  emitMock.mockClear();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("stamp refresh ownership", () => {
  it("does not restore a reset stamp from an older listing", async () => {
    const old = deferred<Array<{ kind: string; path: string }>>();
    apiMock.stampList.mockReturnValueOnce(old.promise);
    const pending = refreshStampOverrides();
    apiMock.stampReset.mockResolvedValue(undefined);
    await resetStampImage("rat");
    expect(stampOverrideUrl("rat")).toBeNull();
    old.resolve([{ kind: "rat", path: "old.png" }]);
    await pending;
    expect(stampOverrideUrl("rat")).toBeNull();
  });

  it("does not replace a newly imported stamp with an older listing", async () => {
    const old = deferred<Array<{ kind: string; path: string }>>();
    apiMock.stampList.mockReturnValueOnce(old.promise);
    const pending = refreshStampOverrides();
    apiMock.stampImportBytes.mockResolvedValue({ kind: "rat", path: "new.png" });
    apiMock.stampList.mockResolvedValue([{ kind: "rat", path: "new.png" }]);
    await importStampImage("rat", new Uint8Array([1, 2, 3]), "png");
    old.resolve([{ kind: "rat", path: "old.png" }]);
    await pending;
    expect(stampOverrideUrl("rat")).toBe("new.png");
  });

  it("keeps the last known image if the latest refresh fails", async () => {
    apiMock.stampList.mockResolvedValueOnce([{ kind: "rat", path: "known.png" }]);
    await refreshStampOverrides();
    const old = deferred<Array<{ kind: string; path: string }>>();
    apiMock.stampList.mockReturnValueOnce(old.promise);
    const pending = refreshStampOverrides();
    apiMock.stampList.mockRejectedValueOnce(new Error("read failed"));
    await refreshStampOverrides();
    old.resolve([{ kind: "rat", path: "obsolete.png" }]);
    await pending;
    expect(stampOverrideUrl("rat")).toBe("known.png");
    apiMock.stampList.mockResolvedValueOnce([]);
    await refreshStampOverrides();
    expect(stampOverrideUrl("rat")).toBeNull();
  });
});

describe("stamp override broadcasts", () => {
  it("forwards the crop bytes verbatim and broadcasts after a landed import", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    apiMock.stampImportBytes.mockResolvedValue({ kind: "rat", path: "C:\\s\\rat.png" });
    await importStampImage("rat", bytes, "png");
    expect(apiMock.stampImportBytes).toHaveBeenCalledWith("rat", "png", bytes);
    await settle();
    expect(emitMock).toHaveBeenCalledWith("wowsp://stamps-changed");
  });

  it("does not broadcast when the import write fails", async () => {
    apiMock.stampImportBytes.mockRejectedValue(new Error("write failed"));
    await expect(importStampImage("rat", new Uint8Array([1]), "png")).rejects.toThrow(
      "write failed",
    );
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
