/**
 * Item C: the floating card is THEMED BY THE WING'S OWNER ROLE.
 *
 * Report: "红色飞机却绿色血条+白色边框" — an ENEMY squadron's card painted the
 * recorder's own look. The card's role used to be hard-coded to "self" when
 * planeWarfare created it, so every aircraft card got the white border and the
 * green HP fill whatever side the wing flew for.
 *
 * The role now rides the carrier's role join (planeWarfare.resolvePlaneCarriers
 * + markerUpdate's per-tick refresh). This suite pins the RENDERING half in the
 * shared @wowsp/holo HoloLabel: the role drives the border ink class and the HP
 * fill colour, enemy = red ink + red-tinted fill, ally/self = the green/white
 * look.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import { HoloLabel, type HoloLabelData } from "@wowsp/holo";

const BASE: HoloLabelData = {
  key: 1,
  x: 0,
  y: 0,
  role: "ally",
  name: "",
  shipName: "Shokaku",
  hp: 6_000,
  maxHp: 10_000,
};

function card(role: HoloLabelData["role"]) {
  const w = mount(HoloLabel, { props: { label: { ...BASE, role } } });
  const fill = w.find(".holo-label__hp-fill");
  return { w, fill, style: (fill.element as HTMLElement).style };
}

/** HoloLabel.scss with comments stripped (the prose deliberately names the
 *  selectors it pins). */
const scss = readFileSync(
  join(process.cwd(), "..", "holo", "src", "HoloLabel.scss"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("HoloLabel role theme (enemy card is red)", () => {
  it("paints an ENEMY wing's HP fill red", () => {
    const { style } = card("enemy");
    expect(style.background).toBe("#cc3333");
  });

  it("keeps the green fills for ally and self", () => {
    expect(card("ally").style.background).toBe("#3cb478");
    expect(card("self").style.background).toBe("#4ade80");
  });

  it("carries the role class that owns the border ink", () => {
    expect(card("enemy").w.classes()).toContain("holo-label--enemy");
    expect(card("ally").w.classes()).toContain("holo-label--ally");
    expect(card("self").w.classes()).toContain("holo-label--self");
  });

  it("borders the enemy card in red ink and keeps white/green for friends", () => {
    expect(scss).toMatch(/&--enemy\s*\{\s*border-color:\s*#cc3333;\s*\}/s);
    expect(scss).toMatch(/&--self\s*\{\s*border-color:\s*#ffffff;\s*\}/s);
    expect(scss).toMatch(/&--ally\s*\{\s*border-color:\s*#3cb478;\s*\}/s);
  });
});
