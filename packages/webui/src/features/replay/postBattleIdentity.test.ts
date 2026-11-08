/**
 * Unit tests for the post-battle identity-line seal split: which wordings
 * stay on the row (single characters, 猴 / 蛆) and which collapse behind the
 * "!" badge (every longer wording, the four-character composition tags
 * included), plus the effective-wording rule (a user sealLabels override
 * drives the split, not the default STAMP_WORDING).
 */
import { describe, expect, it } from "vitest";

import { sealBadgeWording, splitIdentitySeals } from "./postBattleIdentity";

describe("splitIdentitySeals", () => {
  it("keeps only the single-character verdicts inline", () => {
    const { inline, collapsed } = splitIdentitySeals(["ape", "maggot"]);
    expect(inline).toEqual(["ape", "maggot"]);
    expect(collapsed).toEqual([]);
  });

  it("collapses every four-character composition / merged wording and the wide verdicts", () => {
    const wide = [
      "miracle",
      "rat",
      "air",
      "sub",
      "airVeteran",
      "subVeteran",
      "airMiracle",
      "subMiracle",
      "airApe",
      "subApe",
    ] as const;
    const { inline, collapsed } = splitIdentitySeals(wide);
    expect(inline).toEqual([]);
    expect(collapsed).toEqual([...wide]);
  });

  it("keeps the incoming display order inside both buckets", () => {
    // Career verdict first, air before sub (the row's own order): the split
    // never reorders either list.
    const { inline, collapsed } = splitIdentitySeals([
      "ape",
      "air",
      "maggot",
      "sub",
    ]);
    expect(inline).toEqual(["ape", "maggot"]);
    expect(collapsed).toEqual(["air", "sub"]);
  });

  it("splits on the EFFECTIVE wording — a custom single-character label stays inline", () => {
    // The seal customizer replaces the wording: a shortened composition tag
    // is one character now and keeps its old inline seat.
    const { inline, collapsed } = splitIdentitySeals(["air", "sub"], {
      air: "空",
      sub: "水",
    });
    expect(inline).toEqual(["air", "sub"]);
    expect(collapsed).toEqual([]);
  });

  it("collapses a custom label that grew past one character", () => {
    const { inline, collapsed } = splitIdentitySeals(["ape", "maggot"], {
      ape: "猴王",
    });
    expect(inline).toEqual(["maggot"]);
    expect(collapsed).toEqual(["ape"]);
  });

  it("counts code points, so a one-emoji label is still one character", () => {
    // The emoji is two UTF-16 units but one visible character — the split
    // must run on code points or it would collapse a single-glyph label.
    const { inline, collapsed } = splitIdentitySeals(["air"], { air: "🐒" });
    expect(inline).toEqual(["air"]);
    expect(collapsed).toEqual([]);
  });

  it("ignores surrounding whitespace when measuring a label", () => {
    const { inline } = splitIdentitySeals(["ape"], { ape: " 猴 " });
    expect(inline).toEqual(["ape"]);
  });

  it("degrades empty input to two empty buckets", () => {
    expect(splitIdentitySeals([])).toEqual({ inline: [], collapsed: [] });
  });
});

describe("sealBadgeWording", () => {
  it("joins the collapsed wordings in display order", () => {
    expect(sealBadgeWording(["air", "sub"])).toBe("空中小人 · 水下小人");
  });

  it("reads the effective (custom) wording", () => {
    expect(sealBadgeWording(["air", "miracle"], { air: "空中小人改" })).toBe(
      "空中小人改 · 神了",
    );
  });

  it("renders an empty label for an empty list", () => {
    expect(sealBadgeWording([])).toBe("");
  });
});
