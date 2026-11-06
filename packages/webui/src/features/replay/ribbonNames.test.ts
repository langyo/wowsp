/** Guards the refreshed ribbon label table against the two failure modes a
 *  version-bump regeneration has actually produced:
 *
 *  - the extractor emitting the catalog's raw key spelling
 *    (RIBBON_MAIN_CALIBER) instead of the frontend's lower-case snake ids
 *    the post-battle panel and the ribbon icon map look up, which silently
 *    drops every localized label to a raw id;
 *  - the current client catalog dropping ribbon ids older replays still
 *    carry (the post-battle aggregates), which would delete their
 *    translations from the merged table.
 */
import { describe, expect, it } from "vitest";

import ribbonNamesRaw from "@/data/ribbon_names.json";

import { RIBBON_SOURCES } from "./postBattle";

const RIBBON_NAMES = ribbonNamesRaw as Record<string, Partial<Record<string, string>> | undefined>;

/** Aggregates the current client's ribbon catalog no longer carries, still
 *  shown by the post-battle panel for replays recorded on older builds. */
const LEGACY_KEYS = [
  "main_caliber_shots",
  "hits",
  "aa_hits",
  "salvos",
  "plane_losses",
  "shells",
] as const;

describe("ribbon label table", () => {
  it("localizes every post-battle ribbon counter", () => {
    for (const [key] of RIBBON_SOURCES) {
      expect(RIBBON_NAMES[key]?.["en-US"], key).toBeTruthy();
    }
  });

  it("keeps the legacy counters older replays reference", () => {
    for (const key of LEGACY_KEYS) {
      expect(RIBBON_NAMES[key]?.["en-US"], key).toBeTruthy();
    }
  });
});
