/** Tests for the map-name catalog's locale coverage: every space the map
 *  surfaces can actually draw (a battle space whose world bounds ship with
 *  the bundle — the same lookup the preview requires) must carry a
 *  non-empty display name in each of the nine canonical data languages.
 *  The Lesta-only spaces whose catalogs only name them in Russian are
 *  hand-curated (scripts/model_convert/map_names_curated.json) precisely
 *  so no UI language ever falls back to a raw space id. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import mapNamesRaw from "@/data/map_names.json";
import { isHarborSpace } from "./mapModes";

// minimaps.json is a runtime FETCH target riding publicDir (modelLoader's
// `/models/maps/minimaps.json`), so the test reads it from disk instead of
// importing — a publicDir import logs Vite's "cannot be imported from
// JavaScript" warning through every vitest run. process.cwd() is the
// package root under every vitest invocation (import.meta.url is not a
// file: URL in the happy-dom environment).
const minimapsRaw = JSON.parse(
  readFileSync(resolve(process.cwd(), "src/res/models/maps/minimaps.json"), "utf8"),
) as Record<string, unknown>;

/** The catalog `utils/mapNames` exposes as MAP_NAMES, read directly so this
 *  test stays free of the i18n import that module pulls in. */
const MAP_NAMES = mapNamesRaw as Record<string, Record<string, string>>;

/** World bounds (minimaps.json) — extracted for every space the holo pack
 *  can draw, bundled or downloaded, so it is the static stand-in for
 *  "this map is reachable in the UI". */
const BOUNDS_IDS = new Set(Object.keys(minimapsRaw));

/** Canonical BCP 47 lang-loc codes (extract_ship_names.py's LANG_DIRS —
 *  zh-SG is a data language only, and WG's own zh-tw catalog keeps map
 *  names in English, which the curated Lesta entries replace with real
 *  Traditional Chinese). */
const DATA_LANGS = [
  "zh-CN",
  "zh-SG",
  "zh-TW",
  "en-US",
  "ja-JP",
  "ko-KR",
  "ru-RU",
  "fr-FR",
  "es-ES",
] as const;

/** The surfaces displayMapName serves (tactics rail, replay cards, live
 *  battle) only ever show battle spaces — harbors and the bounds-less
 *  auxiliary scenes (arsenal docks, exteriors) stay out of every UI. */
function uiVisibleSpaces(): string[] {
  return Object.keys(MAP_NAMES).filter(
    (id) => !isHarborSpace(id) && BOUNDS_IDS.has(id),
  );
}

describe("map-name catalog locale coverage", () => {
  it("names every UI-visible space in all nine data languages", () => {
    const visible = uiVisibleSpaces();
    // Sanity: the guard really looks at the fleet — the Lesta event maps
    // ride the same rail as the WG staples, so a ru-RU-only entry fails
    // here instead of rendering as a raw space id in some language.
    expect(visible.length).toBeGreaterThan(50);
    expect(visible).toContain("e17_2026_Lukomorye");
    for (const id of visible) {
      const names = MAP_NAMES[id]!;
      for (const lang of DATA_LANGS) {
        expect(names[lang]?.trim(), `${id} [${lang}]`).toBeTruthy();
      }
    }
  });
});
