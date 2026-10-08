/** Stamp overrides: the stamps-changed broadcast contract. The Tab overlay
 *  cannot see this module's reactive map, so every LANDED folder write
 *  (a cancelled import dialog is not one) must announce itself — see the
 *  overlay's wowsp://stamps-changed listener. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  importStampImage,
  refreshStampOverrides,
  resetStampImage,
  stampOverrideUrl,
} from "./stampOverrides";

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
  apiMock.stampList.mockReset().mockResolvedValue([]);
  apiMock.stampImport.mockReset();
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
    apiMock.stampImport.mockResolvedValue({ kind: "rat", path: "new.jpg" });
    apiMock.stampList.mockResolvedValue([{ kind: "rat", path: "new.jpg" }]);
    await importStampImage("rat");
    old.resolve([{ kind: "rat", path: "old.png" }]);
    await pending;
    expect(stampOverrideUrl("rat")).toBe("new.jpg");
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
