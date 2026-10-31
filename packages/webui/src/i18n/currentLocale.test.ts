import { describe, expect, it } from "vitest";

import { currentLocale, i18n, setLocale } from "./index";

/**
 * `currentLocale()` is the accessor the cleanup introduced in place of two
 * `i18n.global.locale.value as Locale` casts. A post-merge review showed that
 * pinning it to the fallback left the whole suite green, so nothing guarded
 * the narrowing it performs: every in-app write goes through `setLocale`
 * (which only accepts a `Locale`), and the accessor validates what it reads
 * back through `matchLocale`, falling back exactly like detection does.
 */
describe("currentLocale", () => {
  it("returns the locale that was just set", async () => {
    for (const code of ["en-US", "zh-CN", "zh-TW", "ru-RU", "ja-JP"] as const) {
      await setLocale(code);
      expect(currentLocale()).toBe(code);
      expect(i18n.global.locale.value).toBe(code);
    }
  });

  it("falls back when the shared locale holds an unknown tag", async () => {
    await setLocale("en-US");
    // Simulates a stale value written by an older build: `currentLocale` must
    // narrow it rather than hand a `string` to locale-aware consumers.
    i18n.global.locale.value = "xx-Unknown";
    expect(currentLocale()).toBe("en-US");
    await setLocale("en-US");
  });
});
