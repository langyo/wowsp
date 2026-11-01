/** Tests for the division lettering pass (utils/divisions.ts): per-side
 *  letters over the caller's display order, solo rows never lettered, and
 *  the 52-letter paranoia cap that keeps a corrupt division id from
 *  growing the tag faces unbounded. */
import { describe, expect, it } from "vitest";

import { divisionLetters, type DivisionEntry } from "@/utils/divisions";

const rows = (pairs: [string, number | null | undefined][]): DivisionEntry[] =>
  pairs.map(([name, div]) => ({ name, div }));

describe("divisionLetters", () => {
  it("letters a division's members with the shared letter", () => {
    const out = divisionLetters(rows([["alice", 7], ["bob", 7], ["carol", null]]));
    expect(out.get("alice")).toBe("A");
    expect(out.get("bob")).toBe("A");
    expect(out.size).toBe(2);
  });

  it("letters distinct divisions A, B, C… in first-appearance order", () => {
    const out = divisionLetters(
      rows([["dave", 3], ["erin", 9], ["frank", 3], ["grace", 9], ["heidi", 1]]),
    );
    expect(out.get("dave")).toBe("A"); // div 3 seen first
    expect(out.get("frank")).toBe("A");
    expect(out.get("erin")).toBe("B"); // div 9 second
    expect(out.get("grace")).toBe("B");
    // Input order wins, not id order — the tags read top-down like the
    // rows the caller displays.
    expect(out.get("heidi")).toBe("C");
  });

  it("excludes every solo spelling: 0, null and absent", () => {
    const out = divisionLetters(
      rows([["soloZero", 0], ["soloNull", null], ["soloAbsent", undefined], ["inDivision", 5]]),
    );
    expect([...out.keys()]).toEqual(["inDivision"]);
  });

  it("is independent per call — the same ids letter fresh in each input's order", () => {
    const first = divisionLetters(rows([["a", 1], ["b", 2]]));
    const second = divisionLetters(rows([["b", 1], ["a", 2]]));
    expect(first.get("a")).toBe("A");
    expect(first.get("b")).toBe("B");
    // Reversed input order → reversed letters; neither call saw the other.
    expect(second.get("b")).toBe("A");
    expect(second.get("a")).toBe("B");
  });

  it("letters an empty roster to an empty map", () => {
    expect(divisionLetters([]).size).toBe(0);
  });

  it("walks the spreadsheet sequence past Z: …Z, AA, AB…", () => {
    const out = divisionLetters(
      rows(Array.from({ length: 28 }, (_, i) => [`p${i}`, i + 1] as [string, number])),
    );
    expect(out.get("p25")).toBe("Z");
    expect(out.get("p26")).toBe("AA");
    expect(out.get("p27")).toBe("AB");
  });

  it("caps at 52 letters — surplus divisions stay unlettered", () => {
    const entries: DivisionEntry[] = [];
    for (let i = 0; i < 53; i++) {
      entries.push({ name: `a${i}`, div: i + 1 }, { name: `b${i}`, div: i + 1 });
    }
    const out = divisionLetters(entries);
    // 52 lettered divisions × 2 members; the 53rd division is past the
    // cap and nobody in it renders a tag.
    expect(out.size).toBe(104);
    expect(out.get("a0")).toBe("A");
    expect(out.get("a51")).toBe("AZ");
    expect(out.has("a52")).toBe(false);
    expect(out.has("b52")).toBe(false);
  });
});
