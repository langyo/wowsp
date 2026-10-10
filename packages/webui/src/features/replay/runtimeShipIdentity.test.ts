/** Tests for the runtime ship-identity resolver: the derivation rules off a
 *  raw GameParams subtree (shortName → prettified entity name → raw index,
 *  level/typeinfo → tier/species/nation), the once-per-(root, shipId)
 *  attempt ledger, and the epoch bump that re-renders the roster. The api
 *  transport is mocked — the resolver must never touch real Tauri IPC. */
import { flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetRuntimeShipEntries,
  runtimeShipEntry,
} from "@/utils/runtimeShipDb";
import {
  resolveRuntimeShips,
  resetRuntimeShipIdentityForTests,
  runtimeShipEpoch,
} from "./runtimeShipIdentity";

const mocks = vi.hoisted(() => ({ getShipGameparams: vi.fn() }));
vi.mock("@/api", () => ({ api: { getShipGameparams: mocks.getShipGameparams } }));

// A shipId absent from the baked DB (the post-bake collaboration clone the
// module exists for) and a real baked id (Yamato) that must never probe.
const UNKNOWN_ID = 987654321;
const BAKED_ID = 4276041424;

const RAW_FULL = {
  level: 9,
  index: "PJSB719",
  shortName: "Hotaka",
  name: "PJSB719_Hotaka_1944",
  typeinfo: { species: "Battleship", nation: "JAPAN" },
};

beforeEach(() => {
  mocks.getShipGameparams.mockReset();
  resetRuntimeShipEntries();
  resetRuntimeShipIdentityForTests();
});

describe("resolveRuntimeShips", () => {
  it("derives tier/type/nation and prefers shortName", async () => {
    mocks.getShipGameparams.mockResolvedValue(RAW_FULL);
    resolveRuntimeShips([UNKNOWN_ID], "C:/Game");
    await flushPromises();
    expect(mocks.getShipGameparams).toHaveBeenCalledWith(UNKNOWN_ID, "C:/Game");
    expect(runtimeShipEntry(UNKNOWN_ID)).toEqual({
      index: "PJSB719",
      tier: 9,
      type: "Battleship",
      nation: "japan",
      names: { en: "Hotaka" },
    });
  });

  it("prettifies the entity name when shortName is absent", async () => {
    // The bake script's prettify_entity_name: tail after the FIRST
    // underscore, remaining underscores spaced.
    mocks.getShipGameparams.mockResolvedValue({
      level: 9,
      index: "PJSB719",
      name: "PJSB719_Hotaka_1944",
      typeinfo: { species: "Battleship", nation: "japan" },
    });
    resolveRuntimeShips([UNKNOWN_ID], "");
    await flushPromises();
    expect(runtimeShipEntry(UNKNOWN_ID)?.names).toEqual({ en: "Hotaka 1944" });
  });

  it("passes an underscore-free entity name through unchanged", async () => {
    mocks.getShipGameparams.mockResolvedValue({
      level: 9,
      name: "Hotaka",
      typeinfo: { species: "Battleship", nation: "japan" },
    });
    resolveRuntimeShips([UNKNOWN_ID], "");
    await flushPromises();
    expect(runtimeShipEntry(UNKNOWN_ID)?.names).toEqual({ en: "Hotaka" });
  });

  it("falls back to the raw index as the name", async () => {
    mocks.getShipGameparams.mockResolvedValue({
      level: 9,
      index: "PJSB719",
      typeinfo: { species: "Battleship", nation: "japan" },
    });
    resolveRuntimeShips([UNKNOWN_ID], "");
    await flushPromises();
    expect(runtimeShipEntry(UNKNOWN_ID)?.names).toEqual({ en: "PJSB719" });
  });

  it("registers a partial identity when only one field resolves", async () => {
    mocks.getShipGameparams.mockResolvedValue({
      typeinfo: { species: "Cruiser" },
    });
    resolveRuntimeShips([UNKNOWN_ID], "");
    await flushPromises();
    expect(runtimeShipEntry(UNKNOWN_ID)).toEqual({
      index: null,
      tier: null,
      type: "Cruiser",
      nation: null,
      names: null,
    });
  });

  it("registers nothing when the subtree answers nothing usable", async () => {
    mocks.getShipGameparams.mockResolvedValue({ typeinfo: {} });
    resolveRuntimeShips([UNKNOWN_ID], "");
    await flushPromises();
    expect(runtimeShipEntry(UNKNOWN_ID)).toBeNull();
    expect(runtimeShipEpoch.value).toBe(0);
  });

  it("bumps the epoch once per registration", async () => {
    mocks.getShipGameparams.mockResolvedValue(RAW_FULL);
    const before = runtimeShipEpoch.value;
    resolveRuntimeShips([UNKNOWN_ID], "C:/Game");
    await flushPromises();
    expect(runtimeShipEpoch.value).toBe(before + 1);
  });

  it("marks a failed probe attempted and never retries it", async () => {
    mocks.getShipGameparams.mockRejectedValue(new Error("unpack failed"));
    resolveRuntimeShips([UNKNOWN_ID], "C:/Game");
    await flushPromises();
    resolveRuntimeShips([UNKNOWN_ID], "C:/Game");
    await flushPromises();
    expect(mocks.getShipGameparams).toHaveBeenCalledTimes(1);
    expect(runtimeShipEntry(UNKNOWN_ID)).toBeNull();
  });

  it("retries under a different game root (a new install is a new key)", async () => {
    mocks.getShipGameparams.mockRejectedValueOnce(new Error("root gone"));
    resolveRuntimeShips([UNKNOWN_ID], "C:/GameA");
    await flushPromises();
    mocks.getShipGameparams.mockResolvedValue(RAW_FULL);
    resolveRuntimeShips([UNKNOWN_ID], "C:/GameB");
    await flushPromises();
    expect(mocks.getShipGameparams).toHaveBeenCalledTimes(2);
    expect(mocks.getShipGameparams).toHaveBeenLastCalledWith(UNKNOWN_ID, "C:/GameB");
    expect(runtimeShipEntry(UNKNOWN_ID)?.tier).toBe(9);
  });

  it("dedupes repeated and concurrent calls for the same roster", async () => {
    mocks.getShipGameparams.mockResolvedValue(RAW_FULL);
    resolveRuntimeShips([UNKNOWN_ID, UNKNOWN_ID], "C:/Game");
    resolveRuntimeShips([UNKNOWN_ID], "C:/Game");
    await flushPromises();
    expect(mocks.getShipGameparams).toHaveBeenCalledTimes(1);
  });

  it("skips ships the baked DB already knows", async () => {
    // Yamato IS in the baked DB — the probe never fires for it (the bake is
    // the authoritative source; a registration could not improve on it).
    resolveRuntimeShips([BAKED_ID], "C:/Game");
    await flushPromises();
    expect(mocks.getShipGameparams).not.toHaveBeenCalled();
  });

  it("ignores the roster's placeholder shipIds", async () => {
    resolveRuntimeShips([null, undefined, 0, ""], "C:/Game");
    await flushPromises();
    expect(mocks.getShipGameparams).not.toHaveBeenCalled();
  });
});
