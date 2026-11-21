/** The export card's PRE-RENDER phases (the 2026-11-22 「一直卡着不导出」
 *  report): the job used to sit at 0% · 0/N through the whole feed assembly
 *  (roster batch, medal compositions, recorder ledger + ribbon art) and the
 *  3D hull drain, because the card only knew render/finalize/save.
 *
 *  These tests pin the phase model itself: the readout for every rung of the
 *  ladder feed → models (3D) → render → finalize → save, the feed→models
 *  decision, that a cancel actually stops a feed await, and that the three
 *  new labels exist in ALL eight locales (key + placeholder parity with the
 *  en-US baseline, mirroring scripts/check_i18n.py). */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  awaitExportStep,
  exportCardReadout,
  exportPhaseAfterFeed,
  type ExportCardPhase,
} from "./HolographicMap";
import { initLocaleMessages, t } from "@/i18n";

/** res/i18n/locales lives at the repo root: vitest runs with the package dir
 *  as cwd (`${repo}/packages/webui`), two levels below the root — the same
 *  base the *.styles.test.ts sheets resolve from. The second candidate keeps
 *  a root-cwd run working. */
const localesDir = [
  resolve(process.cwd(), "../../res/i18n/locales"),
  resolve(process.cwd(), "res/i18n/locales"),
].find((p) => existsSync(p)) ?? "";
const LOCALES = [
  "en-US",
  "zh-CN",
  "zh-TW",
  "ja-JP",
  "ko-KR",
  "ru-RU",
  "fr-FR",
  "es-ES",
] as const;

/** A locale's replay.json IS the `replay` namespace (i18n merges it at that
 *  path), so the card labels sit under its top-level `export` object. */
interface ReplayJson {
  export: Record<string, string>;
}

function exportMessages(locale: string): Record<string, string> {
  const raw = readFileSync(`${localesDir}/${locale}/replay.json`, "utf-8");
  return (JSON.parse(raw) as ReplayJson).export;
}

/** The whole ladder, in the order the job walks it. */
const LADDER: readonly ExportCardPhase[] = [
  "feed",
  "models",
  "render",
  "finalize",
  "save",
];

beforeAll(async () => {
  await initLocaleMessages();
});

describe("exportCardReadout", () => {
  it("labels every pre/post-render stage and reports no percentage", () => {
    const counts = { done: 120, total: 288 };
    // feed → models (3D hulls) → finalize → save: label-only stages.
    expect(exportCardReadout("feed", counts)).toEqual({
      meta: t("replay.export.phaseFeed"),
      progress: null,
    });
    expect(
      exportCardReadout("models", counts, { loaded: 3, total: 12 }),
    ).toEqual({
      meta: t("replay.export.phaseModelsCount", { done: 3, total: 12 }),
      progress: null,
    });
    // No count yet (no scene / no markers): the plain label, still no bar.
    expect(exportCardReadout("models", counts)).toEqual({
      meta: t("replay.export.phaseModels"),
      progress: null,
    });
    expect(exportCardReadout("finalize", counts)).toEqual({
      meta: t("replay.export.phaseFinalize"),
      progress: null,
    });
    expect(exportCardReadout("save", counts)).toEqual({
      meta: t("replay.export.phaseSave"),
      progress: null,
    });
  });

  it("keeps the frame loop the only determinate phase", () => {
    const r = exportCardReadout("render", { done: 120, total: 288 });
    expect(r).toEqual({ meta: "42% · 120/288", progress: 42 });
    // Empty take: 0%, not NaN/Infinity.
    expect(exportCardReadout("render", { done: 0, total: 0 })).toEqual({
      meta: "0% · 0/0",
      progress: 0,
    });
    // Clamped at 100 (a mis-reported count can never overflow the bar).
    expect(exportCardReadout("render", { done: 300, total: 288 }).progress).toBe(100);
  });

  it("walks the whole ladder determinately only at render", () => {
    const determinate = LADDER.filter(
      (phase) =>
        exportCardReadout(phase, { done: 1, total: 2 }, { loaded: 1, total: 2 })
          .progress !== null,
    );
    expect(determinate).toEqual(["render"]);
  });

  it("translates every label (no echoed i18n keys)", () => {
    for (const phase of LADDER) {
      const { meta } = exportCardReadout(phase, { done: 1, total: 2 }, {
        loaded: 1,
        total: 2,
      });
      expect(meta.length).toBeGreaterThan(0);
      expect(meta).not.toContain("replay.export.");
    }
  });
});

describe("exportPhaseAfterFeed", () => {
  it("never waits for the 2D take", () => {
    expect(exportPhaseAfterFeed("2d", { loaded: 0, total: 12, pending: 12 })).toBe(
      "render",
    );
  });

  it("waits for in-flight 3D hulls", () => {
    expect(exportPhaseAfterFeed("3d", { loaded: 3, total: 12, pending: 9 })).toBe(
      "models",
    );
  });

  it("skips the wait when every 3D hull is loaded", () => {
    expect(exportPhaseAfterFeed("3d", { loaded: 12, total: 12, pending: 0 })).toBe(
      "render",
    );
  });

  it("skips the wait with no scene markers at all", () => {
    expect(exportPhaseAfterFeed("3d", { loaded: 0, total: 0, pending: 0 })).toBe(
      "render",
    );
    expect(exportPhaseAfterFeed("3d", null)).toBe("render");
  });

  it("does not wait on hulls whose load already failed", () => {
    // No model pack installed: every marker sits in the map's modelWaiters,
    // nothing is in flight — waiting would stall the take for the whole cap.
    expect(exportPhaseAfterFeed("3d", { loaded: 0, total: 12, pending: 0 })).toBe(
      "render",
    );
    // Partial failure: only the in-flight remainder is worth waiting for.
    expect(exportPhaseAfterFeed("3d", { loaded: 8, total: 12, pending: 1 })).toBe(
      "models",
    );
    expect(exportPhaseAfterFeed("3d", { loaded: 8, total: 12, pending: 0 })).toBe(
      "render",
    );
  });
});

describe("awaitExportStep", () => {
  it("resolves done when the step settles", async () => {
    await expect(awaitExportStep(Promise.resolve(), { cancelled: false }, 1000)).resolves.toBe(
      "done",
    );
  });

  it("treats a rejected step as done (the clip keeps its honest dashes)", async () => {
    const failed = Promise.reject(new Error("lookup down"));
    await expect(awaitExportStep(failed, { cancelled: false }, 1000)).resolves.toBe("done");
  });

  it("stops waiting the moment the cancel token trips", async () => {
    const token = { cancelled: false };
    // A lookup with no cancel channel of its own: it would hang forever.
    const hang = new Promise<void>(() => {});
    const pending = awaitExportStep(hang, token, 60_000, 5);
    setTimeout(() => {
      token.cancelled = true;
    }, 10);
    await expect(pending).resolves.toBe("cancelled");
  });

  it("caps a step that never settles", async () => {
    const hang = new Promise<void>(() => {});
    await expect(awaitExportStep(hang, { cancelled: false }, 20, 5)).resolves.toBe(
      "timeout",
    );
  });
});

describe("export phase labels (all eight locales)", () => {
  const baseline = exportMessages("en-US");
  const KEYS = ["phaseFeed", "phaseModels", "phaseModelsCount"] as const;

  it("has the baseline labels", () => {
    for (const key of KEYS) {
      expect(baseline[key]).toBeTruthy();
    }
  });

  for (const locale of LOCALES) {
    it(`${locale} carries every phase label with the same placeholders`, () => {
      const messages = exportMessages(locale);
      for (const key of KEYS) {
        const text = messages[key];
        expect(text, `${locale} is missing ${key}`).toBeTruthy();
        expect(text.trim().length, `${locale} ${key} is blank`).toBeGreaterThan(0);
        const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(placeholders(text), `${locale} ${key} placeholders`).toEqual(
          placeholders(baseline[key]),
        );
      }
    });
  }

  it("passes the model count through the label", () => {
    const localized = t("replay.export.phaseModelsCount", { done: 7, total: 9 });
    expect(localized).toContain("7");
    expect(localized).toContain("9");
  });
});
