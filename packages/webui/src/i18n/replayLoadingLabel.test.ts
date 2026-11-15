/**
 * Contract: the replay parsing label carries NO trailing ellipsis.
 *
 * The label renders beside a live spinner in both of its surfaces — the
 * title bar's loading chip and the results window's pending body — so the
 * "…" is at most decorative dots the spinner already says better
 * (2026-11-16 user report: "正在解析录像后面有点点点，点点点不该有"). Both
 * surfaces share this one value, so a regenerated locale that brings the
 * dots back must fail here instead of in a screenshot review.
 */
import { describe, expect, it } from "vitest";

import enUS from "../../../../res/i18n/locales/en-US/replay.json";
import esES from "../../../../res/i18n/locales/es-ES/replay.json";
import frFR from "../../../../res/i18n/locales/fr-FR/replay.json";
import jaJP from "../../../../res/i18n/locales/ja-JP/replay.json";
import koKR from "../../../../res/i18n/locales/ko-KR/replay.json";
import ruRU from "../../../../res/i18n/locales/ru-RU/replay.json";
import zhCN from "../../../../res/i18n/locales/zh-CN/replay.json";
import zhTW from "../../../../res/i18n/locales/zh-TW/replay.json";

const LOCALES: Record<string, { loading: string }> = {
  "en-US": enUS,
  "es-ES": esES,
  "fr-FR": frFR,
  "ja-JP": jaJP,
  "ko-KR": koKR,
  "ru-RU": ruRU,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

describe("replay.loading label", () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    it(`${locale} ends without ellipsis or dots`, () => {
      expect(table.loading.length).toBeGreaterThan(0);
      expect(table.loading.endsWith("…")).toBe(false);
      expect(table.loading.endsWith("...")).toBe(false);
      expect(table.loading.endsWith("。")).toBe(false);
    });
  }
});
