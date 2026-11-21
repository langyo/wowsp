/** Guards the recorder strip's art contract: EVERY counter the post-battle
 *  parser emits (`RIBBON_SOURCES`) must resolve to a bundled ribbon icon.
 *  A mismatch between the parser's logical keys and the art map's keys is
 *  SILENT by design — `drawRecorderRibbons` keeps a plain count when an icon
 *  is missing — so the clip could ship its 勋带 strip as bare counts
 *  (3 / 20 / 32) without a single failing test. This suite fails loudly
 *  instead: each parser key names the file stem it must paint, that file must
 *  exist in the res tree, and the resolved URL must actually point at it. */
import { describe, expect, it } from "vitest";

import { RIBBON_SOURCES } from "@/features/replay/postBattle";

import { bundledRibbonUrl } from "./ribbonIcons";

/** Every ribbon asset file the build carries (src/res is Vite's publicDir;
 *  the `?url` imports in ribbonIcons emit exactly these files). */
const ART_STEMS = new Set(
  Object.keys(import.meta.glob("../../res/images/ribbons/*.webp")).map((p) => {
    const file = p.slice(p.lastIndexOf("/") + 1);
    return file.slice(0, file.lastIndexOf("."));
  }),
);

/** The file each parser key MUST paint — the explicit key→art contract this
 *  suite pins (a parser key added without an entry here fails the first
 *  test; a typo in the map fails the URL/stem assertions). */
const EXPECTED_STEM: Record<string, string> = {
  frag: "ribbon_frag",
  main_caliber: "ribbon_main_caliber",
  // The shot aggregate has no art of its own — it reuses the main-battery
  // ribbon, exactly like the post-battle panel does.
  main_caliber_shots: "ribbon_main_caliber",
  torpedo: "ribbon_torpedo",
  secondary_caliber: "ribbon_secondary_caliber",
  dbomb: "ribbon_dbomb",
  plane: "ribbon_plane",
};

describe("ribbon art resolution", () => {
  it("declares the art stem for every RIBBON_SOURCES key", () => {
    expect(RIBBON_SOURCES.map(([key]) => key).sort()).toEqual(
      Object.keys(EXPECTED_STEM).sort(),
    );
  });

  it("resolves every RIBBON_SOURCES key to a bundled icon that exists", () => {
    for (const [key] of RIBBON_SOURCES) {
      const stem = EXPECTED_STEM[key];
      const url = bundledRibbonUrl(key);
      expect(url, `${key} has no bundled ribbon art`).toBeTruthy();
      // The URL must name the shipped file (a content hash may follow it;
      // dev/test environments serve the source path itself).
      expect(url, `${key} resolves to ${url}, not ${stem}`).toContain(stem);
      expect(ART_STEMS.has(stem), `${stem}.webp is missing from the res tree`).toBe(true);
    }
  });

  it("keeps the aggregate / sub-ribbon entries the post-battle panel can show", () => {
    for (const key of [
      "hits",
      "salvos",
      "shells",
      "aa_hits",
      "plane_losses",
      "sub_burn",
      "sub_flood",
      "sub_frag",
      "sub_main_caliber",
      "sub_torpedo",
    ]) {
      const url = bundledRibbonUrl(key);
      expect(url, `${key} has no bundled ribbon art`).toBeTruthy();
      const stem = /([a-z0-9_]+)(?:-[A-Za-z0-9_-]+)?\.webp$/.exec(url!) ??
        /([a-z0-9_]+)\.webp$/.exec(url!);
      expect(stem, `${key} -> ${url} names no webp file`).toBeTruthy();
      expect(ART_STEMS.has(stem![1]), `${key} -> ${url} has no file`).toBe(true);
    }
  });

  it("answers null for an unknown kind (the strip's plain-count fallback)", () => {
    expect(bundledRibbonUrl("not_a_ribbon")).toBeNull();
    expect(ART_STEMS.size).toBeGreaterThanOrEqual(RIBBON_SOURCES.length);
  });
});
