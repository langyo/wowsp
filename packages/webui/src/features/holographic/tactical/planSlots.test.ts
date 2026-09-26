import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SLOT_ID,
  deleteSlotDoc,
  duplicateSlotDoc,
  exportBundle,
  importBundle,
  loadSlots,
  nextSlotId,
  parseBundle,
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

describe("plan bundles", () => {
  const doc = (tag: string) => ({ version: 1, elements: [{ id: tag }], steps: [] });

  function seed(): void {
    saveSlots("s", [
      { id: DEFAULT_SLOT_ID, name: "A" },
      { id: "1", name: "" },
      { id: "2", name: "C" },
    ]);
    window.localStorage.setItem(docStorageKey("tactics:s"), JSON.stringify(doc("d0")));
    window.localStorage.setItem(docStorageKey("tactics:s#1"), JSON.stringify(doc("d1")));
    window.localStorage.setItem(docStorageKey("tactics:s#2"), JSON.stringify(doc("d2")));
  }

  it("export assembles every slot's document under its inventory name", () => {
    seed();
    const bundle = exportBundle("s");
    expect(bundle.kind).toBe("wowsp-tactics-plans");
    expect(bundle.slots.map((e) => e.name)).toEqual(["A", "", "C"]);
    expect(bundle.slots[0].doc.elements).toEqual([{ id: "d0" }]);
    expect(bundle.slots[2].doc.elements).toEqual([{ id: "d2" }]);
  });

  it("an unreadable slot document exports as empty, not as a throw", () => {
    seed();
    window.localStorage.setItem(docStorageKey("tactics:s#1"), "{corrupt");
    expect(exportBundle("s").slots[1].doc.elements).toEqual([]);
  });

  it("parseBundle accepts the export output and rejects foreign files", () => {
    seed();
    const ok = parseBundle(JSON.stringify(exportBundle("s")));
    expect(ok).not.toBeNull();
    expect(ok!.slots).toHaveLength(3);
    expect(parseBundle(JSON.stringify({ hello: 1 }))).toBeNull();
    expect(parseBundle(JSON.stringify({ kind: "wowsp-tactics-plans", slots: [] }))).toBeNull();
    expect(parseBundle("not json")).toBeNull();
    expect(
      parseBundle(JSON.stringify({ kind: "wowsp-tactics-plans", slots: [{ name: 7, doc: {} }] })),
    ).toBeNull();
  });

  it("import renumbers slots from 0, rewrites documents and drops stale keys", () => {
    seed();
    const bundle = parseBundle(
      JSON.stringify({
        version: 1,
        kind: "wowsp-tactics-plans",
        spaceId: "other",
        exportedAt: "",
        slots: [
          { name: "X", doc: doc("x") },
          { name: "Y", doc: doc("y") },
        ],
      }),
    )!;
    importBundle("s", bundle);
    expect(loadSlots("s")).toEqual([
      { id: "0", name: "X" },
      { id: "1", name: "Y" },
    ]);
    expect(window.localStorage.getItem(docStorageKey("tactics:s"))).toBe(
      JSON.stringify(doc("x")),
    );
    expect(window.localStorage.getItem(docStorageKey("tactics:s#1"))).toBe(
      JSON.stringify(doc("y")),
    );
    // the old third slot's key is gone — no orphaned plan resurrects later
    expect(window.localStorage.getItem(docStorageKey("tactics:s#2"))).toBeNull();
  });
});
