/**
 * Regression fence for the #1135 paste-in: the ship picker's acquisition
 * source filter keys (`ships.filter.source*`) landed in every locale file
 * as multi-locale translation TABLES ({"en-US": ..., "zh-CN": ...}) instead
 * of this locale's string — parity stayed green and `t()` rendered the raw
 * dotted path. The guard lives in scripts/check_i18n.py (CI); this test is
 * the runtime side of the same fence: every locale's seven keys must load
 * and resolve through the real i18n instance to a string that is not the
 * key path itself.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { initLocaleMessages, setLocale, t } from "@/i18n";

const KEYS = [
  "ships.filter.sourceTitle",
  "ships.filter.sourceAll",
  "ships.filter.source_tree",
  "ships.filter.source_gold",
  "ships.filter.source_coal",
  "ships.filter.source_steel",
  "ships.filter.source_event",
] as const;

const LOCALES = [
  "en-US",
  "es-ES",
  "fr-FR",
  "ja-JP",
  "ko-KR",
  "ru-RU",
  "zh-CN",
  "zh-TW",
] as const;

describe("ship source filter keys", () => {
  beforeEach(async () => {
    await initLocaleMessages();
  });

  for (const locale of LOCALES) {
    it(`resolves in ${locale}`, async () => {
      await setLocale(locale);
      for (const key of KEYS) {
        // A pasted table resolves to the raw dotted path — that echo is
        // exactly the missing-translation the user sees.
        expect(t(key)).not.toBe(key);
      }
    });
  }
});
