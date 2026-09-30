import { describe, expect, it } from "vitest";

import {
  ignoreAll,
  ignoreFile,
  keptPending,
  masterChecked,
  restoreAll,
  restoreFile,
  selectAll,
  type DecideSelection,
} from "./migrationDecide";

const PATHS = ["a.py", "b.xml", "c.png", "d.dll"] as const;

const sel = (keep: string[], ignore: string[]): DecideSelection => ({
  keep: new Set(keep),
  ignore: new Set(ignore),
});

describe("masterChecked", () => {
  it("is true only when every pending file is kept", () => {
    expect(masterChecked(PATHS, sel([...PATHS], []).keep, new Set())).toBe(true);
    expect(masterChecked(PATHS, sel(["a.py", "b.xml", "c.png"], []).keep, new Set())).toBeNull();
    expect(masterChecked(PATHS, sel([], []).keep, new Set())).toBe(false);
  });

  it("never counts ignored files", () => {
    // b is ignored, the rest kept → all *pending* kept → true, not null.
    expect(masterChecked(PATHS, sel(["a.py", "c.png", "d.dll"], ["b.xml"]).keep, new Set(["b.xml"]))).toBe(true);
    // Everything ignored → nothing is being decided → unchecked.
    expect(masterChecked(PATHS, sel([], [...PATHS]).keep, new Set([...PATHS]))).toBe(false);
  });
});

describe("keptPending", () => {
  it("reports kept against pending only", () => {
    const s = sel(["a.py", "b.xml"], ["c.png"]);
    expect(keptPending(PATHS, s.keep, s.ignore)).toEqual({ kept: 2, pending: 3 });
  });
});

describe("selectAll", () => {
  it("keeps every pending file and leaves ignored ones alone", () => {
    const s = sel(["a.py"], ["b.xml"]);
    const next = selectAll(s, PATHS, true);
    expect([...next.keep].sort()).toEqual(["a.py", "c.png", "d.dll"]);
    expect([...next.ignore]).toEqual(["b.xml"]);
  });

  it("clears pending keeps without un-ignoring anything", () => {
    const s = sel(["a.py", "c.png"], ["b.xml"]);
    const next = selectAll(s, PATHS, false);
    expect(next.keep.has("a.py")).toBe(false);
    expect(next.keep.has("c.png")).toBe(false);
    expect(next.ignore.has("b.xml")).toBe(true);
  });
});

describe("ignoreFile / restoreFile", () => {
  it("ignoring pulls the file out of keep (disjoint sets, ignore wins)", () => {
    const s = sel(["a.py", "b.xml"], []);
    const next = ignoreFile(s, "a.py");
    expect(next.keep.has("a.py")).toBe(false);
    expect(next.ignore.has("a.py")).toBe(true);
  });

  it("restoring returns the file to the default keep state", () => {
    const s = sel(["b.xml"], ["a.py"]);
    const next = restoreFile(s, "a.py");
    expect(next.ignore.has("a.py")).toBe(false);
    expect(next.keep.has("a.py")).toBe(true);
  });
});

describe("ignoreAll / restoreAll", () => {
  it("ignores the remaining pending files in one sweep", () => {
    const s = sel(["a.py"], ["b.xml"]);
    const next = ignoreAll(s, PATHS);
    expect([...next.ignore].sort()).toEqual(["a.py", "b.xml", "c.png", "d.dll"]);
    expect(next.keep.has("a.py")).toBe(false);
  });

  it("restoreAll sends every ignored file back to keep", () => {
    const s = sel(["b.xml"], ["a.py", "c.png"]);
    const next = restoreAll(s);
    expect(next.ignore.size).toBe(0);
    expect([...next.keep].sort()).toEqual(["a.py", "b.xml", "c.png"]);
  });
});
