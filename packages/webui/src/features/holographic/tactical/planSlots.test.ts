import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SLOT_ID,
  deleteSlotDoc,
  duplicateSlotDoc,
  loadSlots,
  nextSlotId,
  saveSlots,
  slotDocPath,
} from "./planSlots";
import { docStorageKey } from "./model";

describe("planSlots", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("a space with no inventory falls back to the single legacy slot", () => {
    expect(loadSlots("spaces/00_CO")).toEqual([{ id: DEFAULT_SLOT_ID, name: "" }]);
  });

  it("slot 0 keeps the legacy unsuffixed document key (old boards upgrade in place)", () => {
    expect(slotDocPath("spaces/00_CO", "0")).toBe("tactics:spaces/00_CO");
    expect(slotDocPath("spaces/00_CO", "2")).toBe("tactics:spaces/00_CO#2");
  });

  it("corrupt inventory JSON degrades to the default slot", () => {
    window.localStorage.setItem(docStorageKey("tactics-slots:spaces/00_CO"), "{not json");
    expect(loadSlots("spaces/00_CO")).toEqual([{ id: DEFAULT_SLOT_ID, name: "" }]);
  });

  it("round-trips a saved inventory, filtering malformed entries", () => {
    saveSlots("s", [{ id: "0", name: "A 组" }, { id: "1", name: "" }]);
    expect(loadSlots("s")).toEqual([
      { id: "0", name: "A 组" },
      { id: "1", name: "" },
    ]);
    window.localStorage.setItem(
      docStorageKey("tactics-slots:s"),
      JSON.stringify([{ id: "0", name: "ok" }, { id: 7 }, { name: "no id" }, "junk"]),
    );
    expect(loadSlots("s")).toEqual([{ id: "0", name: "ok" }]);
  });

  it("an inventory with NO valid entries falls back to the default slot", () => {
    window.localStorage.setItem(
      docStorageKey("tactics-slots:s"),
      JSON.stringify([{ id: 7 }, { name: "no id" }, "junk"]),
    );
    expect(loadSlots("s")).toEqual([{ id: DEFAULT_SLOT_ID, name: "" }]);
  });

  it("nextSlotId skips ids already in use", () => {
    expect(nextSlotId([{ id: "0", name: "" }])).toBe("1");
    expect(nextSlotId([{ id: "0", name: "" }, { id: "1", name: "" }])).toBe("2");
    expect(nextSlotId([{ id: "0", name: "" }, { id: "2", name: "" }])).toBe("1");
  });

  it("duplicate copies the persisted document; delete removes only that slot's key", () => {
    window.localStorage.setItem(docStorageKey("tactics:s"), "DOC-0");
    duplicateSlotDoc("s", "0", "3");
    expect(window.localStorage.getItem(docStorageKey("tactics:s#3"))).toBe("DOC-0");
    deleteSlotDoc("s", "3");
    expect(window.localStorage.getItem(docStorageKey("tactics:s#3"))).toBeNull();
    expect(window.localStorage.getItem(docStorageKey("tactics:s"))).toBe("DOC-0");
  });
});
