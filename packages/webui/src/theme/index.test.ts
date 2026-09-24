/**
 * The theme-picker id list (themePresetIds) decides how many color-preset
 * cards the settings appearance row and the onboarding wizard's preset row
 * render. The regression pinned here is a SILENT one: the settings row
 * filtered a whitelist of the four stock ids against hikari's live preset
 * table and the wizard mapped that same whitelist, dropping ids whose tokens
 * no longer resolved — so hikari collapsing those four into a single
 * `default` emptied both rows (zero cards) with no error and nothing that
 * fails a build.
 *
 * Each case therefore drives the id sets hikari has actually shipped: the
 * pre-collapse four (0.55.60 and earlier) and the collapsed one (0.55.61,
 * the SAME 0.55.x minor, i.e. already inside this package's ^0.55.53 range).
 * The installed table is asserted live as well, which is what makes this
 * test bite on whichever side of the collapse the dependency is on.
 */
import { describe, expect, it } from "vitest";

import { themePresets } from "@celestia-island/hikari";

import { themePresetIds } from "./index";

/** hikari 0.55.60 and earlier: the four editor-derived stock presets, in table order. */
const PRE_COLLAPSE_IDS = ["synthwave84", "nord", "gruvbox", "tokyonight"];
/** hikari 0.55.61+: the collapse left one default scheme pair. */
const COLLAPSED_IDS = ["default"];
/** The order both pickers document (Nord first, Synthwave '84 last). */
const DISPLAY_ORDER = ["nord", "gruvbox", "tokyonight", "synthwave84"];

describe("themePresetIds", () => {
  it("keeps the documented display order for the pre-collapse table", () => {
    expect(themePresetIds(PRE_COLLAPSE_IDS)).toEqual(DISPLAY_ORDER);
  });

  it("renders the collapsed table instead of nothing", () => {
    expect(themePresetIds(COLLAPSED_IDS)).toEqual(["default"]);
  });

  it("appends a preset the table carries but the preferred order does not name", () => {
    expect(themePresetIds(["synthwave84", "brand", "nord"])).toEqual(["nord", "synthwave84", "brand"]);
  });

  it("never returns an empty list while the table carries presets", () => {
    for (const ids of [PRE_COLLAPSE_IDS, COLLAPSED_IDS, ["default", "brand"]]) {
      expect(themePresetIds(ids).length).toBeGreaterThan(0);
    }
  });

  it("mirrors the installed hikari table exactly", () => {
    const installed = Object.keys(themePresets);
    expect(installed.length).toBeGreaterThan(0);
    expect([...themePresetIds()].sort()).toEqual([...installed].sort());
  });
});
