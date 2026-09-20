/** useTactical store tests: steps, naming, undo/redo across elements AND
 * steps, and persistence round-trip via the storage key (localStorage is
 * stubbed — the composable falls back to in-memory when unavailable). */
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { useTactical } from "./useTactical";
import { commitShape, commitStep, parseDoc, serializeDoc } from "./model";

const look = { color: "#ff0000", width: 4, dash: "solid" as const };
const p = (x: number, z: number) => ({ x, z });

function makeStore(path = "D:\\replays\\a.wowsreplay") {
  return useTactical(ref(path));
}

describe("useTactical steps", () => {
  it("adds steps, sorts them, and names them by order", () => {
    const s = makeStore();
    s.addStep(120);
    s.addStep(30);
    expect(s.stepsSorted.value.map((x) => x.t)).toEqual([30, 120]);
    expect(s.stepsSorted.value[0].name).toBe("#1");
    expect(s.stepsSorted.value[1].name).toBe("#2");
  });

  it("collapses near-duplicate steps (merge window)", () => {
    const s = makeStore();
    expect(s.addStep(10)).toBe(true);
    expect(s.addStep(10.2)).toBe(false);
    expect(s.steps.value).toHaveLength(1);
    expect(s.addStep(11)).toBe(true);
    expect(s.steps.value).toHaveLength(2);
  });

  it("removes steps", () => {
    const s = makeStore();
    s.addStep(10);
    const id = s.steps.value[0].id;
    s.removeStep(id);
    expect(s.steps.value).toHaveLength(0);
    s.removeStep(id); // idempotent
  });
});

describe("useTactical history spans elements and steps", () => {
  it("undo restores a removed step", () => {
    const s = makeStore();
    s.addStep(10);
    s.commit(commitShape("arrow", p(0, 0), p(1, 1), look, 0));
    s.addStep(20);
    expect(s.steps.value).toHaveLength(2);
    s.removeStep(s.steps.value[1].id);
    expect(s.steps.value).toHaveLength(1);
    s.undo();
    expect(s.steps.value).toHaveLength(2);
  });

  it("clearAll wipes both lists and undo restores both", () => {
    const s = makeStore();
    s.commit(commitShape("arrow", p(0, 0), p(1, 1), look, 0));
    s.addStep(5);
    s.clearAll();
    expect(s.elements.value).toHaveLength(0);
    expect(s.steps.value).toHaveLength(0);
    s.undo();
    expect(s.elements.value).toHaveLength(1);
    expect(s.steps.value).toHaveLength(1);
  });

  it("redo replays a cleared step list", () => {
    const s = makeStore();
    s.addStep(5);
    s.undo();
    expect(s.steps.value).toHaveLength(0);
    s.redo();
    expect(s.steps.value).toHaveLength(1);
  });
});

describe("doc round-trip with steps", () => {
  it("serializes and parses steps alongside elements", () => {
    const s = makeStore();
    s.commit(commitShape("arrow", p(0, 0), p(1, 1), look, 0));
    s.addStep(33);
    const json = serializeDoc({
      version: 1,
      elements: s.elements.value,
      steps: s.steps.value,
    });
    const doc = parseDoc(json)!;
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0].t).toBe(33);
  });

  it("wave-1 docs without steps backfill an empty list and drop junk steps", () => {
    const doc = parseDoc(
      JSON.stringify({
        version: 1,
        elements: [commitShape("arrow", p(0, 0), p(1, 1), look, 0)],
      }),
    )!;
    expect(doc.steps).toEqual([]);
    const doc2 = parseDoc(
      JSON.stringify({
        version: 1,
        elements: [],
        steps: [commitStep(5), { id: "x", t: "soon" }, { id: "y", t: 9, name: 7 }],
      }),
    )!;
    expect(doc2.steps).toHaveLength(2);
    expect(doc2.steps.map((s) => s.t)).toEqual([5, 9]);
    expect(doc2.steps[1].name).toBe("");
  });
});

describe("persistence fallback", () => {
  it("works without localStorage (in-memory board, no throw)", () => {
    vi.stubGlobal("window", undefined);
    const s = useTactical(ref("D:\\replays\\no-storage.wowsreplay"));
    expect(() => {
      s.addStep(1);
      s.commit(commitShape("line", p(0, 0), p(5, 0), look, 0));
    }).not.toThrow();
    expect(s.steps.value).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
