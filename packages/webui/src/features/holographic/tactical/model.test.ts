/** Document-model unit tests: time gating, draw-on progress, hit tests,
 *  edits and persistence helpers (pure, no DOM). */
import { describe, expect, it } from "vitest";
import type { TacticalDoc, TacticalElement } from "./types";
import {
  commitFreehand,
  commitShape,
  commitStep,
  commitText,
  docStorageKey,
  elementProgress,
  hitTestElement,
  moveElement,
  parseDoc,
  presentParkTarget,
  serializeDoc,
  visibleAt,
} from "./model";

const p = (x: number, z: number) => ({ x, z });
const look = { color: "#ff0000", width: 4, dash: "solid" as const };

describe("visibleAt / elementProgress", () => {
  const arrow = commitShape("arrow", p(0, 0), p(100, 100), look, 10);
  it("hides elements before their anchor time", () => {
    expect(visibleAt(arrow, 9.9)).toBe(false);
    expect(visibleAt(arrow, 10)).toBe(true);
  });

  it("progresses draw-on over drawIn seconds then clamps at 1", () => {
    expect(elementProgress(arrow, 10)).toBeCloseTo(0);
    expect(elementProgress(arrow, 10 + arrow.drawIn / 2)).toBeCloseTo(0.5);
    expect(elementProgress(arrow, 10 + arrow.drawIn + 5)).toBe(1);
  });

  it("text fades in over a fixed short window", () => {
    const note = commitText(p(5, 5), "push B", "#fff", 20);
    expect(elementProgress(note, 20)).toBeCloseTo(0);
    expect(elementProgress(note, 20.175)).toBeCloseTo(0.5);
    expect(elementProgress(note, 21)).toBe(1);
  });
});

describe("commitFreehand", () => {
  it("simplifies raw pointer samples", () => {
    const raw = Array.from({ length: 20 }, (_, i) => p(i, 0));
    const el = commitFreehand(raw, look, 0, 0.5);
    expect(el.kind).toBe("freehand");
    expect(el.points.length).toBeLessThan(raw.length);
    expect(el.t0).toBe(0);
    expect(el.id).toBeTruthy();
  });

  it("degenerates to raw points when simplification eats the stroke", () => {
    const raw = [p(0, 0), p(0.1, 0)];
    const el = commitFreehand(raw, look, 0, 5);
    expect(el.points).toHaveLength(2);
  });
});

describe("hitTestElement", () => {
  it("hits near a line and misses far away", () => {
    const line = commitShape("line", p(0, 0), p(0, 100), look, 0);
    expect(hitTestElement(line, p(6, 50), 10, 999)).toBe(true);
    expect(hitTestElement(line, p(40, 50), 10, 999)).toBe(false);
  });

  it("never hits before the element appears", () => {
    const line = commitShape("line", p(0, 0), p(0, 100), look, 50);
    expect(hitTestElement(line, p(0, 50), 10, 10)).toBe(false);
    expect(hitTestElement(line, p(0, 50), 10, 60)).toBe(true);
  });

  it("replayPath is not selectable", () => {
    const path: TacticalElement = {
      id: "x",
      kind: "replayPath",
      t0: 0,
      entityId: 1,
      upTo: "full",
      ...look,
    };
    expect(hitTestElement(path, p(0, 0), 100, 100)).toBe(false);
  });
});

describe("moveElement", () => {
  it("translates shapes and anchored elements", () => {
    const arrow = commitShape("arrow", p(0, 0), p(10, 0), look, 0);
    const moved = moveElement(arrow, 5, -2);
    expect(moved.points).toEqual([p(5, -2), p(15, -2)]);
    const note = moveElement(commitText(p(1, 1), "a", "#fff", 0), 5, -2);
    expect(note.at).toEqual(p(6, -1));
  });
});

describe("presentParkTarget", () => {
  const steps = [{ t: 10 }, { t: 20 }, { t: 30 }];
  it("parks on the upcoming step once within one frame of it", () => {
    expect(presentParkTarget(steps, 9.9)?.t).toBeUndefined();
    expect(presentParkTarget(steps, 9.98)?.t).toBe(10);
    expect(presentParkTarget(steps, 19.97)?.t).toBe(20);
  });
  it("never parks between steps, on the current step, or past the last", () => {
    expect(presentParkTarget(steps, 15)).toBeNull();
    expect(presentParkTarget(steps, 10)).toBeNull();
    expect(presentParkTarget(steps, 20.5)).toBeNull();
    expect(presentParkTarget(steps, 35)).toBeNull();
  });
  it("handles an empty timeline", () => {
    expect(presentParkTarget([], 5)).toBeNull();
  });
  it("parks through a 10x playback overshoot (step smaller than 50 ms slack)", () => {
    // playTick at 10x advances ~0.16 s per RAF tick — an overshoot lands
    // past the step, but the step is no longer strictly ahead, so it must
    // NOT park (the next frame parks on the following step instead).
    expect(presentParkTarget(steps, 10.16)).toBeNull();
    expect(presentParkTarget(steps, 29.96)?.t).toBe(30);
  });
});

describe("persistence helpers", () => {
  it("round-trips a document", () => {
    const doc: TacticalDoc = {
      version: 1,
      elements: [commitText(p(1, 2), "hi", "#fff", 0)],
      steps: [commitStep(42, "opening")],
    };
    expect(parseDoc(serializeDoc(doc))).toEqual(doc);
  });

  it("rejects malformed or wrong-version payloads", () => {
    expect(parseDoc("{nope")).toBeNull();
    expect(parseDoc('{"version":99,"elements":[]}')).toBeNull();
  });

  it("sanitizes corrupted elements instead of bricking the board", () => {
    const doc = parseDoc(
      JSON.stringify({
        version: 1,
        elements: [
          // Good arrow.
          commitShape("arrow", p(0, 0), p(10, 0), look, 5),
          // Freehand with a NaN point → point dropped, element kept.
          {
            id: "a",
            kind: "freehand",
            t0: 0,
            points: [p(0, 0), { x: Number.NaN, z: 1 }, p(9, 9)],
            ...look,
            drawIn: 1,
          },
          // Marker missing size/label → defaults backfilled.
          { id: "b", kind: "marker", t0: 3, at: p(1, 1), heading: 0, variant: "plane", color: "#fff" },
          // Text with NaN t0 → t0 defaults to always-visible.
          { id: "c", kind: "text", at: p(2, 2), text: "hi", color: "#fff", t0: Number.NaN, size: 18 },
          // Unknown kind → dropped.
          { id: "d", kind: "teleport", t0: 0 },
          // replayPath with a bogus dash → normalized to solid.
          { id: "e", kind: "replayPath", t0: 0, entityId: 7, upTo: "now", color: "#4ade80", width: 3, dash: "zigzag" },
        ],
      }),
    );
    expect(doc).not.toBeNull();
    const els = doc!.elements;
    expect(els).toHaveLength(5);
    const freehand = els.find((el) => el.id === "a")!;
    expect(freehand.kind === "freehand" && freehand.points).toHaveLength(2);
    const marker = els.find((el) => el.id === "b")!;
    expect(marker.kind === "marker" && marker.size).toBe(40);
    expect(marker.kind === "marker" && marker.label).toBe("");
    const text = els.find((el) => el.id === "c")!;
    expect(text.t0).toBe(0);
    expect(els.some((el) => el.id === "d")).toBe(false);
    const path = els.find((el) => el.id === "e")!;
    expect(path.kind === "replayPath" && path.dash).toBe("solid");
  });

  it("keys are stable and CJK-path-safe", () => {
    const a = docStorageKey("D:\\replays\\源代码.wowsreplay");
    expect(a).toBe(docStorageKey("D:\\replays\\源代码.wowsreplay"));
    expect(a).not.toBe(docStorageKey("D:\\replays\\other.wowsreplay"));
    expect(a).toMatch(/^wowsp:tactical:v1:[0-9a-z]+$/);
  });
});
