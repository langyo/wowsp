/**
 * Contract: busy labels carry NO trailing ellipsis.
 *
 * Every string in this list is rendered only while the UI is WAITING — a
 * spinner, a progress ring, or a loading button's in-flight face is on
 * screen beside it — so trailing dots duplicate the very signal the
 * spinner already gives. The app's shared LoadingNote contract words it
 * directly ("hikari's spinner ring carries the 'in progress' signal and
 * the copy drops the trailing ellipsis entirely"); the 2026-11-16 report
 * ("正在解析录像后面有点点点，点点点不该有") started with one pending body
 * and this list is the audited sweep of the same class across the title
 * bar's loading chips, the spinner status lines and the busy buttons.
 *
 * Deliberately NOT listed: labels ending in "…" because they OPEN a dialog
 * (选择文件…, 浏览文件夹…, 选择图片…) — there the dots are the affordance.
 *
 * A regenerated locale that brings the dots back fails here instead of in
 * a screenshot review.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Repo-root locale tree. vitest runs with packages/webui as its cwd (the
 *  same base the .styles.test.ts suites read their sheets from). */
const LOCALES_DIR = join(process.cwd(), "..", "..", "res", "i18n", "locales");

/** Busy-label i18n keys as "<namespace file>:<dotted path inside it>". */
const BUSY_LABELS: readonly string[] = [
  // Title-bar loading chip (HkPersistentToast tone="loading" renders a spinner).
  "ships:loading",
  "ships:detail.gameparamsLoading",
  "replay:postbattle.loadingGlobal",
  "playtime:rescanLoading",
  "playtime:rebuildLoading",
  "account:searching",
  "dashboard:loading",
  // Spinner / LoadingNote status copy.
  "replay:loading",
  "replay:report.loading",
  "replay:tip.loading",
  "replay:tip.careerLoading",
  "replay:moveAdvice.loading",
  "replay:live.selfSyncing",
  "gateway:connecting",
  "gateway:phaseConnecting",
  "gateway:phaseResolving",
  "gateway:captchaLoading",
  "gateway:captchaExchanging",
  "onboarding:gameDetecting",
  "onboarding:playersScanning",
  "settings:changelogLoading",
  "settings:changelogLoadingMore",
  "settings:changelogTranslating",
  "settings:feedbackLoading",
  "settings:markersImportScanning",
  "sharing:select.planning",
  "lookup:searchingWho",
  "lookup:searching",
  "resources:searching",
  "resources:fileListBuilding",
  "resources:layers.loading",
  "resources:importWizard.probing",
  "resources:migrateAnalyzing",
  "resources:migrateExecuting",
  // Busy action labels (the button's loading face renders a spinner).
  "about:updateVerifying",
  "about:updateRacing",
  "about:updateInstalling",
  "about:checking",
  "about:downloading",
  "common:detect.scanning",
  "crash:actions.restarting",
  "crash:actions.quarantining",
  "crash:actions.exporting",
  "feedback:sending",
  "overlay:chat.loading",
  "replay:report.copying",
  "settings:networkDiagRunning",
  "settings:downloadRacing",
  "settings:downloadVerifying",
  "settings:downloadStreaming",
  "settings:downloadApplying",
  "settings:downloadInstalling",
  "settings:mirrorTesting",
  "settings:chatTranslate.testing",
  "settings:chatTranslate.tryRunning",
  "share:copyShotGenerating",
  "resources:uninstalling",
  "resources:analyzing",
  "resources:installing",
  "resources:junkCleaning",
  "resources:videoLoading",
  "resources:importWizard.stage.preparing",
  "resources:importWizard.stage.transcodeMain",
  "resources:importWizard.stage.transcodeLow",
  "resources:importWizard.stage.copying",
  "resources:importWizard.stage.installing",
  "resources:importWizard.stage.working",
  "tactics:setup.learning",
  "tray:phoneConnecting",
];

const LOCALES = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function resolveKey(table: unknown, path: string): unknown {
  let cur: unknown = table;
  for (const part of path.split(".")) {
    if (typeof cur !== "object" || cur === null || !(part in (cur as Record<string, unknown>))) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const tables = new Map<string, unknown>();
function tableOf(locale: string, ns: string): unknown {
  const cacheKey = locale + "/" + ns;
  if (!tables.has(cacheKey)) {
    tables.set(cacheKey, JSON.parse(readFileSync(join(LOCALES_DIR, locale, ns + ".json"), "utf8")));
  }
  return tables.get(cacheKey);
}

describe("busy labels", () => {
  it("covers every supported UI locale", () => {
    expect(LOCALES.length).toBeGreaterThanOrEqual(8);
  });

  for (const locale of LOCALES) {
    it(`${locale}: no busy label ends with an ellipsis`, () => {
      for (const entry of BUSY_LABELS) {
        const [ns, path] = entry.split(":");
        const value = resolveKey(tableOf(locale, ns), path);
        // Missing keys fail too: a renamed key would silently un-pin the rule.
        expect(typeof value, `${locale} ${ns}.${path}`).toBe("string");
        const label = value as string;
        expect(label.length, `${locale} ${ns}.${path}`).toBeGreaterThan(0);
        expect(label, `${locale} ${ns}.${path}`).not.toMatch(/[\u2026.]$/);
        expect(label, `${locale} ${ns}.${path}`).not.toMatch(/\u2026$/);
      }
    });
  }
});
