/** Guards the recorder strip's art contract: EVERY counter the post-battle
 *  parser emits (`RIBBON_SOURCES`) must resolve to a bundled ribbon icon.
 *  A mismatch between the parser's logical keys and the art map's keys is
 *  SILENT by design — `drawRecorderRibbons` keeps a plain count when an icon
 *  is missing — so the clip could ship its 勋带 strip as bare counts
 *  (3 / 20 / 32) without a single failing test. This suite fails loudly
 *  instead: each parser key names the file stem it must paint, that file must
 *  EXIST in the res tree (an fs check — the map is now plain root-path
 *  strings, so no import can fail the build on a rename), and the resolved
 *  URL must actually point at it under the publicDir root. */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { RIBBON_SOURCES } from "@/features/replay/postBattle";

import { bundledRibbonUrl } from "./ribbonIcons";

/** `src/res` is the webui's Vite publicDir, so this directory is served
 *  verbatim at `/images/ribbons`. vitest runs with the package dir as cwd
 *  (`${repo}/packages/webui`); the second candidate keeps a repo-root cwd
 *  working, the same pattern the styles/i18n contract suites use. */
const RIBBONS_DIR = [
  resolve(process.cwd(), "src/res/images/ribbons"),
  resolve(process.cwd(), "packages/webui/src/res/images/ribbons"),
].find((p) => existsSync(p)) ?? "";

/** Every ribbon asset file the shipped res tree carries. */
const ART_STEMS = new Set(
  RIBBONS_DIR
    ? readdirSync(RIBBONS_DIR)
        .filter((file) => file.endsWith(".webp"))
        .map((file) => file.slice(0, -".webp".length))
    : [],
);

/** The file a stem must name, for the existence assertion. */
const artFile = (stem: string): string => resolve(RIBBONS_DIR, `${stem}.webp`);

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

/** The stem a bundled URL names (a publicDir path is unhashed by
 *  construction; the pattern still tolerates a hash if one ever returns). */
function urlStem(url: string): string | null {
  const m =
    /([a-z0-9_]+)(?:-[A-Za-z0-9_-]+)?\.webp$/.exec(url) ??
    /([a-z0-9_]+)\.webp$/.exec(url);
  return m ? m[1] : null;
}

describe("ribbon art resolution", () => {
  it("finds the shipped ribbon tree at all (the fs check is not vacuous)", () => {
    expect(RIBBONS_DIR, "res/images/ribbons is missing").not.toBe("");
    expect(ART_STEMS.size).toBeGreaterThan(0);
  });

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
      // The URL must be the publicDir root path for the shipped file.
      expect(url, `${key} resolves to ${url}, not the publicDir path of ${stem}`)
        .toBe(`/images/ribbons/${stem}.webp`);
      expect(ART_STEMS.has(stem), `${stem}.webp is missing from the res tree`).toBe(true);
      expect(existsSync(artFile(stem)), `${artFile(stem)} does not exist`).toBe(true);
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
      // PublicDir path, no bundler hash: the app serves the file verbatim.
      expect(url).toMatch(/^\/images\/ribbons\/[a-z0-9_]+\.webp$/);
      const stem = urlStem(url!);
      expect(stem, `${key} -> ${url} names no webp file`).toBeTruthy();
      expect(ART_STEMS.has(stem!), `${key} -> ${url} has no file`).toBe(true);
      expect(existsSync(artFile(stem!)), `${artFile(stem!)} does not exist`).toBe(true);
    }
  });

  it("answers null for an unknown kind (the strip's plain-count fallback)", () => {
    expect(bundledRibbonUrl("not_a_ribbon")).toBeNull();
    expect(ART_STEMS.size).toBeGreaterThanOrEqual(RIBBON_SOURCES.length);
  });
});
